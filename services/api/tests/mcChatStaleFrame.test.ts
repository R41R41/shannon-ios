import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody, type MinecraftTurnRequest } from '../src/contracts/minecraftBodyContract.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import { fcaMinecraftRequests, MINECRAFT_REQUEST_CRITERIA } from '../src/wiring/fcaMinecraftRequests.js';
import { BODY_WAKE_MINIMUM_MILLISECONDS, BODY_WAKE_TEXT, fcaMinecraftBodyWake } from '../src/wiring/fcaMinecraftBodyWake.js';
import { forgetAllBodyAbsent, tasksWithoutBody } from '../src/surfaces/minecraft/minecraftBodyAbsent.js';
import { forgetLlmcEvents, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { LLMC_STALE_FRAME_MS, minecraftLlmcLive, minecraftLlmcUrgentLive, createFoodTrend } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { llmcStepParts } from '../src/wiring/minecraftLlmcWiring.js';
import { createFcaHistoryAhead } from '../src/mind/action/fca/fcaHistory.js';
import { minecraftGoalBinding } from '../src/wiring/fcaMinecraftGoalBinding.js';
import { actionHarness } from './support/actionThreadHarness.js';

/**
 * mc-chat-stale-frame (2026-10-26, task 31789a13): a chat request's task was made while the body polled, then the API's one thread was
 * blocked 8 s by source walks; the first decision read the body as gone (`connected: false`) and called `fca_wait`, which the requester
 * could answer, so the task slept until his next words.
 */
const at = '2026-10-26T00:00:00.000Z', stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); forgetAllBodyAbsent(); forgetLlmcEvents(); });

const world = { localMap: 'map', health: 20, food: 20, position: { x: 1, y: 64, z: 2 }, inventory: [], nearbyThreats: [] as unknown[] };
function poll(f: { control: MinecraftControl; now(): number }, sequence: number, extra: { connectionId?: string; world?: Record<string, unknown> } = {}) {
  const now = new Date(f.now()).toISOString();
  return f.control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: extra.connectionId ?? 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence, stateAt: now, receivedAt: now, connected: true,
      state: { world: (extra.world ?? world) as never }, facts: { alive: true } },
    skills: [], candidates: [], receipts: [], activeOperationIds: [] });
}

