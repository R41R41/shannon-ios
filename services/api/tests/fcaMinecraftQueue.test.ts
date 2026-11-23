import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fcaMinecraftQueue, type QueueParts } from '../src/wiring/fcaMinecraftQueue.js';
import { applyQueueIntent } from '../src/wiring/fcaMinecraftQueueIntent.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import type { MinecraftIntent } from '../src/surfaces/minecraft/minecraftIntent.js';
import { applySchemaSteps } from '../src/infra/sqlite/migrations/schemaSteps.js';
import { MINECRAFT_REQUEST_QUEUE_STEP } from '../src/infra/sqlite/migrations/execution/014_minecraft_request_queue.js';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** A task runtime and a body as the queue sees them: tasks with a phase, a stop that is acknowledged only when the test says so. */
function world(options: { db?: DatabaseSync; slowStop?: boolean } = {}) {
  const db = options.db ?? new DatabaseSync(':memory:');
  if (!options.db) databases.push(db);
  const tasks = new Map<string, { phase: string; goal: string; origin: 'chat' | 'operator' | null }>();
  const clock = { at: Date.parse('2026-11-21T00:00:00.000Z') };
  const log: string[] = [];
  const calls: string[] = [];
  let ready = true;
  let counter = 0;
  const parts: QueueParts = {
    db, scopeKey: 'owner', atomic: work => underWriteLock(db, null, '', work, 'queue_test'),
    phase: id => tasks.get(id)?.phase ?? null,
    open: () => [...tasks].filter(([, task]) => !['stopped', 'completed', 'failed'].includes(task.phase))
      .map(([taskId, task]) => ({ taskId, goal: task.goal, phase: task.phase, origin: task.origin })),
    bodyReady: () => ready,
    stop: async (id, reason) => {
      calls.push(`stop ${id} ${reason}`);
      tasks.get(id)!.phase = options.slowStop ? 'stopping' : 'stopped';
    },
    resume: id => {
      calls.push(`resume ${id}`);
      const task = tasks.get(id);
      if (!task || task.phase !== 'stopped') return false;
      task.phase = 'executing';
      return true;
    },
    start: async entry => {
      counter += 1;
      const id = `task-${counter}`;
      calls.push(`start ${id} ${entry.goal}`);
      tasks.set(id, { phase: 'executing', goal: entry.goal, origin: 'chat' });
      return id;
    },
    now: () => new Date(clock.at).toISOString(),
    log: line => log.push(line),
  };
  const queue = fcaMinecraftQueue(parts);
  const running = () => queue.snapshot().entries.filter(entry => entry.state === 'running').map(entry => entry.goal);
  const states = () => queue.view().entries.map(entry => `${entry.goal}:${entry.state}`);
  const finish = (goal: string) => {
    const entry = queue.snapshot().entries.find(item => item.goal === goal)!;
    tasks.get(entry.taskId!)!.phase = 'completed';
  };
  const ack = () => { for (const task of tasks.values()) if (task.phase === 'stopping') task.phase = 'stopped'; };
  const executing = () => [...tasks.values()].filter(task => task.phase === 'executing').map(task => task.goal);
  const add = (goal: string, placement?: 'end' | 'next' | 'now') => queue.operate({ op: 'add', goal, ...(placement ? { placement } : {}) }, { origin: 'mod' });
  return { clock, db, tasks, parts, queue, log, calls, running, states, finish, ack, executing, add, ready: (value: boolean) => { ready = value; } };
}

