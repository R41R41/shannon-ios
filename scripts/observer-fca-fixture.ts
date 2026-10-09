/** Local-only UI fixture: real task/action stores and FCA runner, deterministic model/tools, no provider or body. */
import type { FcaModel, FcaModelInput, FcaModelOutput } from '../services/api/src/mind/action/fca/fcaPorts.js';
import { createTaskRuntimeWiring } from '../services/api/src/wiring/taskRuntimeWiring.js';
import { actionHarness } from '../services/api/tests/support/actionThreadHarness.js';
import { observeAsync } from '../services/api/src/infra/observer/observerContext.js';
import { shannonTool } from '../services/api/src/mind/tools/toolRegistryPorts.js';

export function createObserverFcaFixture(scopeKey: string, ownerAlone: () => boolean) {
  const harness = actionHarness(() => new Date().toISOString());
  const pending = new Set<() => void>();
  const readyWaiters = new Set<{ count: number; resolve(): void }>();
  const gatesReady = (count: number) => pending.size >= count ? Promise.resolve() : new Promise<void>(resolve => readyWaiters.add({ count, resolve }));
  const rounds = new Map<string, number>();
  let finish = false, sequence = 0;
  function modelGate(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const release = () => { pending.delete(release); signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { pending.delete(release); reject(signal.reason ?? new Error('FIXTURE_CANCELLED')); };
      if (signal.aborted) { abort(); return; }
      pending.add(release); signal.addEventListener('abort', abort, { once: true });
      for (const waiter of readyWaiters) if (pending.size >= waiter.count) { readyWaiters.delete(waiter); waiter.resolve(); }
    });
  }
  const model: FcaModel = {
    async decide(input: FcaModelInput, signal: AbortSignal): Promise<FcaModelOutput> {
      const round = rounds.get(input.task.id) ?? 0; rounds.set(input.task.id, round + 1);
      return observeAsync('llm', { fixture: true, operation: 'manual local gate; not a provider latency sample', round }, async () => {
        if (round === 0 && !finish) await modelGate(signal);
        const decision = finish ? { kind: 'complete' as const, summary: 'ローカルUI fixture終了' }
          : round === 0 ? { kind: 'tools' as const, calls: [{ id: `fixture-search-${round}`, name: 'web.search', input: { query: 'isolated UI fixture; no external request' } }] }
            : { kind: 'wait' as const, summary: 'ローカルUI fixtureの次の連絡待ち' };
        return { decision, history: [...input.history, { role: 'assistant', content: 'Deterministic UI fixture history; never a production response.' }] };
      }, result => ({ fixture: true, decision: result.decision.kind, selectedTools: result.decision.kind === 'tools' ? result.decision.calls.map(call => call.name) : [] }), { model: 'local-ui-fixture-no-provider' });
    },
    toolResults: results => ({ role: 'user', content: results.map(result => ({ type: 'tool_result', tool_use_id: result.id, content: result.text })) }),
  };
  const search = shannonTool('web.search');
  if (!search) throw new Error('LOCAL_FIXTURE_TOOL_MISSING');
  const driver = createTaskRuntimeWiring({ db: harness.db, actions: harness.actions, model, scopeKey, ownerAlone,
    stepPorts: () => ({
      selector: { async select() { return { names: ['web.search'], source: 'fallback' as const }; } },
      tools: { definitions: [search], async execute(request) {
        request.signal.throwIfAborted();
        return { ok: true, retryable: false, text: 'ローカルfixtureの検索結果。外部検索・課金は実行していません。' };
      } },
    }),
  });
  const taskIds: string[] = [];
  const release = () => { for (const done of [...pending]) done(); };
  return {
    async start() {
      if (taskIds.length) throw new Error('LOCAL_FIXTURE_ALREADY_STARTED');
      const root = driver.runtime.ensureRoot(scopeKey);
      const parent = driver.runtime.createChild(scopeKey, root.id, { title: 'UI FIXTURE parent', goal: 'Inspect the real common FCA; no external work', completionCriteria: 'Controlled UI fixture is finished' }, `ui-parent-${++sequence}`);
      const child = driver.runtime.createChild(scopeKey, parent.id, { title: 'UI FIXTURE child', goal: 'Inspect child lineage and concurrent execution', completionCriteria: 'Controlled UI fixture is finished' }, `ui-child-${sequence}`);
      const sibling = driver.runtime.createChild(scopeKey, root.id, { title: 'UI FIXTURE sibling', goal: 'Inspect a queued parallel task', completionCriteria: 'Controlled UI fixture is finished' }, `ui-sibling-${sequence}`);
      taskIds.push(parent.id, child.id, sibling.id);
      await driver.tick();
      await gatesReady(2);
      return { rootId: root.id, tasks: [...taskIds] };
    },
    async next() {
      release(); await driver.drain();
      const firstDecisions = driver.runtime.readyTasks(scopeKey, 2).filter(task => (rounds.get(task.id) ?? 0) === 0).length;
      await driver.tick();
      if (firstDecisions && !finish) await gatesReady(firstDecisions);
    },
    async finish() {
      finish = true;
      const root = driver.runtime.ensureRoot(scopeKey);
      for (const id of taskIds) if (driver.runtime.get(scopeKey, id)?.phase === 'waiting') {
        driver.runtime.send(scopeKey, root.id, id, 'Local fixture finish request', `ui-finish-${++sequence}`);
      }
      release(); await driver.drain();
      // There are three fixture tasks and two execution slots. Drain each admitted
      // segment, so a finish command never leaves a manually gated fixture running.
      for (let pass = 0; pass < taskIds.length; pass += 1) { await driver.tick(); await driver.drain(); }
    },
    async close() { release(); await driver.close(); harness.close(); },
    summary: () => taskIds.map(id => ({ id, phase: driver.runtime.get(scopeKey, id)?.phase ?? 'unavailable' })),
  };
}