function fixture() {
  const h = actionHarness(() => at); stops.push(h.close); migrateAgentTasks(h.db);
  let clock = Date.parse(at);
  const authority = new SQLiteFcaTaskAuthority(h.db), runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid: () => true,
    conversationLeaseValid: () => true, provenanceRefs: true });
  const root = runtime.ensureRoot('owner'), state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true });
  const conversation = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world',
    title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const bodyStore = new MinecraftControlStore(h.db), control = new MinecraftControl(bodyStore, configuration,
    { now: () => clock, leaseValid: () => true, ownerAlone: () => true });
  poll({ control, now: () => clock }, 1);
  const lines: string[] = [];
  const api = fcaMinecraftRequests({ runtime, control, conversation, visible, ownerScope: 'owner', ownerAlone: () => true,
    sourceVisible: () => true, stop: async (id, reason) => runtime.stop('owner', id, reason),
    atomic: work => underWriteLock(h.db, null, '', work, 'minecraft_test'), log: line => lines.push(line) });
  const request = { requestId: 'game-one', serverId: 'world', observedAt: at } as MinecraftTurnRequest;
  const wake = fcaMinecraftBodyWake({ control, runtime, ownerScope: 'owner', now: () => clock, log: line => lines.push(line) });
  return { ...h, runtime, authority, state, conversations, root, control, bodyStore, api, request, wake, lines, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
type Fixture = ReturnType<typeof fixture>;

/** The chat request (its task is ready). */
async function chatTask(f: Fixture): Promise<string> {
  const made = (await f.api.intent({ scopeKey: 'owner', request: f.request, experienceId: 'turn-1', intent: { kind: 'task', goal: 'エンドラを討伐して' } }))!;
  return made.request!.id;
}
let leases = 0;
const begin = (f: Fixture, id: string) => {
  const step = f.runtime.beginStep('owner', id, { id: `lease-${++leases}`, holder: 'test', generation: 1 })!;
  expect(step).not.toBeNull();
  return step;
};
/** Its step committed as a wait (the requester can answer, so the wait is accepted, and the task sleeps until a message). */
function sleep(f: Fixture, id: string): void {
  const step = begin(f, id);
  f.runtime.commitStep(step, { disposition: 'wait', history: [], consumedMessageIds: step.messageIds });
  f.runtime.acknowledgeReceipt('owner', step.id);
  expect(f.runtime.get('owner', id)?.phase).toBe('waiting');
}
const chatTaskAsleep = async (f: Fixture): Promise<string> => { const id = await chatTask(f); sleep(f, id); return id; };

describe('a decision reads the body a few seconds old, and is told how old', () => {
  it('seen: the current frame, an older connected one up to the limit with its age, and nothing past it', () => {
    const f = fixture();
    expect(f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS)).toMatchObject({ ageMs: 0, current: true });
    f.advance(8_000);
    expect(f.control.frame('minecraft:world')).toBeNull(); // a command needs 3 s
    expect(f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS)).toMatchObject({ ageMs: 8_000, current: false });
    f.advance(7_000);
    expect(f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS)).toMatchObject({ ageMs: 15_000, current: false });
    f.advance(1);
    expect(f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS)).toBeNull();
  });

  const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
    toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
  const lifecycle = (f: Fixture, taskId: string) => withLlmcBody(inner, { llmc: { plan: () => undefined, planView: () => null }, taskId, createdAt: at,
    now: f.now, observe: () => f.control.observe('minecraft:world'), seen: () => f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS),
    arrival: () => ({ at: null, kind: null }), r4: { probe: () => null, planWhere: () => null } });

  it('8 s after the last poll the live is her state with a line saying how long ago, not connected: false', () => {
    const f = fixture(), body = lifecycle(f, 'stale-8');
    body.context();
    expect(body.transient!()).not.toHaveProperty('bodyAge'); // a current frame: as before
    f.advance(8_000);
    body.context();
    const live = body.transient!() as Record<string, unknown>;
    expect(live).not.toHaveProperty('connected');
    expect(live.map).toBe('map');
    expect(live.bodyAge).toBe('体の様子は 8 秒前のもの（新しい観測がまだ届いていない。位置や敵はもう動いているかもしれない）');
    expect(tasksWithoutBody()).toEqual([]);
  });

  it('past 15 s only connected: false is said, and the task is noted as one that met no body', () => {
    const f = fixture(), body = lifecycle(f, 'gone-16');
    f.advance(16_000);
    body.context();
    expect(body.transient!()).toMatchObject({ connected: false });
    expect(tasksWithoutBody()).toEqual(['gone-16']);
    poll(f, 2);
    body.context();
    expect(body.transient!()).not.toHaveProperty('connected');
    expect(tasksWithoutBody()).toEqual([]); // a decision that finds the body clears the note
  });

  it('an urgent decision on an old picture says its age too, and its commands still need a current frame', () => {
    const f = fixture();
    poll(f, 2, { world: { ...world, nearbyThreats: [{ name: 'zombie', id: 7, distance: 4, position: { x: 3, y: 64, z: 2 } }] } });
    f.advance(6_000);
    const live = minecraftLlmcUrgentLive({ observation: f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS)!.observation, elapsedMinutes: 1, events: [],
      urgent: ['zombie 4m'], bodyAge: '体の様子は 6 秒前のもの', planNowTitle: null, answer: 'a' });
    expect(live.bodyAge).toBe('体の様子は 6 秒前のもの');
    expect(live).toHaveProperty('map');
    expect(minecraftLlmcUrgentLive({ observation: null, elapsedMinutes: 1, events: [], answer: 'a', planNowTitle: null })).toMatchObject({ connected: false });
    expect(f.control.observe('minecraft:world')).toBeNull();
  });

  it('the live of the mode keeps the line first after the urgent lines, whatever the bound', () => {
    const f = fixture(), frame = f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS)!.observation as BodyObservation;
    const live = minecraftLlmcLive({ observation: frame, elapsedMinutes: 1, trend: createFoodTrend(), events: [], bodyAge: '体の様子は 9 秒前のもの' });
    expect(Object.keys(live).slice(0, 2)).toEqual(['bodyAge', 'map']);
  });
});

