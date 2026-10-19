import { describe, expect, it } from 'vitest';
import { WORKING_ARBITER_V0, WorkingEventLog, arbitrate, checkedWorkingEvent, cutNote, runningLine, workingEventLines,
  type RunningWork, type WorkingEvent } from '../src/index.js';

const AT = '2026-10-20T10:00:00.000Z';
const NOW = Date.parse(AT);
const event = (seq: number, kind: WorkingEvent['kind'], subject: string, data: Record<string, string | number | boolean | null> = {}): WorkingEvent =>
  ({ seq, at: AT, kind, subject, data });
const iron = (seq: number, distance = 16) => event(seq, 'need.appeared', 'b:16,43,0', { need: 'iron', name: 'iron_ore', distance, canReach: true });
const move: RunningWork = { subject: 'op-move', tool: 'mc.move-to', waiting: false, startedAt: NOW - 60_000, remainingMs: null };
const wait: RunningWork = { subject: 'op-wait', tool: 'mc.wait-time', waiting: true, startedAt: NOW - 5_000, remainingMs: 53_000 };

describe('working events', () => {
  it('checks the shape: closed keys and kinds, scalar data, bounded subject', () => {
    expect(checkedWorkingEvent(iron(1))).toEqual(iron(1));
    expect(Object.isFrozen(checkedWorkingEvent(iron(1)))).toBe(true);
    expect(checkedWorkingEvent({ ...iron(1), extra: 1 })).toBe('extra is not allowed');
    expect(checkedWorkingEvent({ ...iron(1), kind: 'need.maybe' })).toBe('kind is invalid');
    expect(checkedWorkingEvent({ ...iron(1), seq: 0 })).toBe('seq is invalid');
    expect(checkedWorkingEvent({ ...iron(1), subject: 'has space' })).toBe('subject is invalid');
    expect(checkedWorkingEvent({ ...iron(1), data: { nested: { a: 1 } } })).toBe('data.nested must be a scalar');
    expect(checkedWorkingEvent({ ...iron(1), data: { name: 'x'.repeat(121) } })).toBe('data.name is too long');
  });

  it('takes each event once, folds needs and progress, and starts afresh on a new connection', () => {
    const log = new WorkingEventLog();
    expect(log.take('c1', [iron(1), event(2, 'need.appeared', 'e:7', { need: 'food', name: 'pig', distance: 9, canReach: true }), { bad: true }]))
      .toEqual({ through: 2, accepted: 2, rejected: 1 });
    expect(log.take('c1', [iron(1), event(3, 'need.gone', 'b:16,43,0', { need: 'iron', name: 'iron_ore' })])).toEqual({ through: 3, accepted: 1, rejected: 0 });
    expect(log.needs().map(need => need.id)).toEqual(['e:7']);
    log.take('c1', [event(4, 'action.progress', 'op', { skill: 'move-to', measure: 'target', elapsedMs: 20_000, sinceProgressMs: 16_000, distance: 30.4 }),
      event(5, 'action.stalled', 'op', { skill: 'move-to', measure: 'target', elapsedMs: 21_000, sinceProgressMs: 17_000, distance: 30.4 })]);
    expect(log.progress('op')).toMatchObject({ skill: 'move-to', measure: 'target', sinceProgressMs: 17_000, distance: 30.4, stalled: true });
    const cursor = log.cursor();
    log.take('c1', [event(6, 'action.progress', 'op', { skill: 'move-to', measure: 'target', elapsedMs: 23_000, sinceProgressMs: 0, distance: 28 })]);
    expect(log.progress('op')?.stalled).toBe(false);
    expect(log.since(cursor).events.map(e => e.seq)).toEqual([6]);
    expect(log.take('c2', [iron(1)])).toEqual({ through: 1, accepted: 1, rejected: 0 });
    expect(log.needs().map(need => need.id)).toEqual(['b:16,43,0']);
    expect(log.since(cursor).events.map(e => e.seq)).toEqual([6, 1]);
  });
});

