import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MinecraftIntent } from '../src/contracts/minecraftBodyContract.js';
import { fcaMinecraftQueue } from '../src/wiring/fcaMinecraftQueue.js';
import { queueTaskPorts } from '../src/wiring/fcaMinecraftQueuePorts.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../src/surfaces/platform/platformVoice.js';
import { splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { fcaMinecraftVoice } from '../src/wiring/fcaMinecraftVoice.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * Owner decision 2026-11-21 (「全員と自由に話せてほしい」): in a voice channel with several people, anyone's spoken request reaches the
 * Minecraft body's task tree, with their name. The fake input here is what the Discord body sends (`POST /v1/platform/voice/turn`); the
 * port is the real `fcaMinecraftVoice`, whose source check is the real memory read (a task may stand only on a turn the owner can read).
 */
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const OTHER = '900000000000000003';
const ROOM = 'discord:111:222'; // the server's prefix binding: shared
const START = '2026-11-21T12:00:00.000Z';
const TOKEN = 'c'.repeat(40);
const BRIDGE = {
  SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' }]),
};
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  intent: MinecraftIntent | null = null;
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'うん、いいよ。', ...(this.intent ? { minecraftIntent: this.intent } : {}) };
  }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    const result = await this.generate(request);
    await onReplyText(result.reply);
    return result;
  }
}

const taskView = (id: string, goal: string): TaskView => ({
  id, scopeKey: 'owner', parentId: 'root', kind: 'generic', origin: 'owner_request', title: goal, goal, completionCriteria: '', status: 'queued',
  pauseReason: null, summary: '', revision: 1, createdAt: START, updatedAt: START, phase: 'ready', childIds: [],
} as unknown as TaskView);

function world() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-open-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => START;
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  // The task tree's side: what it was handed, in order; the memory read is the real one.
  const memory = createTaskMemory({ state: store, conversations: store, ownerScope: 'owner', ownerAlone: () => true /* `tasksOpen` in serverFcaWiring.ts */, now });
  const calls: string[] = [];
  const sources: string[][] = [];
  const tasks = new Map<string, TaskView>();
  const db = new DatabaseSync(':memory:');
  const atomic = <T,>(work: () => T): T => underWriteLock(db, null, '', work, 'voice_open_test');
  const control = { available: () => ['minecraft:world'], latest: () => ({}), bodyId: () => 'minecraft:world', store: { bind: () => true, body: () => 'minecraft:world' } };
  const runtime = {
    ensureRoot: () => ({ id: 'root' }),
    createChild: (_scope: string, _parent: string, spec: { goal: string }) => {
      const task = taskView(`task-${tasks.size + 1}`, spec.goal);
      tasks.set(task.id, task); calls.push(`task ${spec.goal}`);
      return task;
    },
    get: (_scope: string, id: string) => tasks.get(id) ?? null,
    list: () => [...tasks.values()],
    resume: () => null,
    observeExternal: (_scope: string, id: string, event: { text: string; experienceIds: string[] }) => { calls.push(`${id} ${event.text}`); sources.push(event.experienceIds); return { accepted: true, duplicate: false }; },
  };
  const stop = async (id: string, reason: string): Promise<TaskView[]> => {
    calls.push(`stop ${id} ${reason}`);
    const task = tasks.get(id);
    if (task) tasks.set(id, { ...task, phase: 'stopped' } as TaskView);
    return [];
  };
  const queue = fcaMinecraftQueue(queueTaskPorts({
    db, control: control as never, runtime: runtime as never, ownerScope: 'owner', atomic, stop, log: line => calls.push(`log ${line}`),
    spec: goal => ({ title: goal, goal }) as never, requestOrigin: () => 'voice', newTask: (_message, _goal, _body, own) => Promise.resolve(own()),
  }));
  const live = (task: TaskView) => task.phase !== 'stopped';
  const open = () => [...tasks.values()].filter(live).at(0);
  const port = fcaMinecraftVoice({
    control: control as never, runtime: runtime as never, ownerScope: 'owner', stop,
    sourceVisible: id => memory.read('owner', [id], OWNER_AUDIENCE).length > 0,
    bound: () => [...tasks.values()].filter(live),
    openRequest: () => open(),
    log: line => calls.push(`log ${line}`),
    queue,
  });
  const service = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now, chatModel: model, minecraft: () => port,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), environment: () => ({ SHANNON_DC_VOICE: 'on', SHANNON_DC_VOICE_MINECRAFT: 'on' }), log: () => undefined,
  });
  let counter = 0;
  const say = async (userMessage: string, speaker: { id: string; name: string }) => {
    const lines: VoiceTurnLine[] = [];
    await service.turn({
      platform: 'discord', requestId: `open-${(counter += 1)}`, conversationId: ROOM, voiceChannelId: '700', sourceUserId: speaker.id, sourceDisplayName: speaker.name,
      userMessage, observedAt: now(), participants: [OWNER, FRIEND, OTHER],
    }, line => lines.push(line));
    return lines;
  };
  const close = async () => {
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    await background.waitForIdle('owner');
    turns.close(); peopleStore.close(); store.close();
  };
  return { say, model, calls, sources, close, store, queue };
}