describe('the chat request of 2026-10-25 03:23, with the stall', () => {
  it('is admitted on a frame 10 s old (the body polled before the stall), and refused only past 15 s', async () => {
    const f = fixture();
    f.advance(10_000);
    expect(f.api.admission({ scopeKey: 'owner', request: f.request })).toBeNull();
    f.advance(6_000);
    expect(f.api.admission({ scopeKey: 'owner', request: f.request })).toBe('body_unavailable');
  });

  it('the step parts of the mode hand a decision the old frame', async () => {
    const f = fixture(), id = await chatTask(f), step = begin(f, id);
    const llmc = { names: { main: 'm', escalate: null, plan: 'p' }, models: { main: {} as never, escalate: null }, summarizer: null, policy: {},
      historyAhead: createFcaHistoryAhead() };
    const parts = llmcStepParts(llmc as never, step, f.control, () => undefined);
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    const body = parts.wrap(inner as never);
    f.advance(9_000);
    body.context();
    expect(body.transient!()).toMatchObject({ map: 'map', bodyAge: expect.stringContaining('9 秒前') });
    f.advance(7_000);
    body.context();
    expect(body.transient!()).toMatchObject({ connected: false });
  });
});

describe('a task that slept for a body that was not there is woken once when it is', () => {
  const absentDecision = (f: Fixture, taskId: string) => {
    // What the decision's context does when it finds no body.
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    withLlmcBody(inner, { llmc: { plan: () => undefined, planView: () => null }, taskId, createdAt: at, now: f.now,
      observe: () => f.control.observe('minecraft:world'), seen: () => f.control.seen('minecraft:world', LLMC_STALE_FRAME_MS),
      arrival: () => ({ at: null, kind: null }), r4: { probe: () => null, planWhere: () => null } }).context();
  };

  it('gives the sleeping task one message when its body has a current frame again, and not again for the same wait', async () => {
    const f = fixture(), id = await chatTaskAsleep(f);
    f.advance(20_000);
    absentDecision(f, id);
    expect(tasksWithoutBody()).toEqual([id]);
    expect(f.wake.tick()).toBe(0); // no frame: nothing wakes, and no decision is spent on a body that is not there
    expect(f.runtime.get('owner', id)?.phase).toBe('waiting');
    poll(f, 2);
    expect(f.wake.tick()).toBe(1);
    expect(f.runtime.get('owner', id)?.phase).toBe('ready');
    expect(f.runtime.snapshot('owner', id)!.messages.map(message => message.text)).toContain(BODY_WAKE_TEXT);
    expect(f.lines).toContain(`Shannon Minecraft body wake task=${id}`);
    expect(tasksWithoutBody()).toEqual([]);
    expect(f.wake.tick()).toBe(0);
    expect(f.runtime.snapshot('owner', id)!.messages.filter(message => message.text === BODY_WAKE_TEXT)).toHaveLength(1);
  });

  it('leaves alone a task whose decision found its body, one that is not asleep, and one that ended', async () => {
    const f = fixture(), id = await chatTaskAsleep(f);
    expect(f.wake.tick()).toBe(0); // never noted: it waits for something else
    expect(f.runtime.get('owner', id)?.phase).toBe('waiting');
    f.advance(20_000);
    absentDecision(f, id);
    f.runtime.stop('owner', id, 'owner_game_stop');
    poll(f, 2);
    expect(f.wake.tick()).toBe(0);
    expect(tasksWithoutBody()).toEqual([]); // an ended task is forgotten
  });

  it('a body that comes and goes wakes the same task at most once in half a minute', async () => {
    const f = fixture(), id = await chatTaskAsleep(f);
    f.advance(20_000);
    absentDecision(f, id);
    poll(f, 2);
    expect(f.wake.tick()).toBe(1);
    // It decides, finds no body again (the body went again) and waits again at once.
    sleep(f, id);
    f.advance(20_000);
    absentDecision(f, id);
    poll(f, 3);
    expect(f.wake.tick()).toBe(0);
    f.advance(BODY_WAKE_MINIMUM_MILLISECONDS);
    poll(f, 4);
    expect(f.wake.tick()).toBe(1);
  });

  it('a task without an origin to name is skipped with a line, not woken blind', async () => {
    const f = fixture();
    const task = f.runtime.createChild('owner', f.root.id, { title: 'op', goal: 'op', completionCriteria: MINECRAFT_REQUEST_CRITERIA }, 'operator:1', { sources: 'asking' });
    expect(f.bodyStore.bind(task.id, 'minecraft:world')).toBe(true);
    sleep(f, task.id);
    f.advance(20_000);
    absentDecision(f, task.id);
    poll(f, 2);
    expect(f.wake.tick()).toBe(0);
    expect(f.lines).toContain(`Shannon Minecraft body wake skipped task=${task.id} reason=no_origin`);
  });
});

