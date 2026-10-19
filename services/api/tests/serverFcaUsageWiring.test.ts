import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskRuntime } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskRuntimeWiringOptions } from '../src/wiring/taskRuntimeWiring.js';
import type { AnthropicFcaUsage } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { configuredServerFca } from '../src/wiring/serverFcaWiring.js';

/**
 * Minebot parity audit M-4 (2026-10-19), the hook itself: the model adapter reports every request's usage to `configuredServerFca`'s
 * `recordUsage`, which books a charge nobody confirmed (`usageComplete: false`) as an ESTIMATE of the task, apart from the confirmed
 * spend, while the usage ledger gets every one of them in full. The wiring is the real one; only the model, the socket and the
 * Minecraft parts around it are stand-ins.
 */
const captured = vi.hoisted(() => ({ options: null as TaskRuntimeWiringOptions | null, recordUsage: null as ((usage: unknown) => void) | null }));
vi.mock('../src/infra/models/anthropic/haikuConfig.js', async importOriginal => ({ ...await importOriginal<object>(),
  configuredResponseModel: () => ({ model: 'offline-fixture', apiKey: '' }), replacementModel: () => 'offline-fixture' }));
vi.mock('../src/infra/models/anthropic/anthropicFcaModel.js', () => ({ createAnthropicFcaModel: (options: { recordUsage: (usage: unknown) => void }) => {
  captured.recordUsage = options.recordUsage;
  return { decide: async () => ({ decision: { kind: 'complete', summary: 'x' }, history: [] }), toolResults: () => null };
} }));
vi.mock('../src/infra/models/anthropic/anthropicFcaSummary.js', () => ({ createAnthropicFcaSummarizer: () => ({}) }));
vi.mock('../src/infra/ipc/mindSocket.js', () => ({ MindSocketClient: class { call = vi.fn(); close() {} } }));
vi.mock('../src/wiring/skillRoutingWiring.js', () => ({ configuredJevChooser: () => null }));
vi.mock('../src/wiring/taskRuntimeWiring.js', () => ({ createTaskRuntimeWiring: (options: TaskRuntimeWiringOptions) => {
  captured.options = options;
  return { runtime: { get: () => null } as unknown as TaskRuntime, tick: async () => {}, close: async () => {}, stop: async () => [] };
} }));
vi.mock('../src/wiring/fcaBodyWiring.js', () => ({ configuredFcaMinecraft: () => null }));
vi.mock('../src/wiring/fcaReadSources.js', () => ({ createFcaReadSources: () => () => true }));
vi.mock('../src/mind/action/fca/fcaConversationPorts.js', () => ({
  createFcaSourceGuard: () => Object.assign(() => true, { sources: () => true }),
  createFcaConversationBridge: () => ({ taskToolsAvailable: () => true }),
}));
vi.mock('../src/wiring/fcaSharedWiring.js', () => ({ createFcaSharedWiring: () => undefined }));
vi.mock('../src/wiring/fcaMemoryWiring.js', () => ({ connectFcaMemoryTools: () => {} }));
vi.mock('../src/mind/action/fca/fcaVoicePorts.js', () => ({ createFcaVoiceBridge: () => null }));
vi.mock('../src/wiring/fcaResearchWiring.js', () => ({ fcaResearchTools: () => ({ definitions: [], execute: async () => { throw Error('not offered'); } }) }));

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); captured.options = null; captured.recordUsage = null; });

const usage = (estimatedCostUsd: number, usageComplete: boolean): AnthropicFcaUsage => ({ model: 'claude-sonnet-5-5', inputTokens: 10, cachedInputTokens: 0,
  outputTokens: 5, totalTokens: 15, estimatedCostUsd, usageComplete }) as AnthropicFcaUsage;

describe('configuredServerFca books an unconfirmed charge as an estimate (M-4)', () => {
  it('sends a usage that is not complete to the task\'s estimates and a complete one to its confirmed spend, and the ledger gets both in full', async () => {
    const recorded: unknown[] = [];
    const addedEstimate = vi.spyOn(TaskBudgetStore.prototype, 'addEstimate');
    const addedConfirmed = vi.spyOn(TaskBudgetStore.prototype, 'add');
    const service = configuredServerFca({ SHANNON_ADR8_STAGE4: 'on' }, { path: ':memory:', ownerScope: 'owner', ownerAlone: () => true,
      usage: { recordLlmUsage: (row: unknown) => { recorded.push(row); } } as never })!;
    closes.push(() => service.close());
    const budget = captured.options!.budget!;
    const task = { id: 'task-1', scopeKey: 'owner', parentId: null, origin: 'owner_request', kind: 'generic', title: '調べもの' } as never;
    const lease = { id: 'action-1', generation: 2, holder: 'runner' };
    expect(await budget.before(task, lease)).toEqual({ ok: true });
    await inActionExecution({ lease, signal: new AbortController().signal, permit: async () => true } as never, async () => {
      captured.recordUsage!(usage(0.25, false)); // a request that timed out: an upper bound, 40 yen
      captured.recordUsage!(usage(0.125, true)); // an answer: 20 yen, confirmed
    });
    await budget.after(task, lease);
    expect(addedEstimate).toHaveBeenCalledTimes(1);
    expect(addedEstimate).toHaveBeenCalledWith('task-1', 'owner', 'owner_request', 'action-1:2', 40, expect.any(String));
    expect(addedConfirmed).toHaveBeenCalledTimes(1);
    expect(addedConfirmed).toHaveBeenCalledWith('task-1', 'owner', 'owner_request', 20, expect.any(String));
    // The usage ledger (the owner's real spend record) took both in full.
    expect(recorded).toHaveLength(2);
    expect(recorded.map(row => (row as { estimatedCostUsd: number }).estimatedCostUsd)).toEqual([0.25, 0.125]);
  });

  it('books a complete usage only as confirmed spend, and an incomplete one alone as an estimate with no confirmed yen', async () => {
    const addedEstimate = vi.spyOn(TaskBudgetStore.prototype, 'addEstimate');
    const addedConfirmed = vi.spyOn(TaskBudgetStore.prototype, 'add');
    const service = configuredServerFca({ SHANNON_ADR8_STAGE4: 'on' }, { path: ':memory:', ownerScope: 'owner', ownerAlone: () => true,
      usage: { recordLlmUsage() {} } as never })!;
    closes.push(() => service.close());
    const budget = captured.options!.budget!;
    const task = { id: 'task-2', scopeKey: 'owner', parentId: null, origin: 'owner_request', kind: 'generic', title: '調べもの' } as never;
    const only = async (lease: { id: string; generation: number; holder: string }, cost: number, complete: boolean) => {
      await budget.before(task, lease);
      await inActionExecution({ lease, signal: new AbortController().signal, permit: async () => true } as never, async () => { captured.recordUsage!(usage(cost, complete)); });
      await budget.after(task, lease);
    };
    await only({ id: 'a-confirmed', generation: 1, holder: 'runner' }, 0.125, true);
    expect(addedEstimate).not.toHaveBeenCalled();
    expect(addedConfirmed).toHaveBeenCalledWith('task-2', 'owner', 'owner_request', 20, expect.any(String));
    await only({ id: 'a-estimate', generation: 1, holder: 'runner' }, 0.25, false);
    expect(addedEstimate).toHaveBeenCalledWith('task-2', 'owner', 'owner_request', 'a-estimate:1', 40, expect.any(String));
    // The step is still a paid step, with no confirmed yen.
    expect(addedConfirmed).toHaveBeenLastCalledWith('task-2', 'owner', 'owner_request', 0, expect.any(String));
  });
});