describe('a voice channel of three: anyone may ask for her body', () => {
  it("puts a friend's request on the owner's list with the speaker's name, passes a message to the one running, and takes a friend's stop", async () => {
    const { say, model, calls, sources, queue, close } = world();
    model.intent = { kind: 'task', goal: '鉄の剣を作る' };
    const first = await say('シャノン、鉄の剣を作って', { id: FRIEND, name: 'ユウ' });
    expect(calls.filter(call => call.startsWith('log ') && call.includes('refused'))).toEqual([]);
    expect(first.find(line => line.type === 'intent')).toMatchObject({ kind: 'task', delivered: true, taskId: 'task-1' });
    expect(calls).toContain('task 鉄の剣を作る');
    expect(calls.some(call => call === 'task-1 Discordの通話でのユウの依頼: 鉄の剣を作る')).toBe(true);
    expect(queue.view().entries[0]).toMatchObject({ goal: '鉄の剣を作る', state: 'running', origin: 'voice', askedBy: 'ユウ' });
    // The task stands on a turn the owner can read (the real memory read), written with the friend's name on it.
    expect(sources[0]).toHaveLength(1);
    // A third person asks for a second thing while it is under way: a second entry of the list, named for them.
    model.intent = { kind: 'task', goal: '先にパンを3個作って' };
    const second = await say('シャノン、パンを3個作って', { id: OTHER, name: 'ミキ' });
    expect(second.find(line => line.type === 'intent')).toMatchObject({ kind: 'task', delivered: true });
    expect(queue.view().entries.map(entry => `${entry.goal}:${entry.state}:${entry.askedBy}`)).toEqual(['鉄の剣を作る:running:ユウ', '先にパンを3個作って:queued:ミキ']);
    expect(calls.filter(call => call.startsWith('task '))).toHaveLength(1);
    // Words for the one running (the model says message) reach its task as a message, with the speaker's name.
    model.intent = { kind: 'message', goal: '剣は2本にして' };
    const message = await say('シャノン、剣は2本にして', { id: OTHER, name: 'ミキ' });
    expect(message.find(line => line.type === 'intent')).toMatchObject({ kind: 'task_message', delivered: true, taskId: 'task-1' });
    expect(calls.some(call => call === 'task-1 Discordの通話でのミキの言葉（いまのタスクへ）: 剣は2本にして')).toBe(true);
    // The owner speaks too, by the name, as anyone does.
    model.intent = { kind: 'message', goal: '終わったら家を建てて' };
    await say('シャノン、終わったら家を建てて', { id: OWNER, name: 'ライ氏' });
    expect(calls.some(call => call === 'task-1 Discordの通話でのライ氏の言葉（いまのタスクへ）: 終わったら家を建てて')).toBe(true);
    // A friend's stop stops the body's tasks and the list.
    model.intent = { kind: 'stop', goal: '' };
    const stop = await say('シャノン、止めて', { id: FRIEND, name: 'ユウ' });
    expect(stop.find(line => line.type === 'intent')).toMatchObject({ kind: 'stop', delivered: true });
    expect(calls).toContain('stop task-1 owner_voice_stop');
    expect(queue.view().autoRun).toBe(false);
    await close();
  });

  it("takes a guest's words about the list (hold, resume, move, cancel) as the owner's list operations", async () => {
    const { say, model, queue, close } = world();
    for (const [goal, who] of [['鉄の剣を作る', FRIEND], ['パンを作る', OTHER], ['家を建てる', OWNER]] as const) {
      model.intent = { kind: 'task', goal };
      await say(`シャノン、${goal}`, { id: who, name: who === OWNER ? 'ライ氏' : who === FRIEND ? 'ユウ' : 'ミキ' });
    }
    const states = () => queue.view().entries.map(entry => `${entry.goal}:${entry.state}`);
    expect(states()).toEqual(['鉄の剣を作る:running', 'パンを作る:queued', '家を建てる:queued']);
    model.intent = { kind: 'move', goal: '', target: '#3', placement: 'next' };
    await say('シャノン、家を次にして', { id: OTHER, name: 'ミキ' });
    expect(states()).toEqual(['鉄の剣を作る:running', '家を建てる:queued', 'パンを作る:queued']);
    model.intent = { kind: 'hold', goal: '', target: '#2' };
    await say('シャノン、パンは保留', { id: FRIEND, name: 'ユウ' });
    model.intent = { kind: 'cancel', goal: '', target: '#3' };
    await say('シャノン、家はやめて', { id: OTHER, name: 'ミキ' });
    expect(states()).toEqual(['鉄の剣を作る:running', 'パンを作る:paused']);
    model.intent = { kind: 'resume', goal: '', target: '#2' };
    const resumed = await say('シャノン、パンを再開', { id: FRIEND, name: 'ユウ' });
    expect(resumed.find(line => line.type === 'intent')).toMatchObject({ delivered: true });
    expect(states()).toEqual(['鉄の剣を作る:running', 'パンを作る:queued']);
    await close();
  });

  it('keeps the friend\'s request out of the owner\'s background learning and her memory of the owner', async () => {
    const { say, model, store, close } = world();
    model.intent = { kind: 'task', goal: '鉄の剣を作る' };
    await say('シャノン、鉄の剣を作って', { id: FRIEND, name: 'ユウ' });
    const history = store.experienceCandidates('owner');
    const written = history.filter(item => JSON.stringify(item).includes('ユウ（通話）'));
    expect(written).toHaveLength(1);
    expect(written[0]?.disclosure?.audience).not.toEqual({ kind: 'owner' });
    await close();
  });
});
