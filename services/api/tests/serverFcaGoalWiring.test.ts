import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskCommit, TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { TaskRuntimeWiringOptions } from '../src/wiring/taskRuntimeWiring.js';
import type { MinecraftControlCommand } from '../src/contracts/minecraftControlContract.js';
import { runFcaStep } from '../src/mind/action/fca/fcaRunner.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { actionResource } from '../src/contracts/actionThreadContract.js';
import { configuredServerFca } from '../src/wiring/serverFcaWiring.js';
const captured = vi.hoisted(() => ({ options: null as TaskRuntimeWiringOptions | null, runtime: null as TaskRuntime | null, minecraft: null as any, observationSignals: [] as string[] }));
vi.mock('../src/infra/models/anthropic/haikuConfig.js', async importOriginal => ({ ...await importOriginal<object>(),
  configuredResponseModel: () => ({ model: 'offline-fixture', apiKey: '' }), replacementModel: () => 'offline-fixture' }));
vi.mock('../src/infra/models/anthropic/anthropicFcaModel.js', () => ({ createAnthropicFcaModel: () => ({
  decide: async () => ({ decision: { kind: 'complete', summary: 'Model claimed victory' }, history: [] }), toolResults: () => null,
}) }));
vi.mock('../src/infra/models/anthropic/anthropicFcaSummary.js', () => ({ createAnthropicFcaSummarizer: () => ({}) }));
vi.mock('../src/infra/ipc/mindSocket.js', () => ({ MindSocketClient: class { call = vi.fn(); close() {} } }));
vi.mock('../src/wiring/skillRoutingWiring.js', () => ({ configuredJevChooser: () => null }));
vi.mock('../src/wiring/taskRuntimeWiring.js', () => ({ createTaskRuntimeWiring: (options: TaskRuntimeWiringOptions) => {
  captured.options = options;
  return { runtime: captured.runtime!, tick: async () => {}, close: async () => {}, stop: async () => [] };
} }));
vi.mock('../src/wiring/fcaBodyWiring.js', () => ({ configuredFcaMinecraft: () => captured.minecraft }));
vi.mock('../src/wiring/fcaTaskObservationWiring.js', () => ({ createFcaTaskObservationMonitor: () => ({
  start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), guard: async () => true, close: async () => {},
}) }));
vi.mock('../src/surfaces/minecraft/minecraftReflexAdapter.js', () => ({ createMinecraftTaskBody: () => ({
  body: { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), guard: async () => true, close: async () => {},
    toolSignal: (name: string, signal: AbortSignal) => { captured.observationSignals.push(name); return signal; } },
  tools: { definitions: [], execute: async () => { throw Error('not offered'); } }, safeToAcknowledgeStop: () => true,
}) }));
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
afterEach(async () => { for (const close of closes.splice(0)) await close(); captured.minecraft = null; captured.options = null; });
function fixture(goal: string, connected = false, researchDependencies = false) {
  captured.observationSignals = [];
  let phase = 'executing', witnessed = false;
  const at = '2026-10-09T00:00:00.000Z';
  const step: TaskStep = { id: 'segment1', scopeKey: 'owner', taskId: 'original-task', revision: 1, messageIds: [],
    lease: { id: 'lease1', generation: 3, holder: 'runner1' }, snapshot: { revision: 1, messages: [], sources: [], history: [], checkpoint: null,
      task: { id: 'original-task', scopeKey: 'owner', parentId: 'root', kind: 'generic', origin: 'owner_request', goal, completionCriteria: 'fresh native proof',
        title: goal, summary: '', status: 'running', pauseReason: null, phase: 'executing', childIds: [], revision: 1, createdAt: at, updatedAt: at } } };
  const commits: TaskCommit[] = [], commands: MinecraftControlCommand[] = [], permits: readonly string[][] = [];
  const runtime = {
    get: () => ({ ...step.snapshot.task, phase }), taskSources: () => [], list: () => [],
    commitStep: (_: TaskStep, commit: TaskCommit) => { commits.push(commit); phase = commit.disposition === 'complete' ? 'completed' : 'ready';
      return { ...step.snapshot, checkpoint: commit.checkpoint, task: { ...step.snapshot.task, phase } }; },
  } as unknown as TaskRuntime;
  captured.runtime = runtime;
  const catalog = [{ name: 'goal-evidence', description: 'trusted native query fixture', readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }];
  const control = { configuration: { deviceId: 'native-device' }, store: { body: () => null, bind: () => true }, available: () => connected ? ['minecraft:home'] : [],
    frame: () => connected ? { poll: { skills: catalog } } : null,
    command: async (command: MinecraftControlCommand) => {
      commands.push(command);
      const context = command.context;
      // NativeGoalEvidence's exact wire contract: original goal and criterion, not provider suggestions.
      const contextKey = createHash('sha256').update(JSON.stringify([context.scopeKey, context.taskId, context.bodyId, context.goal, context.completionCondition])).digest('hex');
      return { outcome: 'completed', inputsReleased: true, result: JSON.stringify({ contextKey, connected, boss: { verified: witnessed } }) };
    } };
  captured.minecraft = connected ? { control, entry: null, selector: null } : null;
  const tools = { useTaskRuntime() {}, useMinecraftTasks() {} };
  const service = configuredServerFca({ SHANNON_FCA_RUNTIME: 'on', SHANNON_ADR8_STAGE4: 'on' }, {
    path: ':memory:', ownerScope: 'owner', ownerAlone: () => true, usage: { recordLlmUsage() {} } as never,
    minecraftConfiguration: { servers: new Map([['home', {}]]) } as never,
    ...(researchDependencies ? { tools: tools as never, state: {} as never, conversations: {} as never } : {}),
  })!;
  closes.push(() => service.close());
  const ports = captured.options!.stepPorts!(runtime, step);
  const signal = new AbortController().signal;
  const run = () => { phase = 'executing'; return inActionExecution({ lease: step.lease, signal, permit: async resources => {
    (permits as string[][]).push([...(resources ?? [])]); return true;
  } }, () => runFcaStep(step, { ...ports, history: undefined, runtime, model: captured.options!.model,
    taskTools: false, ownerAlone: () => true, permit: async () => true }, signal)); };
  return { ports, run, commands, commits, permits, witness: () => { witnessed = true; } };
}
describe('configuredServerFca original-goal verification wiring', () => {
  it.each([false, true])('refuses a known original dragon goal while disconnected (research dependencies: %s)', async research => {
    const f = fixture('エンドラを討伐してください', false, research);
    const result = await f.run();
    expect(result.task.phase).toBe('ready'); expect(f.commits[0]?.disposition).toBe('continue');
    expect(f.ports.tools?.progress?.context().verification).toMatchObject({ status: 'not_verified', checks: [{ failure: 'not_offered' }, { failure: 'not_offered' }, { failure: 'not_offered' }] });
    expect(f.commands).toEqual([]);
  });
  it('keeps unrelated original goals unbound and explicitly self-reported', async () => {
    const f = fixture('石の入手方法を調べて'); const result = await f.run();
    expect(result.task.phase).toBe('completed'); expect(f.ports.tools?.progress?.context().binding).toBeUndefined();
    expect(f.ports.tools?.progress?.context().verification?.status).toBe('self_reported');
  });
  it('uses exact native task context and the existing body lease for fresh evidence before permitting completion', async () => {
    const f = fixture('エンダードラゴンを討伐してください', true, true);
    expect((await f.run()).task.phase).toBe('ready');
    expect(f.commands).toHaveLength(3); expect(f.commands.every(command => command.skill === 'goal-evidence' && command.context.taskId === 'original-task')).toBe(true);
    expect(captured.observationSignals).toEqual(['mc.goal-evidence', 'mc.goal-evidence', 'mc.goal-evidence']);
    expect(f.commands[0]?.context).toMatchObject({ scopeKey: 'owner', bodyId: 'minecraft:home', sessionId: 'segment1', generation: 3,
      goal: 'エンダードラゴンを討伐してください', completionCondition: 'fresh native proof' });
    expect(f.ports.tools?.progress?.context().verification?.checks[0]?.passed).toBe(true);
    expect(f.permits).toContainEqual([actionResource('native-device', 'minecraft-body')]);
    f.witness(); expect((await f.run()).task.phase).toBe('completed');
    expect(f.ports.tools?.progress?.context().verification?.status).toBe('verified');
  });
});
