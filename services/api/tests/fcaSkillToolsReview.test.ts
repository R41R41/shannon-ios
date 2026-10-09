import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { ShannonToolRunner, type ToolAetherPorts } from '../src/mind/tools/toolRunnerPorts.js';
import type { HostFolderOperations } from '../src/mind/action/ownTime/hostFolderOperations.js';
import type { StudyAether } from '../src/mind/action/ownTime/ownTimePorts.js';
import type { AetherAccess } from '../src/integrations/aether/aetherAccess.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { fcaResearchTools } from '../src/wiring/fcaResearchWiring.js';
import { fcaReadReceiptSources } from '../src/mind/action/fca/fcaConversationSources.js';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';
import { AnthropicFcaModel, type AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';

const at = '2026-10-09T00:00:00.000Z';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(aether: ToolAetherPorts, name: string, input: unknown, model?: FcaModel) {
  const h = actionHarness(() => at); cleanup.push(h.close);
  const store = new SQLiteAutonomyStore(':memory:'); cleanup.push(() => store.close());
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const tools = new ShannonToolRunner(store, { boundHosts: () => [] } as unknown as HostFolderOperations,
    { recordConversationAction() {} }, () => at, undefined, null, aether);
  let alone = true, sourcesVisible = true;
  const readReceipts: Array<{ name: string; sourceIds: readonly string[] }> = [];
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: () => alone, now: () => at,
    model: model ?? { async decide() { return { decision: { kind: 'tools' as const, calls: [{ id: 'write', name, input }] }, history: [{ role: 'assistant', content: 'requested write' }] }; },
      toolResults: results => ({ role: 'user', results }) },
    stepPorts: (runtime, step) => ({ sourcesVisible: () => sourcesVisible,
      tools: fcaResearchTools({ tools, state, conversations, scopeKey: 'owner', ownerAlone: () => alone,
        task: { id: step.taskId, origin: step.snapshot.task.origin, leaseId: step.lease.id },
        sourcesVisible: () => sourcesVisible, observeRead: (operationId, receipt) => {
          const ids = fcaReadReceiptSources(receipt).readSourceIds ?? [];
          readReceipts.push({ name: receipt.name, sourceIds: ids });
          return sourcesVisible && runtime.observeSources(step, { observationId: `read:${operationId}`, recalledMemoryIds: [], readSourceIds: ids });
        } }) }),
  });
  cleanup.push(() => driver.close());
  const task = driver.runtime.createChild('owner', driver.runtime.ensureRoot('owner').id,
    { title: 'Requested write', goal: 'Save the requested text', origin: 'owner_request' }, 'requested-write');
  return { ...h, driver, task, readReceipts, setAlone: () => { alone = false; }, revokeSources: () => { sourcesVisible = false; } };
}

