import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { createFcaVoiceBridge } from '../src/mind/action/fca/fcaVoicePorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { createLiveVoiceStreamRoute } from '../src/surfaces/voice/serverLiveVoiceStreamRoute.js';
import type { ShannonApiKernel } from '../src/infra/http/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import type { ShannonDevicePrincipal } from '../src/infra/auth/deviceAuth.js';

const at = '2026-10-09T00:00:00.000Z', cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const text = 'シャノン、この情報についてどう思う？', raw = 'シャノン、このじょうほうについてどう思う？';
const reply = 'まず資料を確認します。結果はあとで伝えます。';
const spec = { title: 'Research', goal: 'Verify public source', completionCriteria: 'Verified public source' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(options: { fail?: boolean; pause?: ReturnType<typeof deferred>; reliability?: number; disabled?: boolean } = {}) {
  const h = actionHarness(() => at); cleanup.push(h.close); migrateAgentTasks(h.db);
  const authority = new SQLiteFcaTaskAuthority(h.db);
  const makeRuntime = () => new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid: () => false,
    conversationLeaseValid(scope, lease) { const action = h.store.check(lease, at); return action?.scopeKey === scope && action.kind === 'respond'; } });
  let runtime = makeRuntime(), alone = true;
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const thread = conversations.threadId('owner'), service = createInMemoryAutonomyService(() => at), tools = service.tools;
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => alone });
  const bridge = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
  let voice = createFcaVoiceBridge({ conversation: bridge, runtime, conversations, ownerScope: 'owner', ownerAlone: () => alone });
  tools.useTaskRuntime({ available: scope => bridge.taskToolsAvailable(scope), execute: (name, input, context) => bridge.executeTaskTool(name, input, context),
    observeRead: (scope, receipt) => { bridge.observeRead(scope, receipt); } });
  let calls = 0, decisions = 0, turns = 0, children: string[] = [], offered: string[][] = [], contexts: string[] = [];
  const generate = async (request: ShannonChatModelRequest | ShannonVoiceModelRequest, delta?: (text: string) => void | Promise<void>) => {
    calls++; offered.push(request.tools?.definitions.map(tool => tool.name) ?? []); contexts.push(request.turnContext ?? '');
    if (request.tools?.definitions.some(tool => tool.name === 'task.create')) {
      const result = JSON.parse(await request.tools.call('task_create', JSON.stringify(spec))) as { ok: boolean; text: string };
      expect(result.ok).toBe(true); children.push(JSON.parse(result.text).id);
    }
    await delta?.('まず資料を確認します。');
    await options.pause?.promise;
    if (options.fail) throw new Error('generation_interrupted');
    await delta?.('結果はあとで伝えます。');
    return { mode: 'local-stub' as const, model: 'fixture', reply };
  };
  const model: ShannonChatModel = { mode: 'local-stub', model: 'fixture', generate,
    generateVoice: request => generate(request), generateVoiceStreaming: (request, delta) => generate(request, delta) };
  const local = new LocalVoiceDecisionGateway();
  const kernel = createLocalApiKernel(() => at, { stateStore: state, conversationStore: conversations, autonomy: service, chatModel: model,
    ...(options.disabled ? {} : { fcaVoice: () => voice }), voiceDecision: { mode: 'fallback', model: 'fixture', async decide(input) {
      decisions++; return { ...await local.decide(input), transcriptReliabilityProbability: options.reliability ?? 1 };
    } } });
  const foreground = async <T>(work: () => Promise<T>) => {
    const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `voice-${++turns}` }))!;
    const lease = leaseOf(action);
    try { const value = await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease) }, work);
      await h.actions.finish(lease, 'completed', 'responded'); return value;
    } catch (error) { await h.actions.finish(lease, 'unknown', 'response_interrupted'); throw error; }
  };
  const body = (id = 'utterance-1', overrides: Record<string, unknown> = {}) => ({ scopeKey: 'owner', threadId: thread, transcript: text, participantMode: 'owner',
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, userUtterance: { id, text, source: 'speech', rawText: raw, historyReceipt: 'utterance-id' } }, ...overrides });
  const turn = (id = 'utterance-1', overrides: Record<string, unknown> = {}) => foreground(() => kernel.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', deviceId: 'device-1', body: body(id, overrides) }));
  const stored = (overrides: Record<string, unknown> = {}, deviceId = 'device-1') => kernel.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', deviceId,
    body: { scopeKey: 'owner', threadId: thread, utteranceId: 'utterance-1', userTranscript: raw, shannonTranscript: reply, ...overrides } });
  cleanup.push(() => kernel.waitForBackground('owner'));
  return { ...h, runtime: () => runtime, state, conversations, thread, bridge, visible, kernel, body, turn, stored, foreground,
    calls: () => calls, decisions: () => decisions, children: () => children, offered: () => offered, contexts: () => contexts,
    alone(value: boolean) { alone = value; }, restart() { runtime = makeRuntime(); voice = createFcaVoiceBridge({ conversation: bridge, runtime, conversations, ownerScope: 'owner', ownerAlone: () => alone }); } };
}