const said = (f: Fixture, text: string) => f.conversations.appendTurn('owner', 'platform:minecraft:world', text, 'はい', at).id;

describe('finding the open request does not walk the provenance of every task ever bound to the body (31 walks, 8 s of the thread)', () => {
  function counting(f: Fixture) {
    const asked: string[] = [];
    const real = createFcaSourceGuard({ runtime: f.runtime, state: f.state, conversations: f.conversations, ownerScope: 'owner', ownerAlone: () => true });
    const visible = Object.assign((scope: string, id: string, pending?: string, via?: never) => { asked.push(id); return real(scope, id, pending, via); }, real);
    const conversation = createFcaConversationBridge({ runtime: f.runtime, ownerScope: 'owner', visible });
    const api = fcaMinecraftRequests({ runtime: f.runtime, control: f.control, conversation, visible, ownerScope: 'owner', ownerAlone: () => true,
      sourceVisible: () => true, stop: async (id, reason) => f.runtime.stop('owner', id, reason),
      atomic: work => underWriteLock(f.db, null, '', work, 'minecraft_test') });
    return { api, asked };
  }
  /** Old runs bound to the body, as production had (48): completed or stopped. */
  function history(f: Fixture, count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const task = f.runtime.createChild('owner', f.root.id, { title: `old ${i}`, goal: `old ${i}`, completionCriteria: MINECRAFT_REQUEST_CRITERIA }, `old-${i}`);
      expect(f.bodyStore.bind(task.id, 'minecraft:world')).toBe(true);
      if (i % 2 === 0) f.authority.event('owner', task.id, 'test_completed', at, { status: 'completed' });
      else f.runtime.stop('owner', task.id, 'test_stopped');
      ids.push(task.id);
    }
    return ids;
  }

  it('a chat request asks the source guard of no ended task, and still makes its task', async () => {
    const f = fixture(), old = history(f, 12), { api, asked } = counting(f);
    const made = (await api.intent({ scopeKey: 'owner', request: f.request, experienceId: said(f, 'エンドラを倒して'), intent: { kind: 'task', goal: 'エンドラを倒して' } }))!;
    expect(made.request?.id).toBeDefined();
    expect(asked.filter(id => old.includes(id))).toEqual([]);
  });

  it('with a request under way, only that request is asked, and the words reach it as a message', async () => {
    const f = fixture(), old = history(f, 12), { api, asked } = counting(f);
    const first = (await api.intent({ scopeKey: 'owner', request: f.request, experienceId: said(f, 'エンドラを倒して'), intent: { kind: 'task', goal: 'エンドラを倒して' } }))!;
    asked.length = 0;
    const again = (await api.intent({ scopeKey: 'owner', request: { ...f.request, requestId: 'game-two' }, experienceId: said(f, '続けて'),
      intent: { kind: 'task', goal: '続けて' } }))!;
    expect(again.request?.id).toBe(first.request?.id);
    expect([...new Set(asked)]).toEqual([first.request!.id]);
    expect(asked.filter(id => old.includes(id))).toEqual([]);
  });

  it('a stop still stops the task that runs, and passes over the ended', async () => {
    const f = fixture(), old = history(f, 6), { api, asked } = counting(f);
    const made = (await api.intent({ scopeKey: 'owner', request: f.request, experienceId: said(f, 'エンドラを倒して'), intent: { kind: 'task', goal: 'エンドラを倒して' } }))!;
    asked.length = 0;
    await api.intent({ scopeKey: 'owner', request: { ...f.request, requestId: 'game-stop' }, experienceId: said(f, '止めて'), intent: { kind: 'stop', goal: '' } });
    expect(f.runtime.get('owner', made.request!.id)?.phase).toBe('stopped');
    expect(asked.filter(id => old.includes(id))).toEqual([]);
  });
});

