import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fcaMinecraftVoice, type FcaMinecraftVoiceParts } from '../src/wiring/fcaMinecraftVoice.js';
import { fcaMinecraftQueue } from '../src/wiring/fcaMinecraftQueue.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { planFromSeeds } from '@shannon/mind';
import { spokenFor } from '../src/surfaces/minecraft/minecraftPeopleWords.js';

const task = (id: string, goal: string): TaskView => ({
  id, scopeKey: 'owner', parentId: 'root', kind: 'task', origin: 'owner_request', title: goal, goal, completionCriteria: '', status: 'ready',
  pauseReason: null, summary: '', revision: 1, createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z', phase: 'executing', childIds: [],
} as unknown as TaskView);

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** The queue runs on a small fake of the task runtime (a task per start); the voice parts are as `fcaMinecraftRequests` gives them. */
function fixture(options: { bodies?: string[]; running?: TaskView | null; visible?: boolean; finished?: boolean; resting?: Array<{ goal: string; how: string }>; checkpoint?: unknown } = {}) {
  const calls: string[] = [];
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const tasks = new Map<string, string>();
  const bound = options.running ? [options.running] : [];
  let counter = 0;
  const queue = fcaMinecraftQueue({
    db, scopeKey: 'owner', atomic: work => underWriteLock(db, null, '', work, 'voice_test'),
    phase: id => (tasks.has(id) ? tasks.get(id)! : null), open: () => [...tasks].filter(([, phase]) => phase === 'executing')
      .map(([taskId]) => ({ taskId, goal: taskId, phase: 'executing', origin: null })),
    bodyReady: () => (options.bodies ?? ['minecraft:world']).length === 1,
    stop: async (id, reason) => { calls.push(`queue-stop ${id} ${reason}`); tasks.set(id, 'stopped'); },
    resume: id => { tasks.set(id, 'executing'); return true; },
    start: async entry => {
      counter += 1;
      const id = `new-task-${counter}`;
      calls.push(`start ${id} ${entry.goal} ${entry.requestId} ${entry.experienceId}`);
      tasks.set(id, 'executing');
      return id;
    },
    now: () => '2026-10-20T12:00:00.000Z', log: () => undefined,
  });
  const parts: FcaMinecraftVoiceParts = {
    control: { available: () => options.bodies ?? ['minecraft:world'] } as never,
    runtime: {
      ...(options.checkpoint === undefined ? {} : { snapshot: () => ({ checkpoint: options.checkpoint }) }),
      observeExternal: (_scope: string, id: string, event: { eventId: string; experienceIds: string[]; text: string }) => {
        if (options.finished && id === 't1') throw new Error('FCA_TARGET_FINISHED');
        calls.push(`observe ${id} ${event.eventId} ${event.experienceIds.join(',')} ${event.text}`);
        return { accepted: true, duplicate: false };
      },
    } as never,
    ownerScope: 'owner',
    stop: async (id: string, reason: string) => { calls.push(`stop ${id} ${reason}`); return []; },
    sourceVisible: () => options.visible ?? true,
    bound: () => bound,
    openRequest: () => options.running ?? undefined,
    ...(options.resting ? { resting: () => options.resting! } : {}),
    log: () => undefined,
    queue,
  };
  return { port: fcaMinecraftVoice(parts), calls, queue };
}

const input = (fields: Record<string, unknown> = {}) => ({
  scopeKey: 'owner', requestId: 'r1', observedAt: '2026-10-20T12:00:00.000Z', experienceId: 'exp-1',
  intent: { kind: 'message' as const, goal: 'まず鉄の剣を作って' }, ...fields,
});
const task1 = (fields: Record<string, unknown> = {}) => input({ intent: { kind: 'task', goal: 'まず鉄の剣を作って' }, ...fields });

