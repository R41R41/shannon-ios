import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { anthropicFcaHistoryCodec } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import type { FcaExternalTools, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { toolOk } from '../src/mind/tools/shannonTools.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { llmcTools } from '../src/wiring/minecraftLlmcWiring.js';
import { candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { storedBodyResult } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { anthropicRequestViolation } from './support/anthropicProviderRules.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';
import { definition } from './fcaCoreToolsHarness.js';
import lives from './fixtures/minecraft-v2-lives-v1.json' with { type: 'json' };

/**
 * SHANNON_MINECRAFT_LLMC_V2 through the real runtime, the real decision model and the mode's menu (`llmcTools`): the tools of every request are the
 * same six in the same order whatever else the task's catalog holds, the provider's rules hold for every request (the knowledge and the live state
 * in the one turn-scoped message), the hands the model wrote one to a line reach the body's tool as hands, and the history keeps its own lines.
 */
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
const live = (lives as Record<string, Record<string, any>>)['s09-r34-1536-bridge-repeat']!;

describe('SHANNON_MINECRAFT_LLMC_V2 through the runner', () => {
  it('declares the same six tools in every request, runs the hands written in lines, and breaks no rule of the provider', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let time = Date.parse('2026-10-23T00:00:00.000Z');
    const now = () => new Date(time).toISOString();
    const h = actionHarness(now);
    const violations: string[] = [];
    const probe: FcaToolDefinition = { name: 'mc.probe', description: PROBE_DESCRIPTION, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      nativeInputSchema: PROBE_INPUT_SCHEMA, domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
    const catalog = [...candidateMenuTools([...LLMC_TOOLS, probe]), definition('mc.find-blocks', 'minecraft_body'), definition('skill.read', 'skill_read'),
      definition('memory.search', 'memory_read'), definition('task.list', 'task_runtime'), definition('minecraft.observe', 'minecraft_body')];
    const executed: Array<{ name: string; input: unknown }> = [];
    const tools: FcaExternalTools = { definitions: catalog, permitsItself: () => false,
      async execute(call) { executed.push({ name: call.name, input: call.input }); return toolOk('act 全部済み'); } };
    const fixture = scriptedAnthropic((body, index) => {
      const violation = anthropicRequestViolation(body);
      if (violation) violations.push(violation);
      if (index >= 4) return message([{ type: 'tool_use', id: `toolu_${index}_c`, name: 'fca_complete', input: { summary: 'ネザーに入った' } }], 'tool_use');
      return message([{ type: 'thinking', thinking: '次', signature: `signed-${index}-${'s'.repeat(300)}` },
        { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { why: '[p1.1] 離れる', hands: [`walk ${300 + index},66,73`, 'dig 309,67,73 tool=hand'], stopIf: 'hpBelow=10' } }], 'tool_use');
    });
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher: fixture.fetcher, recordUsage() {}, minecraftOwnPrompt: true,
      systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() });
    let decisions = 0;
    const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, model, scopeKey: 'owner', ownerAlone: () => true, now,
      stepPorts: () => ({ tools: llmcTools(tools), keepBodyTools: () => true, obsMode: 'transient' as const,
        selector: { async select(request: { tools: Array<{ name: string }> }) { return { names: request.tools.map(tool => tool.name), source: 'catalog' as const }; } },
        body: { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), guard: async () => true, toolSignal: (_n: string, parent: AbortSignal) => parent,
          close: async () => {}, transient: () => { decisions += 1; return live.body; }, storedResult: (call: { name: string }, text: string) => storedBodyResult(call.name, text) },
        history: { codec: anthropicFcaHistoryCodec } }) as never });
    cleanups.push(async () => { await driver.close(); h.close(); });
    const root = driver.runtime.ensureRoot('owner');
    const task = driver.runtime.createChild('owner', root.id, { title: 'ネザー', goal: 'ネザーに入って', completionCriteria: 'ネザーに入った' }, 'minecraft-request');
    for (let i = 0; i < 300 && !['completed', 'failed', 'unknown'].includes(driver.runtime.get('owner', task.id)?.phase ?? ''); i += 1) {
      await driver.tick();
      await driver.drain();
      time += 1_000;
    }
    expect(driver.runtime.get('owner', task.id)?.phase).toBe('completed');
    expect(violations).toEqual([]);
    const decide = fixture.bodies.filter(body => (body.tools as Array<{ name?: string }>).some(tool => tool.name === 'mc_act'));
    expect(decide.length).toBeGreaterThanOrEqual(4);
    for (const body of decide) {
      expect((body.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual(['mc_act', 'mc_probe', 'mc_view', 'plan_update', 'fca_wait', 'fca_complete']);
    }
    expect(new Set(decide.map(body => JSON.stringify(body.tools))).size).toBe(1);
    expect(executed.map(item => item.name)).toEqual(Array(executed.length).fill('mc.act'));
    expect(executed.length).toBeGreaterThanOrEqual(3);
    expect(executed[0]!.input).toMatchObject({ hands: [{ do: 'walk', to: { x: 300, y: 66, z: 73 } }, { do: 'dig', at: [{ x: 309, y: 67, z: 73 }], tool: 'hand' }], stopIf: { hpBelow: 10 } });
    const last = decide.at(-1)!.messages as Array<Record<string, any>>;
    expect(JSON.stringify(last)).toContain('walk 300,66,73');
    expect(JSON.stringify(last)).not.toContain('"do":"walk"');
    expect(Object.keys(JSON.parse(String(last.at(-1)!.content)))).not.toContain('knowledge');
    // The stages' knowledge is stated once, in the first state, and stands (it did not change in these decisions).
    expect(JSON.stringify(last.slice(0, -1)).split('stageKnowledge').length - 1).toBe(1);
    expect(decisions).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