describe('the list starts one request at a time', () => {
  it('starts the first request at once, the next only when the body is free, and ends an entry whose task completed', async () => {
    const w = world();
    expect(await w.add('a')).toMatchObject({ ok: true, entry: { state: 'running', taskId: 'task-1' } });
    await w.add('b');
    expect(w.states()).toEqual(['a:running', 'b:queued']);
    expect(w.executing()).toEqual(['a']);
    w.finish('a');
    await w.queue.pump();
    expect(w.states()).toEqual(['b:running']);
    expect(w.queue.view().recent.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['a:done']);
    expect(w.executing()).toEqual(['b']);
    expect(w.log).toContain('Shannon Minecraft queue op=add entry=#1 state=-→queued origin=mod code=ok placement=end');
    expect(w.log.some(line => line.includes('goal') || line.includes('「'))).toBe(false);
  });

  it('keeps a request waiting while there is no body frame, and says so; it starts when the body is there', async () => {
    const w = world();
    w.ready(false);
    expect(await w.add('a')).toMatchObject({ ok: true, waiting: 'body', entry: { state: 'queued' } });
    expect(w.calls).toEqual([]);
    w.ready(true);
    await w.queue.pump();
    expect(w.states()).toEqual(['a:running']);
  });

  it('does not start while a task that holds the body is stopping, and starts after its stop is acknowledged', async () => {
    const w = world({ slowStop: true });
    await w.add('a');
    await w.add('b');
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    expect(w.states()).toEqual(['a:paused', 'b:queued']);
    expect(w.executing()).toEqual([]);
    await w.queue.pump();
    expect(w.states()).toEqual(['a:paused', 'b:queued']);
    w.ack();
    await w.queue.pump();
    expect(w.states()).toEqual(['b:running', 'a:paused']);
  });

  it('retries a start that failed, and ends the entry as failed at the third time', async () => {
    const w = world();
    w.parts.start = async () => null;
    await w.add('a');
    await w.queue.pump();
    await w.queue.pump();
    expect(w.queue.view().recent[0]).toMatchObject({ goal: 'a', state: 'failed', note: 'no_task' });
    expect(w.states()).toEqual([]);
  });

  it('stops the task of an entry that was let go while its task was being made', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const made = w.parts.start;
    w.parts.start = async entry => { await gate; return made(entry); };
    const adding = w.add('a');
    for (let i = 0; i < 50 && !w.running().length; i += 1) await Promise.resolve();
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    release();
    await adding;
    await w.queue.pump();
    expect(w.states()).toEqual(['a:paused']);
    expect(w.calls).toContain('stop task-1 queue_released_while_starting');
    expect(w.executing()).toEqual([]);
  });
});

describe('the scene of holding, reordering and resuming', () => {
  it('runs c, then b, and takes a up again; never two running, and the hold stops the body', async () => {
    const w = world();
    for (const goal of ['a', 'b', 'c']) await w.add(goal);
    expect(w.states()).toEqual(['a:running', 'b:queued', 'c:queued']);
    await w.queue.operate({ op: 'move', id: '#3', before: '#2' }, { origin: 'mod' });
    expect(w.states()).toEqual(['a:running', 'c:queued', 'b:queued']);
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    expect(w.states()).toEqual(['c:running', 'a:paused', 'b:queued']);
    expect(w.calls).toContain('stop task-1 queue_hold');
    expect(w.executing()).toEqual(['c']);
    w.finish('c');
    await w.queue.pump();
    expect(w.states()).toEqual(['b:running', 'a:paused']);
    w.finish('b');
    await w.queue.pump();
    expect(w.states()).toEqual(['a:paused']);
    await w.queue.operate({ op: 'resume', id: '#1' }, { origin: 'mod' });
    // The task a had is put back to work; no second task is made for it.
    expect(w.states()).toEqual(['a:running']);
    expect(w.calls.filter(call => call.startsWith('start '))).toEqual(['start task-1 a', 'start task-2 c', 'start task-3 b']);
    expect(w.calls).toContain('resume task-1');
    expect(w.executing()).toEqual(['a']);
    w.finish('a');
    await w.queue.pump();
    expect(w.queue.view().recent.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['c:done', 'b:done', 'a:done']);
  });
});