describe('the owner\'s spoken request, as the task tree takes it', () => {
  /** A row of the list that changed a moment ago carries 変わった: HH:mm (2026-11-23); the rows are compared without it. */
  const unmarked = (state: { queue?: string[] }) => ({ ...state, ...(state.queue ? { queue: state.queue.map(line => line.replace(/（変わった: \d\d:\d\d に始まった。いまの話はこれ）/u, '').replace(/変わった: \d\d:\d\d に保留。/u, '')) } : {}) });

  it('says whether the body is connected, what he asked of it, and the list', async () => {
    expect(fixture({ bodies: [] }).port.state()).toEqual({ connected: false, running: null });
    expect(fixture({ bodies: ['a', 'b'] }).port.state()).toEqual({ connected: false, running: null });
    expect(fixture().port.state()).toEqual({ connected: true, running: null });
    expect(fixture({ running: task('t1', 'エンドラを倒す') }).port.state()).toEqual({ connected: true, running: { id: 't1', goal: 'エンドラを倒す' } });
    // The requests that are not going on are told to the voice (not the one that runs), so a promise in the history is not read as work to come.
    expect(fixture({ running: task('t1', 'ケーキを作る'), resting: [{ goal: '羊を倒す', how: '止めた' }, { goal: 'ケーキを作る', how: '保留中' }] }).port.state())
      .toEqual({ connected: true, running: { id: 't1', goal: 'ケーキを作る' }, resting: ['「羊を倒す」（止めた）'] });
    const f = fixture();
    await f.port.intent(task1());
    // The list says which request runs (here the task runtime's open request is none yet): her reply is told that one.
    expect(unmarked(f.port.state())).toEqual({ connected: true, running: { id: 'new-task-1', goal: 'まず鉄の剣を作って' }, queue: ['#1 実行中 「まず鉄の剣を作って」'] });
  });

  it('after a swap tells her the request put in front as the one under way, and the one put aside as waiting for it (2026-11-23)', async () => {
    const f = fixture();
    await f.port.intent(task1({ requestId: 'r1', intent: { kind: 'task', goal: 'ケーキを1個作る' } }));
    await f.port.intent(task1({ requestId: 'r2', intent: { kind: 'task', goal: 'ベッドを作る', placement: 'now' } }));
    expect(unmarked(f.port.state())).toEqual({ connected: true, running: { id: 'new-task-2', goal: 'ベッドを作る' },
      queue: ['#2 実行中 「ベッドを作る」', '#1 保留（いまはしていない。#2 のあとで戻る） 「ケーキを1個作る」'] });
  });

  it('delivers words for the request under way as a message to that task, and adds them as a request of their own when none is running', async () => {
    const { port, calls } = fixture({ running: task('t1', 'エンドラを倒す') });
    expect(await port.intent(input())).toEqual({ delivered: true, as: 'message', taskId: 't1' });
    expect(calls).toEqual(['observe t1 dcv:r1 exp-1 Discordの通話での本人の言葉（いまのタスクへ）: まず鉄の剣を作って']);
    const idle = fixture();
    expect(await idle.port.intent(input())).toMatchObject({ delivered: true, as: 'task' });
    expect(idle.queue.view().entries).toHaveLength(1);
    expect(idle.queue.view().entries[0]).toMatchObject({ goal: 'まず鉄の剣を作って', origin: 'voice' });
  });

  it('adds a new request whoever is in the channel, as a request of the list that keeps who asked', async () => {
    const f = fixture();
    expect(await f.port.intent(task1())).toMatchObject({ delivered: true, as: 'task', taskId: 'new-task-1' });
    expect(f.calls[0]).toBe('start new-task-1 まず鉄の剣を作って dcv:r1 exp-1');
    const guest = fixture();
    await guest.port.intent(task1({ speaker: { id: '2', name: 'ユウ', owner: false } }));
    expect(guest.queue.view().entries[0]).toMatchObject({ origin: 'voice', askedBy: 'ユウ' });
    expect(guest.queue.promptLines()[0]).toContain('（ユウ）');
    const owner = fixture();
    await owner.port.intent(task1({ speaker: { id: '1', name: 'ライ', owner: true } }));
    expect(owner.queue.view().entries[0]).toMatchObject({ origin: 'voice', askedBy: 'ライ' });
    const message = fixture({ running: task('t1', 'エンドラを倒す') });
    await message.port.intent(input({ speaker: { id: '2', name: 'ユウ', owner: false } }));
    expect(message.calls[0]).toContain('Discordの通話でのユウの言葉（いまのタスクへ）: まず鉄の剣を作って');
    // A request while one is under way is a second request on the list, not words for the first.
    const busy = fixture();
    await busy.port.intent(task1());
    expect(await busy.port.intent(task1({ requestId: 'r2', intent: { kind: 'task', goal: 'パンを作って' } }))).toMatchObject({ delivered: true, as: 'task' });
    expect(busy.queue.view().entries.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['まず鉄の剣を作って:running', 'パンを作って:queued']);
    // The same turn heard again is the same request.
    await busy.port.intent(task1({ requestId: 'r2', intent: { kind: 'task', goal: 'パンを作って' } }));
    expect(busy.queue.view().entries).toHaveLength(2);
  });

  it('takes every word about the list whoever is in the channel, and names a request that is not there', async () => {
    const f = fixture();
    await f.port.intent(task1());
    await f.port.intent(task1({ requestId: 'r2', intent: { kind: 'task', goal: 'パンを作って' } }));
    const say = (kind: string, fields: Record<string, unknown> = {}) => f.port.intent(input({ requestId: `r-${kind}`, intent: { kind, goal: '', placement: '', target: '', ...fields } }));
    expect(await say('hold')).toMatchObject({ delivered: true, as: 'queue' });
    expect(f.queue.view().entries.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['パンを作って:running', 'まず鉄の剣を作って:paused']);
    expect(await say('resume', { target: '#1' })).toMatchObject({ delivered: true, as: 'queue' });
    expect(await say('cancel', { target: '#9' })).toEqual({ delivered: false, reason: 'no_such_request' });
    expect(await say('cancel', { target: '#2' })).toMatchObject({ delivered: true, as: 'queue' });
    expect(f.queue.view().recent[0]).toMatchObject({ goal: 'パンを作って', state: 'cancelled' });
  });

  it('stops the body\'s tasks and the list whoever is in the channel, and refuses what has no turn, no body or another scope', async () => {
    const stopping = fixture({ running: task('t1', 'x') });
    expect(await stopping.port.intent(input({ intent: { kind: 'stop', goal: '' } }))).toEqual({ delivered: true, as: 'stop' });
    expect(stopping.calls).toEqual(['stop t1 owner_voice_stop']);
    expect(stopping.queue.view().autoRun).toBe(false);
    expect(await fixture().port.intent(input({ intent: { kind: 'none', goal: '' } }))).toEqual({ delivered: false });
    expect(await fixture().port.intent(input({ scopeKey: 'someone' }))).toEqual({ delivered: false, reason: 'not_owner_scope' });
    expect(await fixture({ bodies: [] }).port.intent(task1())).toEqual({ delivered: false, reason: 'body_unavailable' });
    expect(await fixture().port.intent(task1({ experienceId: null }))).toEqual({ delivered: false, reason: 'no_turn' });
    expect(await fixture({ visible: false }).port.intent(task1())).toEqual({ delivered: false, reason: 'turn_not_visible' });
  });
});

