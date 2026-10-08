import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, SHANNON_FCA_TASK_CAPABILITY } from '@shannon/cognition';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { withToolCapabilityLines } from '../src/mind/tools/shannonAetherTools.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { webSearchFailure } from '../src/infra/models/webSearch.js';

const at = '2026-10-09T00:00:00.000Z';
const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture(unknown = false) {
  const h = actionHarness(() => at); closes.push(h.close);
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const service = createInMemoryAutonomyService(() => at), tools = service.tools;
  let searches = 0, checkpoints = 0;
  tools.useReads({ web: async () => { searches++; return unknown ? webSearchFailure('unknown')
    : { status: 'results', text: 'Public result', sources: [{ title: 'Source', url: 'https://example.com/source' }] }; } });
  let visible: ReturnType<typeof createFcaSourceGuard>;
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => true, now: () => at,
    model: { async decide(input) { return input.history.length
      ? { decision: { kind: 'complete', summary: 'Verified public result' }, history: [{ role: 'assistant', content: 'done' }] }
      : { decision: { kind: 'tools', calls: [{ id: 'search', name: 'web.search', input: { query: 'public topic' } }] }, history: [{ role: 'assistant', content: 'search' }] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (_, step) => ({ sourcesVisible: () => visible('owner', step.taskId), taskVisible: id => visible('owner', id),
      tools: fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone: () => true }) }),
  });
  closes.push(() => driver.close());
  visible = createFcaSourceGuard({ runtime: driver.runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true });
  const bridge = createFcaConversationBridge({ runtime: driver.runtime, ownerScope: 'owner', visible });
  tools.useTaskRuntime({ available: scope => bridge.taskToolsAvailable(scope), execute: (name, input, context) => bridge.executeTaskTool(name, input, context) });
  return { ...h, driver, tools, state, conversations, bridge, visible, searches: () => searches,
    async create() {
      const threadId = conversations.threadId('owner');
      const action = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'conversation' }))!;
      const lease = leaseOf(action);
      let id = '';
      await inActionExecution({ lease, signal: new AbortController().signal, permit: () => h.actions.dispatch(lease),
        checkpoint: async () => { checkpoints++; return true; } }, async () => {
        const turn = bridge.begin({ scopeKey: 'owner', threadId, observedAt: at, recalledMemoryIds: [], ownerAlone: () => true })!;
        expect(bridge.taskToolsAvailable('owner'), JSON.stringify(driver.runtime.list('owner'))).toBe(true);
        expect(tools.offered('text', 'owner_alone', 'owner').filter(tool => tool.domain === 'task_runtime')).toHaveLength(4);
        const result = await tools.call('task.create', { title: 'Research', goal: 'Find public information', completionCriteria: 'A source exists' },
          { scopeKey: 'owner', surface: 'text', audience: 'owner_alone', memory: toolSessionMemory() });
        expect(result.ok).toBe(true); id = JSON.parse(result.text).id;
        expect(driver.runtime.readyTasks('owner')).toEqual([]);
        turn.commit(conversations.appendTurn('owner', threadId, 'Research', 'Started', at).id);
      });
      await h.actions.finish(lease, 'completed', 'responded');
      expect(checkpoints).toBe(1);
      return id;
    },
  };
}

describe('common FCA conversation-to-research integration', () => {
  it('uses the real foreground lease, registered task executor, existing web gate and background completion receipt', async () => {
    const f = fixture(); const id = await f.create();
    expect(f.tools.offered('text', 'owner_alone', 'owner').some(tool => tool.domain === 'task_runtime')).toBe(false);
    await f.driver.tick(); await f.driver.drain();
    expect(f.searches()).toBe(1);
    await f.driver.tick(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', id)).toMatchObject({ phase: 'completed', summary: 'Verified public result' });
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });
  it('holds an unknown paid web result without replaying its task or search on later ticks', async () => {
    const f = fixture(true); const id = await f.create();
    for (let i = 0; i < 3; i++) { await f.driver.tick(); await f.driver.drain(); }
    expect(f.searches()).toBe(1);
    expect(f.driver.runtime.get('owner', id)?.phase).toBe('unknown');
    expect(f.driver.runtime.snapshot('owner', id)?.history).toEqual([]);
  });
  it('adds the canonical task capability only when its tools are offered', () => {
    expect(withToolCapabilityLines({ systemPrompt: 'base' }).systemPrompt).toBe('base');
    expect(withToolCapabilityLines({ systemPrompt: 'base', tools: { definitions: [{ name: 'task.create', domain: 'task_runtime' }] } }).systemPrompt).toContain(SHANNON_FCA_TASK_CAPABILITY.text);
  });
});
