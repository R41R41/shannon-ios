import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { fcaMinecraftVoice, type FcaMinecraftVoiceParts } from '../src/wiring/fcaMinecraftVoice.js';
import { fcaMinecraftQueue } from '../src/wiring/fcaMinecraftQueue.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

const task = (id: string, goal: string): TaskView => ({
  id, scopeKey: 'owner', parentId: 'root', kind: 'task', origin: 'owner_request', title: goal, goal, completionCriteria: '', status: 'ready',
  pauseReason: null, summary: '', revision: 1, createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:00.000Z', phase: 'executing', childIds: [],
} as unknown as TaskView);

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** The queue runs on a small fake of the task runtime (a task per start); the voice parts are as `fcaMinecraftRequests` gives them. */
function fixture(options: { bodies?: string[]; running?: TaskView | null; visible?: boolean; finished?: boolean } = {}) {
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
  it('says whether the body is connected, what he asked of it, and the list', async () => {
    expect(fixture({ bodies: [] }).port.state()).toEqual({ connected: false, running: null });
    expect(fixture({ bodies: ['a', 'b'] }).port.state()).toEqual({ connected: false, running: null });
    expect(fixture().port.state()).toEqual({ connected: true, running: null });
    expect(fixture({ running: task('t1', 'エンドラを倒す') }).port.state()).toEqual({ connected: true, running: { id: 't1', goal: 'エンドラを倒す' } });
    const f = fixture();
    await f.port.intent(task1());
    expect(f.port.state()).toEqual({ connected: true, running: null, queue: ['#1 実行中 「まず鉄の剣を作って」'] });
  });

  it('delivers words for the request under way as a message to that task, and refuses them when none is running', async () => {
    const { port, calls } = fixture({ running: task('t1', 'エンドラを倒す') });
    expect(await port.intent(input())).toEqual({ delivered: true, as: 'message', taskId: 't1' });
    expect(calls).toEqual(['observe t1 dcv:r1 exp-1 Discordの通話での本人の言葉（いまのタスクへ）: まず鉄の剣を作って']);
    expect(await fixture().port.intent(input())).toEqual({ delivered: false, reason: 'nothing_running' });
  });

  it('adds a new request whoever is in the channel, as a request of the list that keeps who asked', async () => {
    const f = fixture();
    expect(await f.port.intent(task1())).toMatchObject({ delivered: true, as: 'task', taskId: 'new-task-1' });
    expect(f.calls[0]).toBe('start new-task-1 まず鉄の剣を作って dcv:r1 exp-1');
    const guest = fixture();
    await guest.port.intent(task1({ speaker: { id: '2', name: 'ユウ', owner: false } }));
    expect(guest.queue.view().entries[0]).toMatchObject({ origin: 'voice', askedBy: 'ユウ（ゲスト）' });
    expect(guest.queue.promptLines()[0]).toContain('（ユウ（ゲスト））');
    const owner = fixture();
    await owner.port.intent(task1({ speaker: { id: '1', name: 'ライ氏', owner: true } }));
    expect(owner.queue.view().entries[0]).toMatchObject({ origin: 'voice', askedBy: '本人（ライ氏）' });
    const message = fixture({ running: task('t1', 'エンドラを倒す') });
    await message.port.intent(input({ speaker: { id: '2', name: 'ユウ', owner: false } }));
    expect(message.calls[0]).toContain('Discordの通話でのユウ（ゲスト）の言葉（いまのタスクへ）: まず鉄の剣を作って');
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
  const owner = { id: '1', name: 'ライ氏', owner: true }, guest = { id: '2', name: 'ユウ', owner: false };
  it('travels in the words the head reads, for a message and for a request, and marks a guest as one', async () => {
    const message = fixture({ running: task('t1', 'ケーキを作る') });
    await message.port.intent(input({ speaker: guest, speakerMinecraftName: 'Yuu_7' }));
    expect(message.calls[0]).toContain('Discordの通話でのユウ（ゲスト、マイクラ名 Yuu_7）の言葉（いまのタスクへ）: まず鉄の剣を作って');
    const ask = fixture();
    await ask.port.intent(task1({ speaker: owner, speakerMinecraftName: 'Rai_41' }));
    expect(ask.queue.view().entries[0]).toMatchObject({ askedBy: '本人（ライ氏、マイクラ名 Rai_41）' });
    const guestAsk = fixture();
    await guestAsk.port.intent(task1({ speaker: guest, speakerMinecraftName: 'Yuu_7' }));
    expect(guestAsk.queue.view().entries[0]).toMatchObject({ askedBy: 'ユウ（ゲスト、マイクラ名 Yuu_7）' });
  });

  it('is read from the speaker too', async () => {
    const f = fixture();
    await f.port.intent(task1({ speaker: { ...guest, minecraftName: 'Yuu_7' } }));
    expect(f.queue.view().entries[0]).toMatchObject({ askedBy: 'ユウ（ゲスト、マイクラ名 Yuu_7）' });
  });

  it('is left out when it is absent or is not a game name, and the words stay as they were', async () => {
    for (const name of [undefined, null, '', 'ユウ', 'a b', 'x'.repeat(17)]) {
      const f = fixture();
      await f.port.intent(task1({ speaker: guest, speakerMinecraftName: name }));
      expect(f.queue.view().entries[0]).toMatchObject({ askedBy: 'ユウ（ゲスト）' });
    }
    const noSpeaker = fixture({ running: task('t1', 'ケーキを作る') });
    await noSpeaker.port.intent(input({ speakerMinecraftName: 'Rai_41' }));
    expect(noSpeaker.calls[0]).toContain('Discordの通話での本人（マイクラ名 Rai_41）の言葉');
  });
});