describe('working arbiter v0', () => {
  const progress = (sinceProgressMs: number, measure: string | null = 'target') =>
    ({ subject: 'op-move', skill: 'move-to', measure, elapsedMs: 60_000, sinceProgressMs, distance: 30, stalled: sinceProgressMs >= 15_000, at: AT });
  const needs = (distance: number, canReach = true) => [{ id: 'b:1', need: 'iron', name: 'iron_ore', distance, canReach, at: AT, data: {} }];

  it('cuts a command whose measure has not got better for 20 s, and not a wait or one without a measure', () => {
    const base = { now: NOW, needs: [], calm: true, recentCuts: [] };
    expect(arbitrate({ ...base, running: move, progress: progress(19_000) })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, running: move, progress: progress(WORKING_ARBITER_V0.stallCutMs) }))
      .toEqual({ act: 'cut', rule: 'stalled', subject: 'op-move', tool: 'mc.move-to', sinceProgressMs: 20_000, distance: 30 });
    expect(arbitrate({ ...base, running: move, progress: progress(40_000, null) })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, running: move, progress: { ...progress(40_000), subject: 'older' } })).toEqual({ act: 'none' });
  });

  it('cuts a calm wait with time left when a need is in reach', () => {
    const base = { now: NOW, progress: null, recentCuts: [] };
    const cut = arbitrate({ ...base, running: wait, needs: needs(16), calm: true });
    expect(cut).toMatchObject({ act: 'cut', rule: 'need_during_wait', subject: 'op-wait', need: { name: 'iron_ore', distance: 16 } });
    expect(arbitrate({ ...base, running: wait, needs: needs(16), calm: false })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, running: wait, needs: needs(16, false), calm: true })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, running: wait, needs: needs(30), calm: true })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, running: { ...wait, remainingMs: 10_000 }, needs: needs(16), calm: true })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, running: move, needs: needs(5), calm: true })).toEqual({ act: 'none' });
  });

  it('never cuts the same command twice, nor more than twice a minute', () => {
    const base = { now: NOW, running: move, progress: progress(30_000), needs: [], calm: true };
    expect(arbitrate({ ...base, recentCuts: [{ at: NOW - 100_000, subject: 'op-move' }] })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, recentCuts: [{ at: NOW - 10_000, subject: 'a' }, { at: NOW - 20_000, subject: 'b' }] })).toEqual({ act: 'none' });
    expect(arbitrate({ ...base, recentCuts: [{ at: NOW - 70_000, subject: 'a' }, { at: NOW - 20_000, subject: 'b' }] }).act).toBe('cut');
  });

  it('says a cut and the events in fixed words, and the running command with its progress', () => {
    expect(cutNote({ act: 'cut', rule: 'stalled', subject: 'op', tool: 'mc.move-to', sinceProgressMs: 20_400, distance: 30.4 }))
      .toBe('mc.move-to を切った: 20秒進んでいない（残り30m）。同じ手をそのまま繰り返さず、道か目標を変える');
    expect(cutNote({ act: 'cut', rule: 'need_during_wait', subject: 'op', tool: 'mc.wait-time', need: needs(16)[0] }))
      .toBe('mc.wait-time の待ちを切った: iron_ore（iron）が16mにある。取ってから、待っていた作業に戻る');
    const events = [iron(1), event(2, 'action.progress', 'op', { skill: 'move-to' }),
      event(3, 'action.stalled', 'op', { skill: 'move-to', sinceProgressMs: 15_200, distance: 12.3 }),
      event(4, 'need.gone', 'e:7', { need: 'food', name: 'pig' }), event(5, 'need.appeared', 'b:2', { need: 'wood', name: 'oak_log', distance: 30, canReach: false })];
    expect(workingEventLines(events)).toEqual(['見えた: iron_ore（iron）16m', '進んでいない: move-to 15秒・残り12m', '見えなくなった: pig（food）', '見えた: oak_log（wood）30m・届かない']);
    expect(workingEventLines(events, 2)).toEqual(['進んでいない: move-to 15秒・残り12m', '見えた: oak_log（wood）30m・届かない']);
    // The nearest logs change as she walks: only the latest of a kind is said, and a stall is never pushed out by them.
    const walk = [event(1, 'action.stalled', 'op', { skill: 'move-to', sinceProgressMs: 15_000 }),
      ...Array.from({ length: 8 }, (_, i) => event(i + 2, i % 2 ? 'need.gone' : 'need.appeared', `wood:b:${i}`, { need: 'wood', name: 'oak_log', distance: 10 + i, canReach: true }))];
    expect(workingEventLines(walk)).toEqual(['進んでいない: move-to 15秒', '見えなくなった: oak_log（wood）']);
    expect(runningLine(move, progress(20_000), NOW)).toBe('今の道具: mc.move-to・経過60秒・最後に進んだのは20秒前・残り30m');
    expect(runningLine(wait, null, NOW)).toBe('今の道具: mc.wait-time・経過5秒');
    expect(runningLine(null, null, NOW)).toBeNull();
  });
});
