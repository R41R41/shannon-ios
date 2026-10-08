import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { createFcaConversationBridge, createFcaSourceGuard, conversationFcaProvenance, type FcaConversationPort } from '../src/mind/action/fca/fcaConversationPorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { ToolResult } from '../src/mind/tools/toolRegistryPorts.js';
import type { ShannonChatModel } from '../src/infra/models/chatModel.js';
import type { ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import type { FcaToolSelector } from '../src/mind/selectors/selectorsPorts.js';
import { baseToolSession, withToolMenu } from '../src/mind/tools/toolsPorts.js';
import { TASK_TOOLS } from '../src/mind/tools/toolRunnerPorts.js';
import { TurnDeadline, TEXT_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';

const at = '2026-10-09T00:00:00.000Z', cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const spec = { title: 'Public research', goal: 'Find a public source', completionCriteria: 'Source verified', context: 'Public information only' };
const parsed = (result: ToolResult) => { expect(result.ok).toBe(true); return JSON.parse(result.text) as { id: string; childIds: string[] }; };
function fixture(selector?: FcaToolSelector) {
  const h = actionHarness(() => at); cleanups.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: () => at,
    leaseValid: () => false, conversationLeaseValid(scope, lease) {
      const action = h.store.check(lease, at); return action?.scopeKey === scope && action.kind === 'respond' && action.origin === 'owner_request';
    } });
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const thread = conversations.threadId('owner'); let alone = true;
  const readSources = new Map<string, boolean>();
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => alone,
    readSourceVisible: (_scope, id) => readSources.get(id) === true });
  const bridge = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible, selector });
  let turns = 0;
  const foreground = async <T>(work: () => Promise<T>) => {
    const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${++turns}` }))!;
    const lease = leaseOf(action);
    try { return await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease) }, work); }
    finally { await h.actions.finish(lease, 'completed', 'responded'); }
  };
  const begin = (recalledMemoryIds: string[] = []) => bridge.begin({ scopeKey: 'owner', threadId: thread, observedAt: at,
    recalledMemoryIds, ownerAlone: () => alone })!;
  const record = () => conversations.appendTurn('owner', thread, 'Please research this public topic.', 'I admitted the research task.', at);
  const call = (name: string, input: unknown) => bridge.executeTaskTool(name, input, { scopeKey: 'owner' });
  const forget = (id: string) => state.apply('owner', { type: 'memory-control-upserted', control: {
    memoryId: id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner',
  } });
  return { ...h, runtime, state, conversations, thread, visible, bridge, foreground, begin, record, call, forget, readSources,
    setAlone(value: boolean) { alone = value; } };
}

describe('foreground conversation task adapter', () => {
  it('preserves ordinary chat after the root stops while leaving all task tools unavailable', async () => {
    const f = fixture(); let calls = 0;
    f.runtime.stop('owner', f.runtime.ensureRoot('owner').id, 'owner_stop');
    const kernel = createLocalApiKernel(() => at, { stateStore: f.state, conversationStore: f.conversations, fcaConversation: () => f.bridge,
      chatModel: { mode: 'local-stub', model: 'fixture', async generate() {
        calls++; expect(f.bridge.taskToolsAvailable('owner')).toBe(false);
        return { mode: 'local-stub', model: 'fixture', reply: 'こんばんは。' };
      } } });
    await f.foreground(async () => {
      expect(f.begin()).toBeNull();
      const reply = await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'こんばんは' } });
      expect(reply.status).toBe(200);
    });
    expect(calls).toBe(1); expect(f.runtime.readyTasks('owner')).toEqual([]);
    await kernel.waitForBackground('owner');
  });

  it('binds real task tools to the existing respond lease and releases research only after the ordinary source turn commits', async () => {
    const f = fixture(); let childId = '';
    expect(f.bridge.taskToolsAvailable('owner')).toBe(false);
    await f.foreground(async () => {
      const turn = f.begin(); expect(f.bridge.taskToolsAvailable('owner')).toBe(true);
      const child = parsed(f.call('task.create', spec)); childId = child.id;
      expect(parsed(f.call('task.create', spec)).id).toBe(childId);
      expect(f.runtime.get('owner', childId)?.kind).toBe('research');
      expect(f.runtime.readyTasks('owner')).toEqual([]);
      expect(f.visible('owner', childId)).toBe(false);
      expect(parsed(f.call('task.get', { id: childId })).id).toBe(childId);
      expect(f.runtime.taskSources('owner', childId)).toMatchObject([{ experienceId: null, threadId: f.thread }]);
      const experience = f.record(); turn.commit(experience.id);
      expect(f.visible('owner', childId)).toBe(true);
      expect(f.runtime.readyTasks('owner').map(task => task.id)).toEqual([childId]);
      expect(f.runtime.pendingReceipts('owner')).toEqual([]);
      expect(f.store.list('owner').filter(action => action.kind === 'agentTask')).toEqual([]);
      expect(f.db.prepare('SELECT entries_json FROM fca_task_history').all()).toEqual([]);
      expect(f.bridge.taskToolsAvailable('owner')).toBe(false);
    });
    expect(f.runtime.get('owner', childId)?.phase).toBe('ready');
  });

  it('keeps failed-turn children stopped and permits a fresh foreground turn without inheriting the failed source', async () => {
    const f = fixture(); let oldId = '';
    await f.foreground(async () => {
      const turn = f.begin(); oldId = parsed(f.call('task.create', spec)).id; turn.abort();
      expect(f.runtime.get('owner', oldId)?.phase).toBe('stopped');
      expect(f.runtime.readyTasks('owner')).toEqual([]);
    });
    await f.foreground(async () => {
      const turn = f.begin();
      expect(f.bridge.taskToolsAvailable('owner')).toBe(true);
      expect(f.call('task.get', { id: oldId })).toMatchObject({ ok: false, failure: 'not_found' });
      const fresh = parsed(f.call('task.create', { ...spec, title: 'Another topic' }));
      turn.commit(f.record().id);
      expect(f.visible('owner', fresh.id)).toBe(true);
    });
  });

  it('withholds forgotten source tasks and descendants from get, list, send and parent child projections', async () => {
    const f = fixture(); let childId = '', source = '';
    await f.foreground(async () => {
      const turn = f.begin(); childId = parsed(f.call('task.create', spec)).id;
      source = f.record().id; turn.commit(source);
    });
    const descendant = f.runtime.createChild('owner', childId, { title: 'Nested', goal: 'Read another public source' }, 'nested');
    f.forget(source);
    expect(f.visible('owner', childId)).toBe(false);
    expect(f.visible('owner', descendant.id)).toBe(false);
    await f.foreground(async () => {
      const turn = f.begin();
      expect(f.call('task.get', { id: childId })).toMatchObject({ ok: false });
      const listed = f.call('task.list', {}); expect(listed.ok).toBe(true);
      expect(listed.text).not.toContain(childId); expect(listed.text).not.toContain(descendant.id);
      expect(f.call('task.send', { id: childId, message: 'Try again' })).toMatchObject({ ok: false, retryable: false });
      turn.abort();
    });
  });

  it('tracks recalled and replayed provenance even when a task goal contains none of the forgotten wording', async () => {
    const f = fixture();
    const earlier = f.conversations.appendTurn('owner', f.thread, 'The private clue is unrelated to the public goal.', 'Understood.', at);
    const refs = conversationFcaProvenance(f.state.snapshot('owner'), f.conversations, 'owner', f.thread, []);
    expect(refs).toContain(earlier.id);
    let childId = '';
    await f.foreground(async () => {
      const turn = f.begin(refs); childId = parsed(f.call('task.create', spec)).id; turn.commit(f.record().id);
    });
    f.forget(earlier.id);
    expect(f.visible('owner', childId)).toBe(false);
    expect(conversationFcaProvenance(f.state.snapshot('owner'), f.conversations, 'owner', f.thread, [])).not.toContain(earlier.id);
  });

  it('rechecks the live audience and refuses unbound or cross-scope task access', async () => {
    const f = fixture();
    await f.foreground(async () => {
      const turn = f.begin(), child = parsed(f.call('task.create', spec));
      expect(f.visible('other', child.id)).toBe(false);
      expect(f.bridge.executeTaskTool('task.get', { id: child.id }, { scopeKey: 'other' })).toMatchObject({ ok: false });
      f.setAlone(false);
      expect(f.bridge.taskToolsAvailable('owner')).toBe(false);
      expect(f.call('task.get', { id: child.id })).toMatchObject({ ok: false });
      turn.commit(f.record().id);
      expect(f.visible('owner', child.id)).toBe(false);
      f.setAlone(true); expect(f.visible('owner', child.id)).toBe(true);
    });
  });

  it('keeps profile facts in provenance even when recall did not select them', async () => {
    const f = fixture(), factId = 'profile-only-fact';
    f.state.apply('owner', { type: 'user-fact-upserted', fact: {
      id: factId, statement: 'The owner studies a specific constellation.', confidence: 0.8, observedAt: at,
    } });
    const refs = conversationFcaProvenance(f.state.snapshot('owner'), f.conversations, 'owner', f.thread, []);
    expect(refs).toContain(factId);
    let childId = '';
    await f.foreground(async () => {
      const turn = f.begin(refs); childId = parsed(f.call('task.create', spec)).id; turn.commit(f.record().id);
    });
    f.state.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: factId, kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner',
    } });
    expect(f.visible('owner', childId)).toBe(false);
    expect(conversationFcaProvenance(f.state.snapshot('owner'), f.conversations, 'owner', f.thread, [])).not.toContain(factId);
  });

  it('delivers bounded inbox reports before consuming them and leaves unshown reports for the next turn', async () => {
    const f = fixture();
    await f.foreground(async () => { f.begin().commit(f.record().id); });
    const conversation = f.runtime.list('owner').find(task => task.kind === 'conversation')!;
    const root = f.runtime.ensureRoot('owner');
    for (let index = 0; index < 10; index++) f.runtime.send('owner', root.id, conversation.id, `Report ${index}`, `report-${index}`);
    await f.foreground(async () => {
      const turn = f.begin();
      expect(f.runtime.snapshot('owner', conversation.id)?.messages).toHaveLength(10);
      const prompt = turn.context(); expect(prompt).toContain('Report 0'); expect(prompt).not.toContain('Report 8');
      expect(f.runtime.snapshot('owner', conversation.id)?.messages).toHaveLength(10);
      turn.commit(f.record().id);
    });
    expect(f.runtime.snapshot('owner', conversation.id)?.messages).toHaveLength(2);
    await f.foreground(async () => { const turn = f.begin(); turn.commit(f.record().id); });
    expect(f.runtime.snapshot('owner', conversation.id)?.messages).toHaveLength(2);
  });

  it('withholds forgotten inbox sources without inheriting them into new research or consuming the reports', async () => {
    const f = fixture(); let childId = '', experienceId = '';
    await f.foreground(async () => {
      const turn = f.begin(); childId = parsed(f.call('task.create', spec)).id;
      experienceId = f.record().id; turn.commit(experienceId);
    });
    const conversation = f.runtime.list('owner').find(task => task.kind === 'conversation')!;
    f.runtime.send('owner', childId, conversation.id, 'Forgotten report', 'private-report'); f.forget(experienceId);
    await f.foreground(async () => {
      const turn = f.begin(); expect(turn.context()).toBe('');
      const fresh = parsed(f.call('task.create', { ...spec, title: 'Unrelated new topic' }));
      turn.commit(f.conversations.appendTurn('owner', f.thread, 'Research a different public topic.', 'The new topic is admitted.', at).id);
      expect(f.runtime.taskSources('owner', fresh.id).every(source => source.experienceId !== experienceId)).toBe(true);
    });
    expect(f.runtime.snapshot('owner', conversation.id)?.messages).toHaveLength(1);
  });

  it('binds private read receipts observed after child creation and rechecks their live visibility', async () => {
    const f = fixture(), source = 'shannon-study://piece-1'; let childId = '';
    f.readSources.set(source, true);
    await f.foreground(async () => {
      const turn = f.begin(); childId = parsed(f.call('task.create', spec)).id;
      expect(f.bridge.observeRead('other', { name: 'study.read', ok: true, documents: { read: [source] } })).toBe(false);
      expect(f.bridge.observeRead('owner', { name: 'study.read', ok: true, documents: { read: [source] } })).toBe(true);
      turn.commit(f.record().id);
    });
    expect(f.runtime.taskSources('owner', childId)[0]?.readSourceIds).toEqual([source]);
    expect(f.visible('owner', childId)).toBe(true);
    f.readSources.set(source, false); expect(f.visible('owner', childId)).toBe(false);
  });

  it('selects from the entire authorized menu while preserving its base session and tool_open recovery', async () => {
    let selectedFrom: readonly { name: string; description: string }[] = [];
    const f = fixture({ async select(input) { selectedFrom = input.tools; return { names: ['task.get'], source: 'jev' }; } });
    const base: ShannonModelToolSession = { definitions: TASK_TOOLS, maximumCalls: 8,
      deadline: new TurnDeadline(TEXT_TURN_DEADLINE, () => 0), call: async () => 'base result' };
    await f.foreground(async () => {
      const turn = f.begin(), tools = await turn.selectTools!(withToolMenu(base, []), { goal: 'Check the research', state: 'Waiting' });
      expect(selectedFrom.map(tool => tool.name)).toEqual(TASK_TOOLS.map(tool => tool.name));
      expect(baseToolSession(tools)).toBe(base);
      expect(tools.definitions.some(tool => tool.name === 'task.get')).toBe(true);
      expect(tools.definitions.some(tool => tool.name === 'task.create')).toBe(false);
      tools.meta!('tool_open', JSON.stringify({ name: 'task_create' }));
      expect(tools.definitions.some(tool => tool.name === 'task.create')).toBe(true); turn.abort();
    });
  });

  it('keeps late private-read provenance after an audience change and never drops an invalid receipt silently', async () => {
    const f = fixture(); let childId = '';
    await f.foreground(async () => {
      const turn = f.begin(); childId = parsed(f.call('task.create', spec)).id;
      f.setAlone(false);
      expect(f.bridge.observeRead('owner', { name: 'aether.read', ok: true, documents: { read: ['doc-1'] } })).toBe(true);
      expect(f.bridge.observeSources('owner', { readSourceIds: ['x'.repeat(241)] })).toBe(false);
      turn.commit(f.record().id);
    });
    const sources = f.runtime.taskSources('owner', childId)[0]!.readSourceIds!;
    expect(sources).toContain('aether-document://doc-1'); expect(sources).toContain('fca-unresolved://invalid-receipt');
    f.setAlone(true); expect(f.visible('owner', childId)).toBe(false);
  });
});

describe('conversation FCA kernel seam', () => {
  it('uses one normal model/stream and binds only after its source experience is stored; guest text stays outside the bridge', async () => {
    const conversations = new InMemoryConversationStore(), events: string[] = [], contexts: string[] = [];
    const model: ShannonChatModel = { mode: 'local-stub', model: 'fixture', async generate(request) {
      contexts.push(request.turnContext ?? ''); events.push('model'); return { mode: 'local-stub', model: 'fixture', reply: 'こんばんは。' };
    } };
    const port: FcaConversationPort = { begin() { events.push('begin'); return {
      context() { return '[Fixture inbox]'; },
      commit(id) { expect(conversations.experiencesById('owner', [id])).toHaveLength(1); events.push('commit'); },
      abort() { events.push('abort'); },
    }; }, taskToolsAvailable: () => false, executeTaskTool: () => ({ ok: false, text: '', retryable: false }), observeRead: () => false, observeSources: () => false };
    const kernel = createLocalApiKernel(() => at, { chatModel: model, conversationStore: conversations, fcaConversation: () => port });
    const reply = await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'こんばんは', stream: 'sentences' } });
    expect(reply.status).toBe(200); expect(reply.sentenceStream).toEqual({ fallback: null });
    expect(events).toEqual(['begin', 'model', 'commit']);
    expect(contexts[0]).toContain('[Fixture inbox]');
    events.length = 0;
    const guest = await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'こんにちは', audience: 'others' } });
    expect(guest.status).toBe(200); expect(events).toEqual(['model']);
    expect(contexts[1]).not.toContain('[Fixture inbox]');
    await kernel.waitForBackground('owner');
  });
  it('aborts the bound task after a model error and never calls a fallback model', async () => {
    let modelCalls = 0, aborted = 0;
    const model: ShannonChatModel = { mode: 'local-stub', model: 'fixture', async generate() { modelCalls++; throw new Error('paid_result_unknown'); } };
    const port: FcaConversationPort = { begin: () => ({ context: () => '', commit() { throw new Error('must_not_commit'); }, abort() { aborted++; } }),
      taskToolsAvailable: () => false, executeTaskTool: () => ({ ok: false, text: '', retryable: false }), observeRead: () => false, observeSources: () => false };
    const kernel = createLocalApiKernel(() => at, { chatModel: model, fcaConversation: () => port });
    await expect(kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'こんばんは' } })).rejects.toThrow('paid_result_unknown');
    expect(modelCalls).toBe(1); expect(aborted).toBe(1);
  });
});