describe('the speaker\'s in-game name', () => {
  const owner = { id: '1', name: 'ライ', owner: true }, guest = { id: '2', name: 'ユウ', owner: false };
  it('travels in the words the head reads, for a message and for a request, the same for the owner and a guest', async () => {
    const message = fixture({ running: task('t1', 'ケーキを作る') });
    await message.port.intent(input({ speaker: { ...guest, minecraftName: 'Yuu_7' } }));
    expect(message.calls[0]).toContain('Discordの通話でのユウ（マイクラ名 Yuu_7）の言葉（いまのタスクへ）: まず鉄の剣を作って');
    const ask = fixture();
    await ask.port.intent(task1({ speaker: { ...owner, minecraftName: 'Rai_41' } }));
    expect(ask.queue.view().entries[0]).toMatchObject({ askedBy: 'ライ（マイクラ名 Rai_41）' });
    const guestAsk = fixture();
    await guestAsk.port.intent(task1({ speaker: { ...guest, minecraftName: 'Yuu_7' } }));
    expect(guestAsk.queue.view().entries[0]).toMatchObject({ askedBy: 'ユウ（マイクラ名 Yuu_7）' });
  });

  it('is left out when it is absent or is not a game name, and the words stay as they were', async () => {
    for (const name of [undefined, '', 'ユウ', 'a b', 'x'.repeat(17)]) {
      const f = fixture();
      await f.port.intent(task1({ speaker: { ...guest, minecraftName: name } }));
      expect(f.queue.view().entries[0]).toMatchObject({ askedBy: 'ユウ' });
    }
    const dotted = fixture();
    await dotted.port.intent(task1({ speaker: { ...guest, minecraftName: '.Yuu7' } }));
    expect(dotted.queue.view().entries[0]).toMatchObject({ askedBy: 'ユウ（マイクラ名 .Yuu7）' });
  });
});