describe('the task keeps his words when they are a dragon request (the model rewrote them in the task of 2026-10-25)', () => {
  const rewritten = 'エンダードラゴンを倒すため、装備や食料などを整えてエンドへ向かい、討伐を進める';
  const task = (f: Fixture, id: string) => f.runtime.get('owner', id)!;

  it.each(['エンドラを討伐して', 'マイクラでエンドラを討伐して', 'エンドラ討伐して'])('%s: the goal is what he said, so the dragon evidence binds', async words => {
    const f = fixture();
    const made = (await f.api.intent({ scopeKey: 'owner', request: { ...f.request, message: words }, experienceId: said(f, words),
      intent: { kind: 'task', goal: rewritten } }))!;
    expect(made.goal).toBe(words);
    const row = task(f, made.request!.id);
    expect(row.goal).toBe(words);
    expect(minecraftGoalBinding({ scopeKey: 'owner', id: row.id, goal: row.goal, completionCriteria: row.completionCriteria }, 'minecraft:world')).toBeDefined();
    expect(f.runtime.snapshot('owner', row.id)!.messages.map(message => message.text)).toContain(`ゲーム内の本人の依頼: ${words}`);
  });

  it('a message to the task under way is his words too, and another request keeps the goal of the model', async () => {
    const f = fixture();
    const first = (await f.api.intent({ scopeKey: 'owner', request: { ...f.request, message: 'エンドラを討伐して' }, experienceId: said(f, 'エンドラを討伐して'),
      intent: { kind: 'task', goal: rewritten } }))!;
    const again = (await f.api.intent({ scopeKey: 'owner', request: { ...f.request, requestId: 'game-two', message: 'エンドラ討伐して' },
      experienceId: said(f, 'エンドラ討伐して'), intent: { kind: 'task', goal: '続ける' } }))!;
    expect(again.request?.id).toBe(first.request?.id);
    expect(f.runtime.snapshot('owner', first.request!.id)!.messages.map(message => message.text)).toContain('ゲーム内の本人の言葉（いまのタスクへ）: エンドラ討伐して');
    f.runtime.stop('owner', first.request!.id, 'test');
    const other = (await f.api.intent({ scopeKey: 'owner', request: { ...f.request, requestId: 'game-three', message: '羊毛を集めてベッドを作って' },
      experienceId: said(f, '羊毛'), intent: { kind: 'task', goal: '羊毛を集めてベッドを作る' } }))!;
    expect(task(f, other.request!.id).goal).toBe('羊毛を集めてベッドを作る');
    const compound = (await f.api.intent({ scopeKey: 'owner', request: { ...f.request, requestId: 'game-four', message: 'エンドラを倒す前に畑を作って' },
      experienceId: said(f, '畑'), intent: { kind: 'task', goal: '畑を作ってからエンドラを倒す' } }))!;
    expect(compound.goal).toBe('畑を作ってからエンドラを倒す');
  });
});
