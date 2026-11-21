import { describe, expect, it } from 'vitest';
import {
  addToQueue, cancelInQueue, claimFromQueue, deleteFromQueue, EMPTY_QUEUE, holdInQueue, linkQueueTask, locateQueueEntry, moveInQueue,
  queuePromptLines, queueView, resumeInQueue, startQueue, stopQueue, syncQueue, unclaimInQueue, type QueueChange, type QueueSnapshot,
} from '../src/surfaces/minecraft/minecraftRequestQueue.js';
import { MINECRAFT_QUEUE_LIMITS } from '../src/contracts/minecraftQueueContract.js';

type Placement = 'end' | 'next' | 'now';
type Good = Extract<QueueChange, { ok: true }>;
let clock = 0;
const at = () => `2026-11-21T00:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock++ % 60).padStart(2, '0')}.000Z`;
const ok = (change: QueueChange): QueueSnapshot => {
  expect(change.ok).toBe(true);
  return (change as Good).snapshot;
};
const add = (snapshot: QueueSnapshot, goal: string, placement: Placement = 'end', requestId?: string) =>
  ok(addToQueue(snapshot, { id: `id-${goal}`, goal, placement, origin: 'mod', requestId }, at()));
const states = (snapshot: QueueSnapshot) => queueView(snapshot, 1).entries.map(entry => `${entry.goal}:${entry.state}`);
/** The entry started: what the pump does after a claim. */
const started = (snapshot: QueueSnapshot) => {
  const claim = claimFromQueue(snapshot, at());
  expect(claim?.ok).toBe(true);
  const good = claim as Good;
  return ok(linkQueueTask(good.snapshot, good.entry!.id, `task-${good.entry!.goal}`, at()));
};
const deleteOf = (s: QueueSnapshot, goal: string) => ok(deleteFromQueue(s, `id-${goal}`, at()));

describe('adding to the list', () => {
  it('puts a request at the end, after the one running, or before it (pausing it), and numbers them without reuse', () => {
    let s = started(add(add(add(EMPTY_QUEUE, 'a'), 'b'), 'c'));
    expect(states(s)).toEqual(['a:running', 'b:queued', 'c:queued']);
    s = add(s, 'next one', 'next');
    expect(states(s)).toEqual(['a:running', 'next one:queued', 'b:queued', 'c:queued']);
    const now = addToQueue(s, { id: 'id-urgent', goal: 'urgent', placement: 'now', origin: 'chat' }, at());
    expect((now as Good).stops).toEqual([{ entryId: 'id-a', taskId: 'task-a', reason: 'queue_now' }]);
    s = ok(now);
    expect(states(s)).toEqual(['urgent:queued', 'a:paused', 'next one:queued', 'b:queued', 'c:queued']);
    expect(queueView(s, 1).entries.map(entry => entry.seq)).toEqual([5, 1, 4, 2, 3]);
    const without = deleteOf(s, 'urgent');
    expect(without.entries.map(entry => entry.seq)).not.toContain(5);
    expect(add(without, 'later').entries.find(entry => entry.goal === 'later')!.seq).toBe(6);
  });

  it('knows a request id it has seen, refuses an empty goal, and is full at the limit of waiting ones', () => {
    const s = add(EMPTY_QUEUE, 'a', 'end', 'mc:1');
    const again = addToQueue(s, { id: 'other', goal: 'a changed', placement: 'end', origin: 'chat', requestId: 'mc:1' }, at());
    expect(again).toMatchObject({ ok: true, duplicate: true, entry: { id: 'id-a' } });
    expect(addToQueue(s, { id: 'x', goal: ' \n ', placement: 'end', origin: 'mod' }, at())).toEqual({ ok: false, code: 'invalid' });
    let full = EMPTY_QUEUE;
    for (let i = 0; i < MINECRAFT_QUEUE_LIMITS.waiting; i += 1) full = add(full, `g${i}`);
    expect(addToQueue(full, { id: 'x', goal: 'one more', placement: 'end', origin: 'mod' }, at())).toEqual({ ok: false, code: 'queue_full' });
    // The one running does not count: a request may be added while it runs.
    expect(addToQueue(started(add(EMPTY_QUEUE, 'run')), { id: 'y', goal: 'ok', placement: 'end', origin: 'mod' }, at()).ok).toBe(true);
  });

  it('cuts a goal to the limit and clears control characters', () => {
    const s = add(EMPTY_QUEUE, `a\u0000b${'x'.repeat(200)}`);
    expect(s.entries[0]!.goal).toHaveLength(MINECRAFT_QUEUE_LIMITS.goalCharacters);
    expect(s.entries[0]!.goal.startsWith('a b')).toBe(true);
  });
});