describe('the words as spoken, when and where (a line without them reads as before)', () => {
  const guest = { id: '2', name: 'ミキ', owner: false };
  it('adds the speaker\'s words, the time and the place to the words for the request under way, whoever spoke', async () => {
    for (const speaker of [guest, { id: '1', name: 'ライ', owner: true }]) {
      const f = fixture({ running: task('t1', 'ケーキを作る') });
      await f.port.intent(input({ speaker, speakerName: speaker.name, speakerWords: 'スケルトンを倒して骨粉を取って', spokenAt: '2026-11-24T15:40:00.000Z',
        speakerPos: { x: 4.2, y: 70, z: -9.9 }, intent: { kind: 'message', goal: 'スケルトンを倒して骨粉を取る' } }));
      expect(f.calls[0]).toContain(`Discordの通話での${speaker.name}の言葉（いまのタスクへ）: スケルトンを倒して骨粉を取る（言われた言葉: 「スケルトンを倒して骨粉を取って」・言った時刻 2026-11-24T15:40:00Z・話した人のマイクラの位置 4,70,-10）`);
    }
  });
  it('gives the words as spoken to the task made from a request, by the request\'s id; the entry keeps none', async () => {
    const f = fixture();
    await f.port.intent(task1({ speaker: guest, speakerWords: 'ケーキを作って、寝ずにね', spokenAt: '2026-11-24T15:40:00.000Z' }));
    expect(spokenFor('dcv:r1')).toBe('（言われた言葉: 「ケーキを作って、寝ずにね」・言った時刻 2026-11-24T15:40:00Z）');
  });
  it('is the old line, unchanged, with none of the fields', async () => {
    const f = fixture({ running: task('t1', 'エンドラを倒す') });
    await f.port.intent(input({ speaker: guest }));
    expect(f.calls).toEqual(['observe t1 dcv:r1 exp-1 Discordの通話でのミキの言葉（いまのタスクへ）: まず鉄の剣を作って']);
  });
});

describe("the running request's plan, as the voice turn is shown it (advice that helps the request is told apart from a request of its own)", () => {
  const running = task('t1', 'ケーキを1個作る');
  const tree = { ...planFromSeeds([{ title: 'ケーキの材料を集める', children: [{ title: '小麦を育てる', state: 'wait' }, { title: '卵を取る' }, { title: '牛乳を汲む' }] }, { title: 'ケーキを焼く' }])!, goal: 'ケーキを1個作る' };

  it("gives the goal, the node under way and the nodes left, from the plan tree in the task's checkpoint", () => {
    const current = tree.nodes.find(node => node.title === '小麦を育てる')!;
    const lines = fixture({ running, checkpoint: { fcaPlanTree: { ...tree, current: current.id } } }).port.state().planLines!;
    expect(lines[0]).toBe('目的: ケーキを1個作る');
    expect(lines[1]).toBe('いま: 小麦を育てる（待ち）');
    expect(lines[2]).toContain('卵を取る');
    expect(lines[2]).toContain('ケーキを焼く');
  });

  it('gives no plan lines when the task has no plan yet, when the checkpoint is unreadable or when the runtime cannot say', () => {
    expect(fixture({ running }).port.state().planLines).toBeUndefined();
    expect(fixture({ running, checkpoint: null }).port.state().planLines).toBeUndefined();
    expect(fixture({ running, checkpoint: { fcaPlanTree: { schema: 'nope' } } }).port.state().planLines).toBeUndefined();
  });
});