describe('FCA executor authority after awaited preliminary I/O', () => {
  it('pins the original proposal target read before publishing a valid owner-authorized proposal', async () => {
    let proposals = 0;
    const access = { read: async () => ({ documentId: 'owner-doc', inShannonFolder: false, updatedAt: at }) } as unknown as AetherAccess;
    let f!: ReturnType<typeof fixture>;
    f = fixture({ access, study: { covers: () => true } as unknown as StudyAether,
      proposals: { configured: true, create: () => {
        expect(f.readReceipts).toContainEqual({ name: 'aether.read', sourceIds: ['aether-document://owner-doc'] });
        expect(f.driver.runtime.taskSources('owner', f.task.id).flatMap(source => source.readSourceIds ?? [])).toContain('aether-document://owner-doc');
        proposals++;
        return { id: 'proposal', operation: 'append', title: 'Title', content: 'Requested text', reason: 'Owner requested it', createdAt: at };
      } } }, 'aether.propose', { operation: 'append', documentId: 'owner-doc', content: 'Requested text' });
    await f.driver.tick(); await f.driver.drain();
    expect(proposals).toBe(1);
    expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('ready');
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toHaveLength(2);
  });
  for (const change of ['audience', 'sources', 'stop'] as const) {
    it(`does not publish an Aether proposal after ${change} changes during its target read`, async () => {
      const entered = deferred(), release = deferred();
      let proposals = 0;
      const access = { read: async () => { entered.resolve(); await release.promise; return { documentId: 'owner-doc', inShannonFolder: false, updatedAt: at }; } } as unknown as AetherAccess;
      const f = fixture({ access, study: { covers: () => true } as unknown as StudyAether,
        proposals: { configured: true, create: () => { proposals++; return { id: 'proposal', operation: 'append', title: 'Title', content: 'Requested text', reason: 'Owner requested it', createdAt: at }; } } },
      'aether.propose', { operation: 'append', documentId: 'owner-doc', content: 'Requested text' });
      await f.driver.tick(); await entered.promise;
      if (change === 'audience') f.setAlone();
      if (change === 'sources') f.revokeSources();
      if (change === 'stop') await f.driver.stop(f.task.id, 'owner_stop');
      release.resolve(); await f.driver.drain();
      expect(proposals).toBe(0);
      expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toEqual([]);
      await f.driver.tick(); await f.driver.drain();
      expect(proposals).toBe(0);
    });
  }

  it('keeps valid owner-authorized study creation and its local commit working after sync', async () => {
    let writes = 0, commits = 0;
    const study = { covers: () => true, sync: async () => {},
      create: async () => { writes++; return { documentId: 'created-doc', version: 1 }; },
      commit: () => { commits++; },
    } as unknown as StudyAether;
    const f = fixture({ access: {} as AetherAccess, study }, 'study.create', { kind: 'note', title: 'Requested note', body: 'Requested text' });
    await f.driver.tick(); await f.driver.drain();
    expect(writes).toBe(1); expect(commits).toBe(1);
    expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('ready');
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toHaveLength(2);
  });

  for (const change of ['audience', 'sources', 'stop'] as const) {
    it(`does not send a study write after ${change} changes during its initial Aether sync`, async () => {
    const entered = deferred(), release = deferred();
    let writes = 0;
    const study = { covers: () => true,
      sync: async () => { entered.resolve(); await release.promise; },
      create: async () => { writes++; throw new Error('UNEXPECTED_WRITE'); },
    } as unknown as StudyAether;
    const f = fixture({ access: {} as AetherAccess, study }, 'study.create', { kind: 'note', title: 'Requested note', body: 'Requested text' });
    await f.driver.tick(); await entered.promise;
    if (change === 'audience') f.setAlone();
    if (change === 'sources') f.revokeSources();
    if (change === 'stop') await f.driver.stop(f.task.id, 'owner_stop');
    release.resolve(); await f.driver.drain();
    expect(writes).toBe(0);
    expect(f.driver.runtime.snapshot('owner', f.task.id)!.history).toEqual([]);
    await f.driver.tick(); await f.driver.drain();
    expect(writes).toBe(0);
    });
  }

  it('keeps an aborted dispatched native model request unknown on its original action receipt', async () => {
    const entered = deferred();
    let calls = 0;
    const usage: AnthropicFcaUsage[] = [];
    const model = new AnthropicFcaModel({ recordUsage: receipt => { usage.push(receipt); }, client: { messages: { create: async (_body, options) => {
      calls++; entered.resolve();
      return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('synthetic-lost-response')), { once: true }));
    } } } });
    const f = fixture({}, 'unused', {}, model);
    await f.driver.tick(); await entered.promise;
    const original = (await f.actions.list('owner')).find(action => action.sourceId.startsWith(`fca:${f.task.id}:`))!;
    expect(original.sent).toBe(true);
    await f.driver.stop(f.task.id, 'owner_stop'); await f.driver.drain();
    expect(usage).toMatchObject([{ usageComplete: false }]);
    expect(f.driver.runtime.get('owner', f.task.id)!.phase).toBe('unknown');
    expect(await f.actions.get('owner', original.id)).toMatchObject({ state: 'unknown', sent: true });
    expect(f.driver.runtime.resume('owner', f.task.id)).toBeNull();
    await f.driver.tick(); await f.driver.drain();
    expect(calls).toBe(1);
  });
});
