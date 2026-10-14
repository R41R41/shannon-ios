import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { fcaProductionShape } from './support/fcaProductionShape.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { createFcaConversationBridge, createFcaSourceGuard, type FcaConversationPort } from '../src/mind/action/fca/fcaConversationPorts.js';
import { FCA_CAPPED_REPORT, FCA_PROVENANCE_LIMITS } from '../src/mind/action/fca/fcaConversationSources.js';
import { createFcaVoiceBridge } from '../src/mind/action/fca/fcaVoicePorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import type { FcaToolSelector } from '../src/mind/selectors/selectorsPorts.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import type { TaskSource } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * Review of c35c9458: a turn whose task context closed on its budget must still answer as an ordinary conversation (the tool
 * selection that follows used to throw and fail the turn), and a conversation task must never be cut off by the provenance cap.
 */
const at = '2026-10-12T14:00:00.000Z', cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

function fixture() {
  const h = actionHarness(() => at); cleanup.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at, leaseValid: () => false,
    conversationLeaseValid(scope, lease) { const action = h.store.check(lease, at); return action?.scopeKey === scope && action.kind === 'respond'; } });
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const thread = conversations.threadId('owner'), service = createInMemoryAutonomyService(() => at), tools = service.tools;
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true });
  let selections = 0, selectToolsCalls = 0;
  const selector: FcaToolSelector = { async select(request) { selections++; return { names: request.tools.map(tool => tool.name), source: 'jev' }; } };
  // Every provenance check is over budget: the turn's task context closes at its first check.
  const inner = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible, selector, budgetMs: -1 });
  const bridge: FcaConversationPort = { ...inner, begin(input) {
    const turn = inner.begin(input);
    const select = turn?.selectTools;
    return turn && select ? { ...turn, selectTools: (offer, details) => { selectToolsCalls++; return select(offer, details); } } : turn;
  } };
  const voice = createFcaVoiceBridge({ conversation: bridge, runtime, conversations, ownerScope: 'owner', ownerAlone: () => true });
  tools.useTaskRuntime({ available: scope => bridge.taskToolsAvailable(scope), execute: (name, input, context) => bridge.executeTaskTool(name, input, context) });
  const requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  const generate = async (request: ShannonChatModelRequest | ShannonVoiceModelRequest, delta?: (text: string) => void | Promise<void>) => {
    requests.push(request); await delta?.('はい、ライ氏。');
    return { mode: 'local-stub' as const, model: 'fixture', reply: 'はい、ライ氏。' };
  };
  const model: ShannonChatModel = { mode: 'local-stub', model: 'fixture', generate,
    generateVoice: request => generate(request), generateVoiceStreaming: (request, delta) => generate(request, delta) };
  const local = new LocalVoiceDecisionGateway();
  const kernel = createLocalApiKernel(() => at, { stateStore: state, conversationStore: conversations, autonomy: service, chatModel: model,
    fcaConversation: () => bridge, fcaVoice: () => voice,
    voiceDecision: { mode: 'fallback', model: 'fixture', async decide(input) { return { ...await local.decide(input), transcriptReliabilityProbability: 1 }; } } });
  cleanup.push(() => kernel.waitForBackground('owner'));
  let turns = 0;
  const foreground = async <T>(work: () => Promise<T>) => {
    const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${++turns}` }))!;
    const lease = leaseOf(action);
    try { return await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease) }, work); }
    finally { await h.actions.finish(lease, 'completed', 'responded'); }
  };
  return { kernel, thread, foreground, requests, selections: () => selections, selectToolsCalls: () => selectToolsCalls };
}

describe('a turn whose task context closed on its budget', () => {
  it('answers a voice turn as an ordinary reply, its tool selection keeping the offer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const transcript = 'ボクの書斎のメモを見て、続きを考えて';
    const response = await f.foreground(() => f.kernel.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', deviceId: 'device-1', body: {
      scopeKey: 'owner', threadId: f.thread, transcript, participantMode: 'owner',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, userUtterance: { id: 'utterance-1', text: transcript, source: 'speech', rawText: transcript, historyReceipt: 'utterance-id' } },
    } }));
    expect(response).toMatchObject({ status: 200, body: { reply: 'はい、ライ氏。' } });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.tools?.definitions.some(tool => tool.domain === 'task_runtime') ?? false).toBe(false);
    expect(f.selectToolsCalls()).toBeGreaterThan(0); // The selection ran, and returned the offer instead of failing the turn.
    expect(f.selections()).toBe(0);
  });

  it('answers a text turn as an ordinary reply, its tool selection keeping the offer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    const response = await f.foreground(() => f.kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: f.thread, message: '書斎のメモを見て、続きを考えて' } }));
    expect(response).toMatchObject({ status: 200 });
    expect((response.body as { reply: string }).reply).toBe('はい、ライ氏。');
    expect(f.requests).toHaveLength(1);
    expect(f.selectToolsCalls()).toBeGreaterThan(0);
    expect(f.selections()).toBe(0);
  });
});

describe('the provenance cap', () => {
  const many = (count: number, observedAt: string): TaskSource[] => [{ kind: 'memory', stepId: 'memory:many', experienceId: null, threadId: null, observedAt,
    recalledMemoryIds: Array.from({ length: count }, (_, index) => `memory-${index}`) }];

  it('never cuts off the owner\'s conversation task', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fcaProductionShape({ experiences: 60, turns: 2, children: 1, messages: 1 }); cleanup.push(() => f.close());
    const conversation = await f.build();
    const task = f.runtime.get('owner', conversation)!;
    expect(task.kind).toBe('conversation');
    f.visible.sources('owner', task, many(FCA_PROVENANCE_LIMITS.recalledIds + 1, f.world.now()));
    await new Promise(resolve => setImmediate(resolve));
    expect(warn.mock.calls.some(([line]) => String(line).includes('fca_provenance_capped'))).toBe(false);
    expect(f.runtime.get('owner', conversation)!.phase).not.toBe('stopped');
  }, 60_000);

  const spread = (ids: readonly string[], sources: number, observedAt: string): TaskSource[] => Array.from({ length: sources }, (_, index) => ({
    kind: 'memory' as const, stepId: `memory:spread-${index}`, experienceId: null, threadId: null, observedAt, recalledMemoryIds: [ids[100 + index]!] }));

  it('never hides or stops the root or the sleep task, however much provenance they carry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fcaProductionShape({ experiences: 300, turns: 2, children: 1, messages: 0 }); cleanup.push(() => f.close());
    await f.build();
    const root = f.runtime.ensureRoot('owner');
    const over = spread(f.ids, FCA_PROVENANCE_LIMITS.sources + 1, f.world.now());
    expect(f.visible.sources('owner', root, over)).toBe(true);
    expect(f.visible.sources('owner', { ...root, kind: 'sleep', origin: 'maintenance' }, over)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(warn.mock.calls.some(([line]) => String(line).includes('fca_provenance_capped'))).toBe(false);
    expect(['stopped', 'stopping']).not.toContain(f.runtime.get('owner', root.id)!.phase);
    expect(['stopped', 'stopping']).not.toContain(f.runtime.get('owner', f.children[0]!)!.phase);
  }, 60_000);

  it('stops a capped research task even when its parent cannot take the report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fcaProductionShape({ experiences: 300, turns: 2, children: 1, messages: 0 }); cleanup.push(() => f.close());
    await f.build();
    const child = f.runtime.get('owner', f.children[0]!)!;
    vi.spyOn(f.runtime, 'send').mockImplementation(() => { throw new Error('FCA_MAINTENANCE_INPUT'); }); // As a maintenance parent answers.
    // Memory rows alone no longer reach the source cap (they are folded, `fcaProvenanceForCheck`); the id cap still stops.
    expect(f.visible.sources('owner', child, many(FCA_PROVENANCE_LIMITS.recalledIds + 1, f.world.now()))).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(['stopped', 'stopping']).toContain(f.runtime.get('owner', child.id)!.phase);
    expect(warn.mock.calls.some(([line]) => String(line).includes('code=fca_capped_report_failed'))).toBe(true);
  }, 60_000);

  it('stops a capped research task once and tells its parent in fixed words', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fcaProductionShape({ experiences: 60, turns: 2, children: 1, messages: 0 }); cleanup.push(() => f.close());
    const conversation = await f.build();
    const child = f.runtime.get('owner', f.children[0]!)!;
    for (let check = 0; check < 3; check++) expect(f.visible.sources('owner', child, many(FCA_PROVENANCE_LIMITS.recalledIds + 1, f.world.now()))).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(['stopped', 'stopping']).toContain(f.runtime.get('owner', child.id)!.phase);
    const reports = f.runtime.snapshot('owner', conversation)!.messages.filter(message => message.text === FCA_CAPPED_REPORT);
    expect(reports).toHaveLength(1);
  }, 60_000);
});