describe('holding, resuming and reordering (one body)', () => {
  it('moves one before another, never the running one and never in front of it; holds the running one and lets the list go on', () => {
    let s = started(add(add(add(EMPTY_QUEUE, 'a'), 'b'), 'c'));
    expect(moveInQueue(s, 'id-a', null, at())).toEqual({ ok: false, code: 'running' });
    s = ok(moveInQueue(s, 'id-c', 'id-b', at()));
    expect(states(s)).toEqual(['a:running', 'c:queued', 'b:queued']);
    // Before the one running means straight after it.
    s = ok(moveInQueue(s, 'id-b', 'id-a', at()));
    expect(states(s)).toEqual(['a:running', 'b:queued', 'c:queued']);
    s = ok(moveInQueue(s, '#2', null, at()));
    expect(states(s)).toEqual(['a:running', 'c:queued', 'b:queued']);
    expect(moveInQueue(s, 'id-b', 'id-b', at())).toEqual({ ok: false, code: 'invalid' });
    expect(moveInQueue(s, 'nope', null, at())).toEqual({ ok: false, code: 'not_found' });
    const held = holdInQueue(s, null, at());
    expect((held as Good).stops).toEqual([{ entryId: 'id-a', taskId: 'task-a', reason: 'queue_hold' }]);
    s = ok(held);
    expect(states(s)).toEqual(['a:paused', 'c:queued', 'b:queued']);
    s = started(s);
    expect(states(s)).toEqual(['c:running', 'a:paused', 'b:queued']);
    s = ok(resumeInQueue(s, '#1', at()));
    expect(states(s)).toEqual(['c:running', 'a:queued', 'b:queued']);
    // The resumed one keeps its task: the pump resumes it and makes no new one.
    expect(s.entries.find(entry => entry.id === 'id-a')!.taskId).toBe('task-a');
  });
});

describe('start, stop, cancel and delete', () => {
  it('starts one entry first (pausing the one running), stops the whole list, restarts it, deletes and cancels', () => {
    let s = started(add(add(add(add(EMPTY_QUEUE, 'a'), 'b'), 'c'), 'd'));
    const start = startQueue(s, 'id-d', at());
    expect((start as Good).stops.map(stop => stop.taskId)).toEqual(['task-a']);
    s = ok(start);
    expect(states(s)).toEqual(['d:queued', 'a:paused', 'b:queued', 'c:queued']);
    s = started(s);
    const stopped = stopQueue(s, at());
    expect((stopped as Good).stops).toEqual([{ entryId: 'id-d', taskId: 'task-d', reason: 'queue_stop' }]);
    s = ok(stopped);
    expect(states(s)).toEqual(['d:stopped', 'a:paused', 'b:queued', 'c:queued']);
    expect(s.autoRun).toBe(false);
    // Nothing new is started while the list is stopped, however long it is.
    expect(claimFromQueue(s, at())).toBeNull();
    s = ok(startQueue(s, null, at()));
    expect(s.autoRun).toBe(true);
    expect(states(s)).toEqual(['d:queued', 'a:paused', 'b:queued', 'c:queued']);
    s = deleteOf(s, 'c');
    s = started(s);
    expect(deleteFromQueue(s, 'id-d', at())).toEqual({ ok: false, code: 'running' });
    const cancelled = cancelInQueue(s, null, at());
    expect((cancelled as Good).stops.map(stop => stop.taskId)).toEqual(['task-d']);
    s = ok(cancelled);
    expect(states(s)).toEqual(['a:paused', 'b:queued']);
    expect(queueView(s, 3).recent.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['d:cancelled']);
    // Cancelling does not stop the list: the next one is started.
    expect(s.autoRun).toBe(true);
    expect(cancelInQueue(s, 'id-d', at())).toEqual({ ok: false, code: 'bad_state' });
    s = ok(resumeInQueue(s, null, at()));
    expect(states(s)).toEqual(['a:queued', 'b:queued']);
  });

  it('keeps only the newest ended entries, and a start that gave up has its note', () => {
    let s: QueueSnapshot = EMPTY_QUEUE;
    for (let i = 0; i < MINECRAFT_QUEUE_LIMITS.ended + 5; i += 1) {
      s = started(add(s, `g${i}`));
      s = ok(cancelInQueue(s, null, at()));
    }
    expect(s.entries.filter(entry => entry.state === 'cancelled')).toHaveLength(MINECRAFT_QUEUE_LIMITS.ended);
    expect(s.entries.every(entry => entry.pos === -1)).toBe(true);
    expect(queueView(s, 1).recent).toHaveLength(MINECRAFT_QUEUE_LIMITS.shown);
    const claim = claimFromQueue(add(EMPTY_QUEUE, 'x'), at()) as Good;
    const failed = ok(unclaimInQueue(claim.snapshot, 'id-x', 'no_task', true, at()));
    expect(failed.entries[0]).toMatchObject({ state: 'failed', note: 'no_task' });
  });
});