describe('FCA voice uses existing sentence and visible-history delivery', () => {
  it('streams the first sentence before completion and binds only after the correlated canonical history write', async () => {
    const pause = deferred(), f = fixture({ pause }); let output = '';
    const request = Readable.from([JSON.stringify(f.body())]) as IncomingMessage; request.method = 'POST';
    const first = deferred();
    const response = Object.assign(new EventEmitter(), { headersSent: false, writeHead() { this.headersSent = true; return this; },
      write(value: string) { output += value; if (value.includes('まず資料を確認します')) first.resolve(); return true; }, end() {} }) as unknown as ServerResponse;
    const routeKernel = { streamLiveVoiceDelegation: (request: Parameters<ShannonApiKernel['streamLiveVoiceDelegation']>[0], observer: Parameters<ShannonApiKernel['streamLiveVoiceDelegation']>[1]) =>
      f.foreground(() => f.kernel.streamLiveVoiceDelegation(request, observer)) } as ShannonApiKernel;
    const running = createLiveVoiceStreamRoute(routeKernel, () => true)(request, response, { scopeKey: 'owner', deviceId: 'device-1' } as ShannonDevicePrincipal);
    await Promise.race([first.promise, running.then(() => { throw new Error(`Stream ended before first sentence: ${output}`); })]);
    expect(output).not.toContain('"type":"completed"'); expect(f.runtime().readyTasks('owner')).toEqual([]);
    expect(f.conversations.conversationHistory('owner', f.thread)).toEqual([]);
    pause.resolve(); await running;
    expect(output).toContain('"type":"completed"'); expect(f.calls()).toBe(1); expect(f.children()).toHaveLength(1);
    expect(f.runtime().conversationDelivery('owner', f.thread, 'utterance-1')?.state).toBe('staged');
    expect(f.runtime().readyTasks('owner')).toEqual([]);
    const receipt = await f.stored(); expect(receipt.status).toBe(201);
    expect(f.runtime().readyTasks('owner').map(task => task.id)).toEqual(f.children());
    expect(f.runtime().conversationDelivery('owner', f.thread, 'utterance-1')?.state).toBe('bound');
    expect(f.runtime().pendingReceipts('owner')).toEqual([]);
  });

  it('deduplicates confirmed input before router/model after restart, and deduplicates the history receipt', async () => {
    const f = fixture(); expect((await f.turn()).status).toBe(200); f.restart();
    expect((await f.turn()).status).toBe(409); expect(f.calls()).toBe(1); expect(f.decisions()).toBe(1); expect(f.children()).toHaveLength(1);
    const first = await f.stored(), second = await f.stored();
    expect((first.body as { turnId: string }).turnId).toBe((second.body as { turnId: string }).turnId);
    expect(f.conversations.conversationHistory('owner', f.thread)).toHaveLength(2);
  });

  it('reserves only rendered inbox reports while history is pending and never clears a newer active turn when binding', async () => {
    const f = fixture();
    await f.foreground(async () => {
      const turn = f.bridge.begin({ scopeKey: 'owner', threadId: f.thread, observedAt: at, recalledMemoryIds: [], ownerAlone: () => true })!;
      turn.commit(f.conversations.appendTurn('owner', f.thread, 'Earlier question', 'Earlier answer', at).id);
    });
    const task = f.runtime().list('owner').find(task => task.kind === 'conversation')!;
    f.runtime().send('owner', f.runtime().ensureRoot('owner').id, task.id, 'Verified research result', 'report-1');
    await f.turn();
    expect(f.contexts()[0]).toContain('Verified research result');
    expect(f.runtime().snapshot('owner', task.id)?.messages).toEqual([]);
    expect(f.db.prepare('SELECT consumed_by FROM fca_task_messages WHERE message_id=?').get('report-1')?.consumed_by).toBeNull();
    await f.foreground(async () => {
      const newer = f.bridge.begin({ scopeKey: 'owner', threadId: f.thread, observedAt: at, recalledMemoryIds: [], ownerAlone: () => true })!;
      expect(newer.context()).toBe('');
      await f.stored();
      expect(f.bridge.taskToolsAvailable('owner')).toBe(true);
      expect(f.db.prepare('SELECT consumed_by FROM fca_task_messages WHERE message_id=?').get('report-1')?.consumed_by).toBeTruthy();
      newer.abort();
    });
  });

  it('rolls source and conversation admission back if its durable input receipt cannot be written', async () => {
    const f = fixture();
    f.db.exec("CREATE TEMP TRIGGER reject_voice_receipt BEFORE INSERT ON fca_conversation_deliveries BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
    await expect(f.turn()).rejects.toThrow('receipt unavailable');
    expect(f.calls()).toBe(0); expect(f.children()).toEqual([]);
    expect(f.runtime().list('owner').map(task => task.kind)).toEqual(['root']);
    expect(f.db.prepare('SELECT * FROM fca_task_sources').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM fca_conversation_deliveries').all()).toEqual([]);
  });

  it('does not bind a mismatched device, raw input, scope, thread or companion receipt', async () => {
    const f = fixture(); await f.turn();
    await f.stored({}, 'other-device'); await f.stored({ userTranscript: 'different original input' });
    await f.stored({ scopeKey: 'other-owner' }); await f.stored({ threadId: 'different-thread' }); await f.stored({ companionPresent: true });
    expect(f.runtime().conversationDelivery('owner', f.thread, 'utterance-1')?.state).toBe('staged');
    expect(f.runtime().readyTasks('owner')).toEqual([]);
    await f.stored(); expect(f.runtime().readyTasks('owner')).toHaveLength(1);
  });

  it('keeps an actually played interrupted prefix as history while failed-generation descendants stay stopped', async () => {
    const f = fixture({ fail: true }), deltas: string[] = [];
    await expect(f.foreground(() => f.kernel.streamLiveVoiceDelegation({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', deviceId: 'device-1', body: f.body() },
      { onPlan() {}, onTextDelta(text) { deltas.push(text); } }))).rejects.toThrow('generation_interrupted');
    expect(deltas).toEqual(['まず資料を確認します。']);
    await f.stored({ shannonTranscript: 'まず資料を確認します。…' });
    expect(f.conversations.conversationHistory('owner', f.thread).at(-1)?.content).toBe('まず資料を確認します。…');
    expect(f.runtime().get('owner', f.children()[0]!)?.phase).toBe('stopped');
    expect(f.runtime().conversationDelivery('owner', f.thread, 'utterance-1')?.state).toBe('failed');
    expect(f.calls()).toBe(1); expect(f.runtime().readyTasks('owner')).toEqual([]);
  });

  it('keeps old clients, uncertain speech, guests, and OFF outside task attachment', async () => {
    for (const mode of ['old', 'uncertain', 'guest', 'off'] as const) {
      const f = fixture({ reliability: mode === 'uncertain' ? 0.1 : 1, disabled: mode === 'off' });
      const overrides = mode === 'guest' ? { participantMode: 'guest' } : mode === 'old'
        ? { deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, userUtterance: { id: 'utterance-1', text, rawText: raw, source: 'speech' } } } : {};
      expect((await f.turn('utterance-1', overrides)).status).toBe(200);
      expect(f.children(), mode).toEqual([]); expect(f.runtime().conversationDelivery('owner', f.thread, 'utterance-1'), mode).toBeNull();
      expect(f.offered().flat().includes('task.create'), mode).toBe(false);
    }
  });

  it('keeps ordinary voice after root stop and withholds forgotten sources after a valid receipt', async () => {
    const stopped = fixture(); stopped.runtime().stop('owner', stopped.runtime().ensureRoot('owner').id, 'owner_stop');
    expect((await stopped.turn()).status).toBe(200); expect(stopped.calls()).toBe(1); expect(stopped.children()).toEqual([]);
    const f = fixture(); await f.turn(); const receipt = await f.stored();
    const id = (receipt.body as { turnId: string }).turnId;
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
    expect(f.visible('owner', f.children()[0]!)).toBe(false);
  });
});
