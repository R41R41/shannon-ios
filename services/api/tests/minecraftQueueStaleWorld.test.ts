import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fcaMinecraftQueue, type QueueParts } from '../src/wiring/fcaMinecraftQueue.js';
import { applyQueueIntent } from '../src/wiring/fcaMinecraftQueueIntent.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import { applySchemaSteps } from '../src/infra/sqlite/migrations/schemaSteps.js';
import { MINECRAFT_REQUEST_QUEUE_STEP } from '../src/infra/sqlite/migrations/execution/014_minecraft_request_queue.js';
import { MINECRAFT_QUEUE_PREV_WORLD_NOTE } from '../src/contracts/minecraftQueueContract.js';
import { minecraftQueueGuide } from '../src/contracts/minecraftQueuePrompt.js';
import { EMPTY_QUEUE, QUEUE_CHAIN_QUIET_MS, queuePromptLines, queueStaleness, type QueueRecord } from '../src/surfaces/minecraft/minecraftRequestQueue.js';
import type { MinecraftIntent } from '../src/surfaces/minecraft/minecraftIntent.js';

/**
 * The shoot of 2026-11-26: a list that kept a request put aside (#13, waiting for #15) and a request stopped with the whole list (#15) from
 * 2026-11-25, in a world that was made new since. The owner held the new #16 and pressed 「始める」 on #15; when #15 was held again, #13
 * went on by itself, with its plan of the world before. Here the list is the real one on a database; the task runtime and the body are
 * the fakes of `fcaMinecraftQueue.test.ts`.
 */
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const HOUR = 3_600_000;

function world(options: { db?: DatabaseSync } = {}) {
  const db = options.db ?? new DatabaseSync(':memory:');
  if (!options.db) databases.push(db);
  const tasks = new Map<string, { phase: string; goal: string }>();
  const clock = { at: Date.parse('2026-11-25T00:00:00.000Z') };
  const calls: string[] = [];
  let counter = 0;
  const parts: QueueParts = {
    db, scopeKey: 'owner', atomic: work => underWriteLock(db, null, '', work, 'queue_test'),
    phase: id => tasks.get(id)?.phase ?? null,
    open: () => [...tasks].filter(([, task]) => !['stopped', 'completed', 'failed'].includes(task.phase))
      .map(([taskId, task]) => ({ taskId, goal: task.goal, phase: task.phase, origin: 'chat' as const })),
    bodyReady: () => true,
    stop: async (id, reason) => { calls.push(`stop ${id} ${reason}`); tasks.get(id)!.phase = 'stopped'; },
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
      tasks.set(id, { phase: 'executing', goal: entry.goal });
      return id;
    },
    now: () => new Date(clock.at).toISOString(),
    log: () => {},
  };
  const queue = fcaMinecraftQueue(parts);
  const states = () => queue.view().entries.map(entry => `${entry.goal}:${entry.state}`);
  const executing = () => [...tasks.values()].filter(task => task.phase === 'executing').map(task => task.goal);
  const entry = (goal: string): QueueRecord => queue.snapshot().entries.find(item => item.goal === goal)!;
  const add = (goal: string, placement?: 'end' | 'next' | 'now') => queue.operate({ op: 'add', goal, ...(placement ? { placement } : {}) }, { origin: 'mod' });
  const press = (op: 'start' | 'hold' | 'resume' | 'cancel', goal: string | null) =>
    queue.operate({ op, ...(goal ? { id: entry(goal).id } : {}) }, { origin: 'mod' });
  const later = (ms: number) => { clock.at += ms; };
  return { db, parts, queue, calls, states, executing, entry, add, press, later };
}

/** 11/25 00:30-00:55: #13 put aside for #15, then the whole list stopped (#15 stopped, #13 still waiting for it). */
async function leftFromYesterday(w: ReturnType<typeof world>) {
  await w.add('鉄の装備を作る');
  w.later(60_000);
  await w.add('死亡の作り直し', 'now');
  w.later(18 * 60_000);
  await w.queue.operate({ op: 'stop' }, { origin: 'mod' });
  expect(w.states()).toEqual(['死亡の作り直し:stopped', '鉄の装備を作る:paused']);
  expect(w.entry('鉄の装備を作る').resumeAfter).toBe(w.entry('死亡の作り直し').id);
}