describe('the list says what the tasks are', () => {
  const facts = (phases: Record<string, string | null>, extra: { unowned?: Array<{ taskId: string; goal: string }>; starting?: string[] } = {}) => ({
    phases: new Map(Object.entries(phases)), starting: new Set(extra.starting ?? []), newId: () => 'adopted',
    unowned: (extra.unowned ?? []).map(task => ({ ...task, origin: 'operator' as const })),
  });
  it('ends an entry whose task completed or failed, and stops the list when a running task was stopped from outside', () => {
    const s = add(started(add(EMPTY_QUEUE, 'a')), 'b');
    expect(syncQueue(s, facts({ 'task-a': 'executing' }), at())).toBeNull();
    const done = ok(syncQueue(s, facts({ 'task-a': 'completed' }), at())!);
    expect(states(done)).toEqual(['b:queued']);
    expect(queueView(done, 1).recent[0]).toMatchObject({ goal: 'a', state: 'done' });
    expect(queueView(ok(syncQueue(s, facts({ 'task-a': 'failed' }), at())!), 1).recent[0]).toMatchObject({ state: 'failed', note: 'task_failed' });
    const outside = ok(syncQueue(s, facts({ 'task-a': 'stopped' }), at())!);
    expect(states(outside)).toEqual(['a:stopped', 'b:queued']);
    expect(outside.autoRun).toBe(false);
    expect(queueView(ok(syncQueue(s, facts({ 'task-a': null }), at())!), 1).recent[0]).toMatchObject({ state: 'failed', note: 'task_missing' });
  });

  it('adopts a task nobody listed as the running entry, and takes back a start that no process is making', () => {
    const adopted = ok(syncQueue(add(EMPTY_QUEUE, 'a'), facts({}, { unowned: [{ taskId: 'op-1', goal: 'エンドラを倒して' }] }), at())!);
    expect(states(adopted)).toEqual(['エンドラを倒して:running', 'a:queued']);
    expect(adopted.entries.find(entry => entry.taskId === 'op-1')).toMatchObject({ origin: 'operator', seq: 2, requestId: null });
    const claim = claimFromQueue(add(EMPTY_QUEUE, 'a'), at()) as Good;
    expect(syncQueue(claim.snapshot, facts({}, { starting: [claim.entry!.id] }), at())).toBeNull();
    expect(states(ok(syncQueue(claim.snapshot, facts({}), at())!))).toEqual(['a:queued']);
  });
});

describe('naming an entry and telling her the list', () => {
  it('finds an entry by id, by 「#3」 or by 「3」', () => {
    const s = add(add(EMPTY_QUEUE, 'a'), 'b');
    expect(locateQueueEntry(s, 'id-b')?.seq).toBe(2);
    expect(locateQueueEntry(s, '#1')?.id).toBe('id-a');
    expect(locateQueueEntry(s, '２')?.id).toBe('id-b');
    expect(locateQueueEntry(s, '＃2')?.id).toBe('id-b');
    expect(locateQueueEntry(s, '9')).toBeNull();
    expect(locateQueueEntry(s, 'abc')).toBeNull();
  });

  it('writes at most eight lines, the running one first, says when the list is stopped, and nothing when empty', () => {
    expect(queuePromptLines(EMPTY_QUEUE)).toEqual([]);
    let s = add(started(add(EMPTY_QUEUE, 'a')), 'b');
    expect(queuePromptLines(s)).toEqual(['#1 実行中 「a」', '#2 待ち 「b」']);
    s = ok(stopQueue(s, at()));
    expect(queuePromptLines(s).at(-1)).toContain('止めてある');
    let many: QueueSnapshot = EMPTY_QUEUE;
    for (let i = 0; i < 15; i += 1) many = add(many, `g${i}`);
    const lines = queuePromptLines(many);
    expect(lines).toHaveLength(MINECRAFT_QUEUE_LIMITS.promptLines);
    expect(lines.at(-1)).toBe('ほか 8 件');
  });
});
