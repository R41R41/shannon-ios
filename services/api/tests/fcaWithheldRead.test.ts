import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { ShannonToolRunner } from '../src/mind/tools/toolRunnerPorts.js';
import type { HostFolderOperations } from '../src/mind/action/ownTime/hostFolderOperations.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';

/**
 * Minecraft run 11 (2026-10-15): a read with no effect outside whose result could not be shown after it ran closed its step unknown,
 * and the task was retired. Now such a read is a known failure with nothing of its result; a tool with an effect still throws.
 */
const at = '2026-10-15T00:00:00.000Z', closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture(runner?: ShannonToolRunner) {
  const h = actionHarness(() => at); closes.push(h.close);
  const tools = runner ?? createInMemoryAutonomyService(() => at).tools;
  tools.useReads({ web: async () => ({ status: 'results', text: '公開の結果', sources: [{ title: '出典', url: 'https://example.com/' }] }) });
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'read' })).id);
  const lease = leaseOf(action!);
  let observed = 0;
  // The source check after the read withholds it (as `fca-unresolved://` did for minecraft.lifecycle_status).
  const research = fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone: () => true, sourcesVisible: () => true,
    task: { id: 'task', origin: 'owner_request', leaseId: lease.id }, observeRead: () => { observed += 1; return false; } });
  const run = (name: string, input: Record<string, unknown>) => inActionExecution({ lease, signal: new AbortController().signal,
    permit: resources => h.actions.dispatch(lease, resources) }, () => research.execute({ scopeKey: 'owner', taskId: 'task', operationId: `step:${name}`,
    name, input, signal: new AbortController().signal }));
  return { research, run, observed: () => observed };
}

describe('a read whose result cannot be shown after it ran', () => {
  it('is a known failure without its result when the read has no effect outside, and the step can go on', async () => {
    const f = await fixture();
    expect(f.research.definitions.some(tool => tool.name === 'study.list')).toBe(true);
    const result = await f.run('study.list', {});
    expect(result).toEqual({ ok: false, text: 'この結果は今は使えません。', failure: 'unavailable', retryable: false });
    expect(f.observed()).toBeGreaterThan(0);
  });

  it('still throws for a read with an effect outside (a paid search), whose step stays unknown as before', async () => {
    const f = await fixture();
    await expect(f.run('web.search', { query: '公開の話題' })).rejects.toThrow('FCA_SOURCE_WITHHELD');
  });

  it('leaves no title, path or link of the withheld read in her activity record, nor any of its content in the Observer', async () => {
    const store = new SQLiteAutonomyStore(':memory:'); closes.push(() => store.close());
    const records: unknown[] = [];
    const runner = new ShannonToolRunner(store, { boundHosts: () => [] } as unknown as HostFolderOperations,
      { recordConversationAction(_scope: string, report: unknown) { records.push(report); } }, () => at);
    const piece = store.study.create('owner', { kind: 'note', title: '秘密の題名', body: '秘密の本文がここにある。' }, at);
    if (typeof piece === 'string') throw new Error(piece);
    const f = await fixture(runner);
    const events: unknown[] = [];
    const restore = installObserverSink(event => { events.push(event); });
    let result;
    try { result = await withObserverRun({ scopeKey: 'owner', surface: 'text' }, () => f.run('study.read', { id: piece.id })); } finally { restore(); }
    expect(result).toEqual({ ok: false, text: 'この結果は今は使えません。', failure: 'unavailable', retryable: false });
    const recorded = JSON.stringify(records), observed = JSON.stringify(events);
    for (const content of ['秘密の題名', '秘密の本文', piece.id, 'shannon-study://', '読みました']) expect(recorded).not.toContain(content);
    expect(observed).toContain('"phase":"execute"');
    for (const content of ['秘密の題名', '秘密の本文', piece.id, 'shannon-study://']) expect(observed).not.toContain(content);
  });
});