/** 11/26 00:00-00:33: the new request is added and held, the old stopped one is started by the button and held again. */
async function shootNight(w: ReturnType<typeof world>) {
  await w.add('ケーキを作る');
  w.later(30 * 60_000);
  await w.add('骨粉でケーキを作る');
  await w.press('hold', 'ケーキを作る');
  await w.press('start', '死亡の作り直し');
  w.later(60_000);
  await w.press('hold', '死亡の作り直し');
  await w.queue.pump();
}

describe('what the list kept from yesterday does not run by itself in the world after (2026-11-26)', () => {
  it('(before) the request put aside for the old one goes on by itself when the old one is held again, in the same world within the day', async () => {
    const w = world();
    await leftFromYesterday(w);
    w.later(5 * HOUR);
    await shootNight(w);
    // it is taken back into the list (queued, behind the one that was held for the same reason): it runs when its turn comes, with its old plan
    expect(['queued', 'running']).toContain(w.entry('鉄の装備を作る').state);
  });

  it('does not run it when the world was made new in between: the old one starts as a new task, and the held one stays held', async () => {
    const w = world();
    await leftFromYesterday(w);
    w.later(23.5 * HOUR);
    w.queue.worldChanged();
    w.later(HOUR / 2);
    await shootNight(w);
    expect(w.executing()).not.toContain('鉄の装備を作る');
    expect(w.entry('鉄の装備を作る').state).toBe('paused');
    // the owner named the old one, so it ran, as a new task from its words (the plan of the world before is let go), not as the stopped task
    expect(w.calls.filter(line => line.includes('死亡の作り直し')).map(line => line.replace(/task-\d+/u, 'task'))).toEqual(['start task 死亡の作り直し', 'start task 死亡の作り直し']);
    // the tasks of yesterday (the first two started) are never put back to work
    const oldTasks = ['task-1', 'task-2'];
    expect(w.calls.filter(line => line.startsWith('resume') && oldTasks.includes(line.split(' ')[1]!))).toEqual([]);
    expect(w.executing()).toEqual(['骨粉でケーキを作る']);
  });

  it('does not run it either when no one told the list of the new world but the wait has gone on for most of a day', async () => {
    const w = world();
    await leftFromYesterday(w);
    w.later(QUEUE_CHAIN_QUIET_MS + HOUR);
    await shootNight(w);
    expect(w.entry('鉄の装備を作る')).toMatchObject({ state: 'paused', resumeAfter: null });
    expect(w.executing()).not.toContain('鉄の装備を作る');
  });

  it('still takes a request back after a normal wait, in the new world too (the chain of `now` is kept)', async () => {
    const w = world();
    w.queue.worldChanged();
    w.later(HOUR);
    await w.add('鉄の装備を作る');
    await w.add('ベッドを作る', 'now');
    w.later(30 * 60_000);
    await w.press('hold', 'ベッドを作る');
    await w.queue.pump();
    expect(w.executing()).toEqual(['鉄の装備を作る']);
  });

  it('does not start what the whole list stopped from before the new world on 「始めて」 or 「再開して」 without a number; a request she names does start', async () => {
    const w = world();
    await leftFromYesterday(w);
    w.later(HOUR);
    w.queue.worldChanged();
    await w.queue.operate({ op: 'start' }, { origin: 'voice' });
    await w.queue.operate({ op: 'resume' }, { origin: 'voice' });
    await w.queue.pump();
    expect(w.states()).toEqual(['死亡の作り直し:stopped', '鉄の装備を作る:paused']);
    expect(w.executing()).toEqual([]);
    await applyQueueIntent(w.queue, { kind: 'resume', goal: '', target: `#${w.entry('鉄の装備を作る').seq}` } satisfies MinecraftIntent, { origin: 'voice' });
    expect(w.executing()).toEqual(['鉄の装備を作る']);
    expect(w.calls.at(-1)).toMatch(/^start task-\d+ 鉄の装備を作る$/u);
  });

  it('keeps the owner\'s own hold of today: 「再開して」 without a number brings back what she held after the new world', async () => {
    const w = world();
    w.queue.worldChanged();
    w.later(HOUR);
    await w.add('ケーキを作る');
    await w.press('hold', 'ケーキを作る');
    w.later(2 * HOUR);
    await w.queue.operate({ op: 'resume' }, { origin: 'voice' });
    // her own hold of today is resumed as it always was: the same task goes on
    expect(w.executing()).toEqual(['ケーキを作る']);
    expect(w.calls.filter(line => line.startsWith('resume')).length).toBe(1);
  });

  it('keeps what she held before the new world resumable by its number, and says in the list that it is of the world before', async () => {
    const w = world();
    await w.add('ケーキを作る');
    await w.press('hold', 'ケーキを作る');
    w.later(HOUR);
    w.queue.worldChanged();
    const row = w.queue.view().entries.find(entry => entry.goal === 'ケーキを作る')!;
    expect(row).toMatchObject({ state: 'paused', note: MINECRAFT_QUEUE_PREV_WORLD_NOTE });
    expect(w.queue.promptLines().join('\n')).toContain(MINECRAFT_QUEUE_PREV_WORLD_NOTE);
    await w.press('resume', 'ケーキを作る');
    expect(w.states()).toEqual(['ケーキを作る:running']);
    expect(w.queue.view().entries[0]!.note).toBeUndefined();
  });
});

