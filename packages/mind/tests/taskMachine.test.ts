import { describe, expect, it } from 'vitest';
import {
  EXEC_STATES, SLOT_LIMITS_OWNER_2026_10_12, SLOT_LIMITS_TODAY, TASK_KINDS, UNKNOWN_EXIT_MS, actionEffectClass, legacyProjection, slotAdmissible,
  slotLimitsOf, taskTransition, transitionRefusalKey, unknownDue, unknownExit, type ExecState, type SlotClass, type TaskKind,
} from '../src/index.js';

const FINISHED: readonly ExecState[] = ['completed', 'failed', 'cancelled'];

/** The rule written out independently of the table: what may follow what, for each kind. */
function expectedAllowed(from: ExecState | null, to: ExecState, kind: TaskKind): boolean {
  if (from === null || from === to) return true;
  if (FINISHED.includes(from)) return false;
  if (to === 'proposed') return false;
  if (from === 'proposed') return to !== 'unknown';
  if (from === 'unknown') return FINISHED.includes(to) || ((kind === 'root' || kind === 'conversation') && to !== 'active');
  return true;
}

describe('the task state machine (ADR-0009 stage 1, S4)', () => {
  it('allows and refuses every (state, event) pair by its rule, and projects what it allows', () => {
    let allowed = 0;
    let refused = 0;
    for (const kind of TASK_KINDS) for (const from of [null, ...EXEC_STATES]) for (const to of EXEC_STATES) {
      const result = taskTransition(from, kind, { to, waitReason: to === 'waiting' ? 'message' : null });
      const projection = legacyProjection(to, kind, { waitReason: to === 'waiting' ? 'message' : null });
      if (!expectedAllowed(from, to, kind)) {
        expect(result).toEqual({ ok: false, reason: 'illegal', from, to });
        refused += 1;
      } else if (!projection) {
        expect(result).toMatchObject({ ok: false, reason: 'no_projection' });
      } else {
        expect(result).toMatchObject({ ok: true, state: to, legacy: projection });
        allowed += 1;
      }
    }
    expect(allowed).toBeGreaterThan(300);
    expect(refused).toBeGreaterThan(200);
  });

  it('never lets an unknown task become active again, and lets only the inboxes go back to waiting', () => {
    for (const kind of TASK_KINDS) expect(taskTransition('unknown', kind, { to: 'active' }).ok).toBe(false);
    expect(taskTransition('unknown', 'root', { to: 'waiting', waitReason: 'message' })).toMatchObject({ ok: true, legacy: { status: 'running' } });
    expect(taskTransition('unknown', 'conversation', { to: 'ready' })).toMatchObject({ ok: true, legacy: { status: 'queued' } });
    expect(taskTransition('unknown', 'work', { to: 'waiting' }).ok).toBe(false);
    expect(taskTransition('unknown', 'work', { to: 'failed' })).toMatchObject({ ok: true, legacy: { status: 'failed', pauseReason: null } });
    // A proof that the lost attempt sent nothing lets any kind run again, but never straight into an active step.
    expect(taskTransition('unknown', 'work', { to: 'ready', proof: true })).toMatchObject({ ok: true, legacy: { status: 'queued' } });
    expect(taskTransition('unknown', 'sleep', { to: 'stopped', proof: true })).toMatchObject({ ok: true });
    expect(taskTransition('unknown', 'work', { to: 'active', proof: true }).ok).toBe(false);
  });

  it('reopens a failed task as stopped only when the writer says so (A-20); nothing else is reopened', () => {
    expect(taskTransition('failed', 'work', { to: 'stopped', reopen: true })).toMatchObject({ ok: true, legacy: { status: 'paused' } });
    expect(taskTransition('failed', 'work', { to: 'stopped' }).ok).toBe(false);
    expect(taskTransition('failed', 'work', { to: 'ready', reopen: true }).ok).toBe(false);
    expect(taskTransition('failed', 'work', { to: 'completed', reopen: true }).ok).toBe(false);
    expect(taskTransition('completed', 'work', { to: 'stopped', reopen: true }).ok).toBe(false);
    expect(taskTransition('cancelled', 'work', { to: 'stopped', reopen: true }).ok).toBe(false);
  });

  it('lets a late report reopen only a task closed with its outcome unknown, to completed or paused', () => {
    expect(taskTransition('failed', 'codex', { to: 'completed', lateReport: true })).toMatchObject({ ok: true, legacy: { status: 'completed' } });
    expect(taskTransition('failed', 'codex', { to: 'stopped', lateReport: true })).toMatchObject({ ok: true, legacy: { status: 'paused', pauseReason: 'owner' } });
    expect(taskTransition('failed', 'codex', { to: 'waiting', lateReport: true })).toMatchObject({ ok: true, legacy: { status: 'paused', pauseReason: 'needs_owner' } });
    expect(taskTransition('failed', 'codex', { to: 'active', lateReport: true }).ok).toBe(false);
    expect(taskTransition('failed', 'codex', { to: 'completed' }).ok).toBe(false);
    expect(taskTransition('completed', 'codex', { to: 'stopped', lateReport: true }).ok).toBe(false);
  });

  it('keeps a Codex task out of the states it never takes and carries the Host starting flag', () => {
    expect(taskTransition('active', 'codex', { to: 'unknown' })).toMatchObject({ ok: false, reason: 'no_projection' });
    expect(taskTransition('ready', 'codex', { to: 'active', starting: true })).toMatchObject({ ok: true, starting: true, legacy: { status: 'starting' } });
    expect(taskTransition('active', 'codex', { to: 'active' })).toMatchObject({ ok: true, starting: false, legacy: { status: 'running' } });
    expect(taskTransition('active', 'work', { to: 'active', starting: true })).toMatchObject({ ok: true, starting: false });
    expect(taskTransition('active', 'codex', { to: 'waiting', waitReason: 'approval' })).toMatchObject({ legacy: { status: 'waiting_approval' } });
    expect(taskTransition(null, 'root', { to: 'proposed' })).toMatchObject({ ok: false, reason: 'no_projection' });
  });

  it('names a refusal by its reason, kind and move', () => {
    const refusal = taskTransition('completed', 'work', { to: 'ready' });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(transitionRefusalKey('work', refusal)).toBe('illegal:work:completed>ready');
  });
});

