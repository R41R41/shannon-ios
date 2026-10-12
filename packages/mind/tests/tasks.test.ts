import { describe, expect, it } from 'vitest';
import {
  EXEC_STATES, SLOT_CLASSES, SLOT_LIMITS_OWNER_2026_10_12, SLOT_LIMITS_TODAY, TASK_KINDS, deriveTask, deriveTaskKind, effectSentOf,
  fcaPhaseOf, legacyProjection, legacyStateOf, projectionMatches, slotClassOf, slotLimitProblems, type TaskFacts,
} from '../src/index.js';

const base: TaskFacts = {
  fcaKind: null, status: 'queued', pauseReason: null, currentAction: null, stepId: null, stopRequested: false, checkpointWaitReason: null,
};
const codex = (status: string, more: Partial<TaskFacts> = {}): TaskFacts => ({ ...base, status, ...more });
const fca = (fcaKind: string, status: string, more: Partial<TaskFacts> = {}): TaskFacts => ({ ...base, fcaKind, status, ...more });

/** Every combination of the old columns written today (Agent Host store and bridge; FCA authority events, recovery, stop). */
const CODEX_COMBINATIONS: ReadonlyArray<[TaskFacts, string]> = [
  [codex('proposed'), 'proposed'],
  [codex('queued'), 'ready'],
  [codex('starting', { currentAction: '作業環境へ接続中' }), 'active'],
  [codex('running'), 'active'],
  [codex('waiting_approval'), 'waiting'],
  [codex('paused', { pauseReason: 'owner' }), 'stopped'],
  [codex('paused', { pauseReason: 'needs_owner', currentAction: '続ける場合は再開してください。' }), 'waiting'],
  [codex('paused'), 'stopped'],
  [codex('paused', { currentAction: '続きが必要' }), 'waiting'],
  [codex('completed'), 'completed'],
  [codex('failed'), 'failed'],
  [codex('cancelled'), 'cancelled'],
];

function fcaCombinations(kind: string): Array<[TaskFacts, string, string]> {
  return [
    [fca(kind, 'queued'), 'ready', 'ready'],
    [fca(kind, 'queued', { checkpointWaitReason: null }), 'ready', 'ready'],
    [fca(kind, 'running', { stepId: 'step-1' }), 'active', 'executing'],
    [fca(kind, 'running', { checkpointWaitReason: 'message' }), 'waiting', 'waiting'],
    [fca(kind, 'running'), 'waiting', 'waiting'],
    [fca(kind, 'running', { stepId: 'step-1', stopRequested: true }), 'stopping', 'stopping'],
    [fca(kind, 'running', { stopRequested: true }), 'stopping', 'stopping'],
    [fca(kind, 'paused', { pauseReason: 'fca_stopped', stopRequested: true }), 'stopped', 'stopped'],
    [fca(kind, 'paused', { pauseReason: 'fca_stopped' }), 'stopped', 'stopped'],
    [fca(kind, 'paused', { pauseReason: 'fca_unknown', stepId: 'step-1' }), 'unknown', 'unknown'],
    [fca(kind, 'paused', { pauseReason: 'fca_unknown' }), 'unknown', 'unknown'],
    [fca(kind, 'completed'), 'completed', 'completed'],
    [fca(kind, 'failed'), 'failed', 'failed'],
    [fca(kind, 'cancelled'), 'cancelled', 'stopped'],
  ];
}

const FCA_KINDS = ['root', 'conversation', 'research', 'generic', 'sleep'];

describe('the task kinds', () => {
  it('are COALESCE(fca_kind, codex) with research and generic as work', () => {
    expect([null, ...FCA_KINDS, 'other'].map(deriveTaskKind)).toEqual(['codex', 'root', 'conversation', 'work', 'work', 'sleep', null]);
    expect(TASK_KINDS).toContain('activity');
  });
});

describe('the state of a task', () => {
  it.each(CODEX_COMBINATIONS)('an Agent Host task: %o is %s', (facts, state) => {
    expect(deriveTask(facts)?.execState).toBe(state);
    expect(deriveTask(facts)?.effectClass).toBe('external');
  });

  it('keeps the reason of a Host wait', () => {
    expect(deriveTask(codex('waiting_approval'))?.waitReason).toBe('approval');
    expect(deriveTask(codex('paused', { pauseReason: 'needs_owner' }))?.waitReason).toBe('owner');
    expect(deriveTask(codex('paused', { pauseReason: 'owner' }))?.waitReason).toBeNull();
  });

  it.each(FCA_KINDS.flatMap(fcaCombinations))('an FCA task: %o is %s, shown as the phase %s', (facts, state, phase) => {
    const derived = deriveTask(facts);
    expect(derived?.execState).toBe(state);
    expect(fcaPhaseOf(derived!.execState)).toBe(phase);
    expect(derived?.effectClass).toBe('none');
  });

  it('keeps an FCA wait reason only while the task waits', () => {
    expect(deriveTask(fca('research', 'running', { checkpointWaitReason: 'message' }))?.waitReason).toBe('message');
    expect(deriveTask(fca('research', 'queued', { checkpointWaitReason: 'message' }))?.waitReason).toBeNull();
  });

  it('has no state for a status or kind the vocabulary does not know', () => {
    expect(deriveTask(codex('lost'))).toBeNull();
    expect(deriveTask(fca('dream', 'queued'))).toBeNull();
  });
});

