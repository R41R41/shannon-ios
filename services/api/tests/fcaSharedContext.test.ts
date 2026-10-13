import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, withObserverRunSync } from '../src/infra/observer/observerContext.js';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createFcaSharedWiring } from '../src/wiring/fcaSharedWiring.js';
import { createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import type { FcaModelInput, FcaModelOutput } from '../src/mind/action/fca/fcaPorts.js';
import { MEMORY_TOOLS } from '../src/mind/tools/memoryToolDefinitions.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(decide: (input: FcaModelInput) => FcaModelOutput | Promise<FcaModelOutput>,
  enrich?: import('../src/mind/recall/turnMemoryRecall.js').TurnMemoryRecall) {
  const world = memoryWorld(); cleanup.push(world.close);
  const actions = actionHarness(world.now, world.path); cleanup.push(actions.close);
  let shared: ReturnType<typeof createFcaSharedWiring>;
  const driver = createTaskRuntimeWiring({ db: actions.db, actions: actions.actions, scopeKey: 'owner', now: world.now, ownerAlone: () => true,
    model: { decide: async input => decide(input), toolResults: results => ({ role: 'user', content: JSON.stringify(results) }) },
    stepPorts: (_, step) => ({ recall: shared.recall, evidence: shared.evidence,
      selector: { async select() { return { names: ['web.search'], source: 'jev' }; } },
      observeMemory: ids => shared.observeMemory(step, ids),
      sourcesVisible: () => visible.sources('owner', step.snapshot.task, step.snapshot.sources), taskVisible: id => visible('owner', id),
      tools: { definitions: [...MEMORY_TOOLS, { ...MEMORY_TOOLS[0]!, name: 'web.search' }],
        async execute() { return { ok: true, retryable: false, text: JSON.stringify({ count: 3, finding: '分光装置の比較に有効' }) }; } },
    }),
  }); cleanup.push(() => driver.close());
  const visible = createFcaSourceGuard({ runtime: driver.runtime, state: world.store, conversations: world.store, ownerScope: 'owner', ownerAlone: () => true });
  shared = createFcaSharedWiring({ db: actions.db, runtime: driver.runtime, state: world.store, affect: world.store,
    conversations: world.store, memory: world.ports.proposals, ownerScope: 'owner', ownerAlone: () => true, visible,
    readSourceVisible: () => false, now: world.now, enrich });
  return { ...world, driver, shared, actions, visible,
    create: (goal: string) => driver.runtime.createChild('owner', driver.runtime.ensureRoot('owner').id, { title: goal, goal, kind: 'research' }, goal),
    tick: async () => { await driver.tick(); await driver.drain(); },
  };
}
const history = [{ role: 'assistant', content: 'public fixture round' }];
describe('FCA shared context through actual execution and existing state/memory writers', () => {
  it('attributes replayed memory proposals to their original tasks, not the task triggering the outbox flush', async () => {
    const f = fixture(() => ({ decision: { kind: 'complete', summary: 'PRIVATE_RESULT' }, history }));
    const first = f.create('PRIVATE_FIRST'), second = f.create('PRIVATE_SECOND');
    await f.tick();
    f.actions.db.prepare('UPDATE fca_action_evidence SET outcome_delivered=0').run();
    const events: ObserverDraft[] = [], restore = installObserverSink(event => events.push(event));
    try { withObserverRunSync({ scopeKey: 'owner', surface: 'fixture', taskId: 'trigger-task', stepId: 'trigger-step', actionId: 'trigger-action' }, () => f.shared.evidence!.flush()); }
    finally { restore(); }
    const proposals = events.filter(event => event.node === 'memory' && event.kind === 'span.started');
    expect(new Set(proposals.map(event => event.taskId))).toEqual(new Set([first.id, second.id]));
    expect(proposals.every(event => event.stepId && event.stepId !== 'trigger-step' && event.actionId === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });
  it('records a pre-action expectation, compares facts, applies one shared feeling, and recalls committed experience in a new task', async () => {
    const seen: FcaModelInput[] = [];
    const f = fixture(input => {
      seen.push(input);
      if (!input.history.length && input.task.goal === '分光装置を調査') return { decision: { kind: 'tools', calls: [{ id: 'search', name: 'web.search', input: { query: '分光装置' } }] }, history,
        expectations: [{ callId: 'search', source: 'tool_result', observable: { kind: 'json_pointer', path: '/count' }, expected: 2, probability: 0.8, expectedValue: 0.2, withinMs: 1000 }] };
      const event = input.sharedContext?.recentOutcomes.find(outcome => outcome.name === 'web.search');
      return { decision: { kind: 'complete', summary: '分光装置の仕様を比較して確認した' }, history,
        ...(event ? { appraisals: [{ eventId: event.eventId, revision: 1, value: 0.8, cause: '予想以上の資料が見つかった', target: '調査' }] } : {}) };
    });
    const initial = f.store.snapshot('owner').emotion.valence;
    const research = f.create('分光装置を調査'); await f.tick(); await f.tick();
    expect(f.driver.runtime.get('owner', research.id)?.phase).toBe('completed');
    expect(seen[1]?.sharedContext?.recentOutcomes[0]?.comparison).toMatchObject({ status: 'mismatch', actual: 3 });
    expect(seen[0]?.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['memory.search', 'memory.read']));
    expect(f.store.snapshot('owner').emotion.valence).toBeGreaterThan(initial);
    const revision = f.store.snapshot('owner').version;
    f.shared.evidence!.flush(); f.shared.evidence!.flush(); expect(f.store.snapshot('owner').version).toBe(revision);
    const writer = f.writer(); await writer.runOnce(); writer.releaseLease();
    expect(f.store.searchMemory('owner', '分光装置').length).toBeGreaterThan(0);
    f.create('分光装置の調査経験を思い出す'); await f.tick();
    const next = seen.at(-1)!;
    expect(next.sharedContext?.affect.revision).toBeGreaterThanOrEqual(revision);
    expect(next.recall?.items.some(item => item.summary.includes('分光装置'))).toBe(true);
    expect(f.store.listThreads('owner')).toEqual([]);
  });
  it('drains pending semantic work before publishing a segment receipt or releasing its action', async () => {
    let release!: () => void, cancelled!: () => void;
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    const f = fixture(() => ({ decision: { kind: 'complete', summary: '確認済み' }, history }), {
      willSearch: () => true, retireKnowledge: () => [],
      enrich: async (context, input) => {
        input.signal!.addEventListener('abort', cancelled, { once: true });
        await new Promise<void>(resolve => { release = resolve; });
        return { ...context, knowledgePrompt: '', memoryRecall: { status: 'skipped', modelCalls: 0, elapsedMilliseconds: 0 } };
      },
    });
    // Only a decision that waits for enrichment starts it (a memory inquiry, 2026-10-13).
    const task = f.create('調査について何を覚えてる？'); await f.driver.tick(); await aborted;
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('executing');
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
    release(); await f.driver.drain();
    expect(f.driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(f.driver.runtime.pendingReceipts('owner')).toEqual([]);
  });
  it('persists recall lineage so forgetting prevents the next native decision and descendant disclosure', async () => {
    let calls = 0;
    const f = fixture(() => { calls++; return { decision: { kind: 'tools', calls: [{ id: 'search', name: 'web.search', input: { query: '分光装置' } }] }, history }; });
    const source = f.store.appendTurn('owner', 'talk', '分光装置は月曜に調べる', '覚えました', f.now());
    const task = f.create('分光装置'); await f.tick(); expect(calls).toBe(1);
    expect(f.driver.runtime.taskSources('owner', task.id).some(ref => ref.recalledMemoryIds.includes(source.id))).toBe(true);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: source.id, action: 'forget' });
    expect(f.visible('owner', task.id)).toBe(false);
    await f.tick(); expect(calls).toBe(1);
    expect(f.shared.memory.read('owner', [source.id], OWNER_AUDIENCE)).toEqual([]);
  });
});