describe('the one unknown exit (S5)', () => {
  it('is due after the exit time, on parsed instants, never for an unreadable time', () => {
    const since = '2026-10-13T00:00:00.000Z';
    const due = new Date(Date.parse(since) + UNKNOWN_EXIT_MS).toISOString();
    expect(unknownDue(since, due)).toBe(true);
    expect(unknownDue(since, new Date(Date.parse(due) - 1).toISOString())).toBe(false);
    expect(unknownDue('2026-10-13T09:00:00+09:00', due)).toBe(true);
    expect(unknownDue('2026-10-13T00:00:00Z', due)).toBe(true);
    expect(unknownDue(null, due)).toBe(false);
    expect(unknownDue('not a time', due)).toBe(false);
  });

  it('retires model-only work and closes work that acts outside', () => {
    expect(unknownExit('none', 'root')).toEqual({ code: 'unknown_retired', task: 'resume' });
    expect(unknownExit('none', 'conversation')).toEqual({ code: 'unknown_retired', task: 'resume' });
    expect(unknownExit('none', 'work')).toEqual({ code: 'unknown_retired', task: 'failed' });
    expect(unknownExit('none', 'sleep')).toEqual({ code: 'unknown_retired', task: 'failed' });
    expect(unknownExit('external', 'codex')).toEqual({ code: 'outcome_unknown_closed', task: 'failed' });
    expect(unknownExit('external', null)).toEqual({ code: 'outcome_unknown_closed', task: 'failed' });
    expect(TASK_KINDS.map(kind => actionEffectClass(kind))).toEqual(['none', 'none', 'none', 'none', 'external', 'none']);
    expect(actionEffectClass(null)).toBe('external');
  });
});

describe('slot admission (S6)', () => {
  const owner = SLOT_LIMITS_OWNER_2026_10_12;
  const admit = (slotClass: SlotClass, live: SlotClass[]) => slotAdmissible(slotClass, live, owner);

  it('holds the owner limits: three background slots, per-class limits, touch and foreground apart', () => {
    expect(admit('research', ['research'])).toEqual({ ok: true });
    expect(admit('research', ['research', 'research'])).toEqual({ ok: false, reason: 'class_research' });
    expect(admit('creative', ['creative'])).toEqual({ ok: false, reason: 'class_creative' });
    expect(admit('sleep', ['research', 'codex'])).toEqual({ ok: true });
    expect(admit('sleep', ['research', 'codex', 'creative'])).toEqual({ ok: false, reason: 'pool_background' });
    expect(admit('touch', ['research', 'codex', 'creative'])).toEqual({ ok: true });
    expect(admit('touch', ['touch'])).toEqual({ ok: false, reason: 'pool_touch' });
    expect(admit('respond', ['research', 'codex', 'creative', 'touch'])).toEqual({ ok: true });
    expect(admit('respond', ['respond'])).toEqual({ ok: false, reason: 'pool_foreground' });
    expect(admit('minecraft', ['minecraft'])).toEqual({ ok: false, reason: 'class_minecraft' });
    expect(slotAdmissible('research', ['research', 'codex'], SLOT_LIMITS_TODAY)).toEqual({ ok: false, reason: 'pool_background' });
  });

  it('reads the tables back as limits, and refuses incomplete rows', () => {
    const pools = Object.entries(owner.pools).map(([pool, max]) => ({ pool, max_live: max }));
    const classes = Object.entries(owner.classes).map(([slotClass, limit]) => ({ slot_class: slotClass, pool: limit.pool, max_live: limit.maxLive }));
    expect(slotLimitsOf(pools, classes)).toEqual(owner);
    expect(slotLimitsOf(pools, classes.slice(1))).toBeNull();
    expect(slotLimitsOf(pools.filter(row => row.pool !== 'touch'), classes)).toBeNull();
  });
});