describe('what is marked, and where it is kept', () => {
  const entry = (patch: Partial<QueueRecord>): QueueRecord => ({
    id: 'e', seq: 1, goal: 'g', state: 'paused', pos: 0, origin: 'mod', requestId: null, experienceId: null, observedAt: null, askedBy: null,
    taskId: 't', createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z', endedAt: null, note: null, resumeAfter: null, ...patch,
  });
  const epoch = '2026-11-25T12:00:00.000Z';

  it('marks only a held or stopped request that ran before the world was made new', () => {
    expect(queueStaleness(entry({}), epoch)).toBe('prev_world');
    expect(queueStaleness(entry({ state: 'stopped' }), epoch)).toBe('prev_world');
    expect(queueStaleness(entry({ state: 'queued' }), epoch)).toBeNull();
    expect(queueStaleness(entry({ state: 'running' }), epoch)).toBeNull();
    expect(queueStaleness(entry({ taskId: null }), epoch)).toBeNull();
    expect(queueStaleness(entry({ updatedAt: '2026-11-25T13:00:00.000Z' }), epoch)).toBeNull();
    expect(queueStaleness(entry({}), null)).toBeNull();
    expect(queueStaleness(entry({}), undefined)).toBeNull();
  });

  it('says it in the lines of her turn only for those rows, and the guide then tells her what to do with them', () => {
    const snapshot = { ...EMPTY_QUEUE, nextSeq: 3, worldEpoch: epoch, entries: [entry({ seq: 1, goal: '古い' }), entry({ id: 'f', seq: 2, goal: '新しい', taskId: null, state: 'queued' })] };
    const lines = queuePromptLines(snapshot);
    expect(lines[0]).toContain(MINECRAFT_QUEUE_PREV_WORLD_NOTE);
    expect(lines[1]).not.toContain(MINECRAFT_QUEUE_PREV_WORLD_NOTE);
    const guide = minecraftQueueGuide({ queueLines: lines, running: null }).join('\n');
    expect(guide).toContain('新しく足す');
    const plain = minecraftQueueGuide({ queueLines: [lines[1]!], running: null }).join('\n');
    expect(plain).not.toContain(MINECRAFT_QUEUE_PREV_WORLD_NOTE);
  });

  it('keeps the time in the stored list across a restart, opens a list stored before the column existed, and does not make the epoch from nothing', () => {
    const w = world();
    expect(w.queue.snapshot().worldEpoch ?? null).toBeNull();
    w.queue.worldChanged('2026-11-26T00:00:00.000Z');
    expect(fcaMinecraftQueue(w.parts).snapshot().worldEpoch).toBe('2026-11-26T00:00:00.000Z');
    const old = new DatabaseSync(':memory:');
    databases.push(old);
    applySchemaSteps(old, [MINECRAFT_REQUEST_QUEUE_STEP]);
    old.prepare(`INSERT INTO minecraft_request_queue_state(scope_key, auto_run, rev, next_seq) VALUES ('owner', 1, 1, 2)`).run();
    const reopened = world({ db: old });
    expect(reopened.queue.snapshot().worldEpoch ?? null).toBeNull();
    reopened.queue.worldChanged('2026-11-26T01:00:00.000Z');
    expect(fcaMinecraftQueue(reopened.parts).snapshot().worldEpoch).toBe('2026-11-26T01:00:00.000Z');
  });
});