describe('the scene of start, stop, cancel and delete', () => {
  it('stops the whole list (nothing starts), starts it again, deletes one, and cancels the running one so the next goes', async () => {
    const w = world();
    for (const goal of ['a', 'b', 'c', 'd']) await w.add(goal);
    await w.queue.operate({ op: 'start', id: '#4' }, { origin: 'mod' });
    expect(w.states()).toEqual(['d:running', 'a:paused', 'b:queued', 'c:queued']);
    await w.queue.operate({ op: 'stop' }, { origin: 'mod' });
    expect(w.states()).toEqual(['d:stopped', 'a:paused', 'b:queued', 'c:queued']);
    expect(w.executing()).toEqual([]);
    await w.queue.pump();
    await w.queue.pump();
    expect(w.running()).toEqual([]);
    expect(w.queue.view().autoRun).toBe(false);
    await w.queue.operate({ op: 'start' }, { origin: 'mod' });
    expect(w.states()).toEqual(['d:running', 'a:paused', 'b:queued', 'c:queued']);
    expect(w.calls).toContain('resume task-2');
    expect(await w.queue.operate({ op: 'delete', id: '#3' }, { origin: 'mod' })).toMatchObject({ ok: true });
    expect(await w.queue.operate({ op: 'delete', id: '#4' }, { origin: 'mod' })).toMatchObject({ ok: false, code: 'running' });
    expect(w.states()).toEqual(['d:running', 'a:paused', 'b:queued']);
    await w.queue.operate({ op: 'cancel' }, { origin: 'mod' });
    // `d` was put in front of `a` (a start of another): when it ends, `a` is taken back, ahead of `b` (2026-11-23).
    expect(w.states()).toEqual(['a:running', 'b:queued']);
    expect(w.queue.view().recent.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['d:cancelled']);
  });

  it('answers a refusal with its code and changes nothing', async () => {
    const w = world();
    expect(await w.queue.operate({ op: 'delete', id: '#9' }, { origin: 'mod' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await w.queue.operate({ op: 'add', goal: '  ' }, { origin: 'mod' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await w.queue.operate({ op: 'delete' }, { origin: 'mod' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(w.queue.snapshot().rev).toBe(0);
  });
});

describe('the list is kept and kept true', () => {
  it('survives a restart (a new queue on the same database) and does not start twice what it started', async () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const first = world({ db });
    await first.add('a');
    await first.add('b');
    const again = fcaMinecraftQueue({ ...first.parts, log: () => undefined });
    expect(again.view().entries.map(entry => `${entry.goal}:${entry.state}:${entry.taskId ? 'task' : '-'}`)).toEqual(['a:running:task', 'b:queued:-']);
    await again.pump();
    expect(first.calls.filter(call => call.startsWith('start '))).toHaveLength(1);
  });

  it('reads with since: the same revision is unchanged, a newer one is the list', async () => {
    const w = world();
    await w.add('a');
    const rev = w.queue.snapshot().rev;
    expect(w.queue.read(rev)).toEqual({ rev, unchanged: true });
    expect(w.queue.read(rev - 1)).toMatchObject({ rev, entries: [{ goal: 'a' }] });
    await w.queue.pump();
    expect(w.queue.snapshot().rev).toBe(rev);
  });

  it('adopts a task that was started from outside, and a start that was lost when the head restarted waits again', async () => {
    const w = world();
    w.tasks.set('operator-task', { phase: 'executing', goal: 'エンドラを倒して', origin: 'operator' });
    await w.queue.pump();
    expect(w.states()).toEqual(['エンドラを倒して:running']);
    expect(w.queue.view().entries[0]).toMatchObject({ origin: 'operator', taskId: 'operator-task' });
    // A task of the list stopped from outside (the mod's old button): the list stops with it, and does not start the next on its own.
    await w.add('b');
    expect(w.states()).toEqual(['エンドラを倒して:running', 'b:queued']);
    w.tasks.get('operator-task')!.phase = 'stopped';
    await w.queue.pump();
    expect(w.states()).toEqual(['エンドラを倒して:stopped', 'b:queued']);
    expect(w.queue.view().autoRun).toBe(false);
    expect(w.executing()).toEqual([]);
    // Any word that starts the list takes the stopped request up again with its own task.
    await w.queue.operate({ op: 'start' }, { origin: 'mod' });
    expect(w.states()).toEqual(['エンドラを倒して:running', 'b:queued']);
    expect(w.calls).toContain('resume operator-task');
  });
});

describe('the list against what the runtime does', () => {
  it('puts the entry on a new task when the runtime refuses to resume the stopped one, and does not fail it', async () => {
    const w = world();
    await w.add('a');
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    w.parts.resume = () => false;
    await w.queue.operate({ op: 'resume', id: '#1' }, { origin: 'mod' });
    expect(w.states()).toEqual(['a:running']);
    expect(w.queue.snapshot().entries[0]!.taskId).toBe('task-2');
    expect(w.executing()).toEqual(['a']);
  });

  it('waits while the task of a resumed entry is still stopping, and starts it when the stop is acknowledged', async () => {
    const w = world({ slowStop: true });
    await w.add('a');
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    await w.queue.operate({ op: 'resume', id: '#1' }, { origin: 'mod' });
    expect(w.states()).toEqual(['a:queued']);
    expect(w.queue.view().recent).toEqual([]);
    w.ack();
    await w.queue.pump();
    expect(w.states()).toEqual(['a:running']);
    expect(w.calls.filter(call => call.startsWith('start '))).toHaveLength(1);
  });

  it('stops a task again when the stop of a held entry did not get through, and leaves it alone before the grace is over', async () => {
    const w = world();
    await w.add('a');
    const real = w.parts.stop;
    let failing = true;
    w.parts.stop = async (id, reason) => { if (failing) throw new Error('STOP_FAILED'); await real(id, reason); };
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    expect(w.executing()).toEqual(['a']);
    await w.queue.pump();
    expect(w.executing()).toEqual(['a']);
    failing = false;
    w.clock.at += 10_000;
    await w.queue.pump();
    expect(w.executing()).toEqual([]);
    expect(w.calls).toContain('stop task-1 queue_stray_stop');
  });

  it('counts a task of the list as open even when the runtime lists it no more among the newest, so no second request starts beside it', async () => {
    const w = world();
    await w.add('a');
    await w.add('b');
    const queue = fcaMinecraftQueue({ ...w.parts, open: () => [] });
    await queue.pump();
    expect(w.states()).toEqual(['a:running', 'b:queued']);
    expect(w.calls.filter(call => call.startsWith('start '))).toHaveLength(1);
  });

  it('does not take a task that is stopping for a request made from outside when its entry was removed', async () => {
    const w = world({ slowStop: true });
    await w.add('a');
    await w.queue.operate({ op: 'hold', id: '#1' }, { origin: 'mod' });
    await w.queue.operate({ op: 'delete', id: '#1' }, { origin: 'mod' });
    await w.queue.pump();
    expect(w.states()).toEqual([]);
  });
});

describe('her words about the list', () => {
  const said = (kind: MinecraftIntent['kind'], fields: Partial<MinecraftIntent> = {}): MinecraftIntent => ({ kind, goal: '', placement: '', target: '', ...fields });
  const chat = { origin: 'chat' as const, requestId: 'mc:1', experienceId: 'exp-1', observedAt: '2026-11-21T00:00:00.000Z' };

  it('adds where she says (end, next, now), and the same request id is one request', async () => {
    const w = world();
    await applyQueueIntent(w.queue, said('task', { goal: 'a' }), chat);
    await applyQueueIntent(w.queue, said('task', { goal: 'b' }), { ...chat, requestId: 'mc:2' });
    await applyQueueIntent(w.queue, said('task', { goal: 'c', placement: 'next' }), { ...chat, requestId: 'mc:3' });
    expect(w.states()).toEqual(['a:running', 'c:queued', 'b:queued']);
    await applyQueueIntent(w.queue, said('task', { goal: 'd', placement: 'now' }), { ...chat, requestId: 'mc:4' });
    expect(w.states()).toEqual(['d:running', 'a:paused', 'c:queued', 'b:queued']);
    const repeat = await applyQueueIntent(w.queue, said('task', { goal: 'd' }), { ...chat, requestId: 'mc:4' });
    expect(repeat).toMatchObject({ delivered: true, as: 'task' });
    expect(w.states()).toHaveLength(4);
    await expect(applyQueueIntent(w.queue, said('task', { goal: 'd' }), { ...chat, requestId: 'mc:4', experienceId: 'exp-other' })).rejects.toThrow('CONFLICT');
  });

  it('cancels, holds and resumes the one she names or the one running, moves one, and refuses with a reason', async () => {
    const w = world();
    for (const [index, goal] of ['a', 'b', 'c'].entries()) await applyQueueIntent(w.queue, said('task', { goal }), { ...chat, requestId: `mc:${index}` });
    await applyQueueIntent(w.queue, said('move', { target: '#3', placement: 'next' }), chat);
    expect(w.states()).toEqual(['a:running', 'c:queued', 'b:queued']);
    await applyQueueIntent(w.queue, said('move', { target: '3', placement: 'end' }), chat);
    expect(w.states()).toEqual(['a:running', 'b:queued', 'c:queued']);
    await applyQueueIntent(w.queue, said('move', { target: '#3', placement: 'now' }), chat);
    expect(w.states()).toEqual(['c:running', 'a:paused', 'b:queued']);
    await applyQueueIntent(w.queue, said('hold'), chat);
    // Her hold of `c`, which was in front of `a`, sets `c` aside: `a` comes back (2026-11-23), and `c` stays held.
    expect(w.states()).toEqual(['a:running', 'c:paused', 'b:queued']);
    expect(await applyQueueIntent(w.queue, said('cancel', { target: '#9' }), chat)).toEqual({ delivered: false, reason: 'no_such_request' });
    await applyQueueIntent(w.queue, said('cancel'), chat);
    expect(w.states()).toEqual(['b:running', 'c:paused']);
    await applyQueueIntent(w.queue, said('cancel'), chat);
    expect(w.states()).toEqual(['c:paused']);
    expect(await applyQueueIntent(w.queue, said('cancel'), chat)).toEqual({ delivered: false, reason: 'nothing_running' });
    expect(await applyQueueIntent(w.queue, said('hold'), chat)).toEqual({ delivered: false, reason: 'nothing_running' });
    await applyQueueIntent(w.queue, said('resume'), chat);
    expect(w.states()).toEqual(['c:running']);
    await applyQueueIntent(w.queue, said('stop'), chat);
    expect(w.states()).toEqual(['c:stopped']);
    await applyQueueIntent(w.queue, said('resume', { target: '#3' }), chat);
    expect(w.states()).toEqual(['c:running']);
  });

  it('refuses a new request when the list is full', async () => {
    const w = world();
    for (let i = 0; i < 22; i += 1) await w.add(`g${i}`);
    expect(await applyQueueIntent(w.queue, said('task', { goal: 'too many' }), chat)).toEqual({ delivered: false, reason: 'queue_full' });
  });
});

describe('a request put aside for another is taken back by the pump (2026-11-23)', () => {
  it('puts a running request aside for a `now` and runs it again, by its own task, when the other is done', async () => {
    const w = world();
    await w.add('cake');
    await w.add('bed', 'now');
    expect(w.states()).toEqual(['bed:running', 'cake:paused']);
    expect(w.queue.snapshot().entries.find(entry => entry.goal === 'cake')!.resumeAfter).toBe(w.queue.snapshot().entries.find(entry => entry.goal === 'bed')!.id);
    expect(w.queue.promptLines()).toEqual(['#2 実行中 「bed」', '#1 保留（いまはしていない。#2 のあとで戻る） 「cake」']);
    expect(w.log).toContain('Shannon Minecraft queue op=add entry=#2 state=-→queued origin=mod code=ok placement=now');
    await w.queue.pump();
    expect(w.states()).toEqual(['bed:running', 'cake:paused']);
    w.finish('bed');
    await w.queue.pump();
    expect(w.states()).toEqual(['cake:running']);
    expect(w.executing()).toEqual(['cake']);
    expect(w.calls).toContain('resume task-1');
  });

  it('does the same for a start of another request (the list screen) and for a move to `now` from her words', async () => {
    const w = world();
    await w.add('cake');
    await w.add('sheep');
    await w.queue.operate({ op: 'start', id: '#2' }, { origin: 'mod' });
    expect(w.states()).toEqual(['sheep:running', 'cake:paused']);
    w.finish('sheep');
    await w.queue.pump();
    expect(w.states()).toEqual(['cake:running']);
    await w.add('bed');
    const moved = await applyQueueIntent(w.queue, { kind: 'move', goal: '', target: '#3', placement: 'now' } satisfies MinecraftIntent, { origin: 'voice' });
    expect(moved).toMatchObject({ delivered: true });
    expect(w.states()).toEqual(['bed:running', 'cake:paused']);
    w.finish('bed');
    await w.queue.pump();
    expect(w.states()).toEqual(['cake:running']);
  });

  it('leaves a request she held herself held, even after the one she put in front is done', async () => {
    const w = world();
    await w.add('cake');
    await w.add('bed', 'now');
    await applyQueueIntent(w.queue, { kind: 'hold', goal: '', target: '#1' } satisfies MinecraftIntent, { origin: 'voice' });
    w.finish('bed');
    await w.queue.pump();
    expect(w.states()).toEqual(['cake:paused']);
  });

  it('keeps the mark across a restart (the stored list), and opens a list stored before the column existed', async () => {
    const w = world();
    await w.add('cake');
    await w.add('bed', 'now');
    const again = fcaMinecraftQueue(w.parts);
    expect(again.snapshot().entries.find(entry => entry.goal === 'cake')!.resumeAfter).not.toBeNull();
    const old = new DatabaseSync(':memory:');
    databases.push(old);
    applySchemaSteps(old, [MINECRAFT_REQUEST_QUEUE_STEP]);
    old.prepare(`INSERT INTO minecraft_request_queue(id, scope_key, seq, goal, state, pos, origin, created_at, updated_at) VALUES ('e1', 'owner', 1, 'cake', 'paused', 0, 'mod', 'x', 'x')`).run();
    old.prepare(`INSERT INTO minecraft_request_queue_state(scope_key, auto_run, rev, next_seq) VALUES ('owner', 1, 1, 2)`).run();
    const reopened = world({ db: old });
    expect(reopened.queue.snapshot().entries[0]).toMatchObject({ goal: 'cake', state: 'paused', resumeAfter: null });
  });
});