describe('the legacy projection', () => {
  const all: TaskFacts[] = [...CODEX_COMBINATIONS.map(([facts]) => facts), ...FCA_KINDS.flatMap(fcaCombinations).map(([facts]) => facts)];

  it.each(all)('round-trips %o', facts => {
    const derived = deriveTask(facts)!;
    expect(projectionMatches(derived, facts)).toBe(true);
    const flags = { starting: facts.status === 'starting', waitReason: derived.waitReason };
    expect(legacyProjection(derived.execState, derived.taskKind, flags)).toEqual(legacyStateOf(facts));
  });

  it('notices a state that no longer matches its row', () => {
    const facts = fca('research', 'paused', { pauseReason: 'fca_stopped' });
    expect(projectionMatches({ taskKind: 'work', execState: 'active', waitReason: null }, facts)).toBe(false);
    expect(projectionMatches({ taskKind: 'codex', execState: 'stopped', waitReason: null }, codex('running'))).toBe(false);
  });

  it('has no legacy form for a state the kind never takes', () => {
    expect(legacyProjection('proposed', 'work')).toBeNull();
    expect(legacyProjection('unknown', 'codex')).toBeNull();
    expect(legacyProjection('stopping', 'codex')).toBeNull();
  });

  it('gives every state of every kind at most one legacy form', () => {
    for (const kind of TASK_KINDS) {
      for (const state of EXEC_STATES) {
        const projected = legacyProjection(state, kind);
        if (projected) expect(typeof projected.status).toBe('string');
      }
    }
  });
});

describe('the actions', () => {
  const touch = `touch:${'a'.repeat(64)}`;

  it('get the slot class of their kind, or of their task', () => {
    expect(slotClassOf({ kind: 'respond', sourceId: 'turn-1' }, null)).toBe('respond');
    expect(slotClassOf({ kind: 'ownTime', sourceId: 'cycle' }, null)).toBe('creative');
    expect(slotClassOf({ kind: 'minecraft', sourceId: 'request' }, null)).toBe('minecraft');
    expect(slotClassOf({ kind: 'agentTask', sourceId: touch }, null)).toBe('touch');
    expect(slotClassOf({ kind: 'agentTask', sourceId: 'fca:t:1' }, 'sleep')).toBe('sleep');
    expect(slotClassOf({ kind: 'agentTask', sourceId: 'fca:t:1' }, 'work')).toBe('research');
    expect(slotClassOf({ kind: 'agentTask', sourceId: 'fca:t:1' }, 'root')).toBe('research');
    expect(slotClassOf({ kind: 'agentTask', sourceId: 'task-1' }, 'codex')).toBe('codex');
    expect(slotClassOf({ kind: 'agentTask', sourceId: 'lost' }, null)).toBe('other');
  });

  it('count an effect as sent while sent, and through an unknown release', () => {
    expect(effectSentOf({ sent: true, state: 'running' })).toBe(true);
    expect(effectSentOf({ sent: false, state: 'unknown' })).toBe(true);
    expect(effectSentOf({ sent: false, state: 'completed' })).toBe(false);
  });
});

describe('the slot limits', () => {
  it('today: one foreground slot, two background slots, every class at most two', () => {
    expect(slotLimitProblems(SLOT_LIMITS_TODAY)).toEqual([]);
    expect(SLOT_LIMITS_TODAY.pools).toEqual({ foreground: 1, background: 2 });
    for (const slotClass of SLOT_CLASSES) expect(SLOT_LIMITS_TODAY.classes[slotClass].maxLive).toBeLessThanOrEqual(2);
  });

  it('the owner’s limits for S6 are well formed and not today’s', () => {
    expect(slotLimitProblems(SLOT_LIMITS_OWNER_2026_10_12)).toEqual([]);
    expect(SLOT_LIMITS_OWNER_2026_10_12.pools).toEqual({ foreground: 1, background: 3, touch: 1 });
    expect(SLOT_LIMITS_OWNER_2026_10_12.classes.touch.pool).toBe('touch');
  });

  it('refuse a class above its pool or without one', () => {
    const broken = { pools: { foreground: 1 }, classes: { ...SLOT_LIMITS_TODAY.classes, respond: { pool: 'foreground', maxLive: 2 } } };
    expect(slotLimitProblems(broken)).toContain('class respond: 2');
    expect(slotLimitProblems(broken)).toContain('class touch: no pool');
  });
});
