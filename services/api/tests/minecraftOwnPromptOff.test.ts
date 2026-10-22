import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel, type AnthropicFcaOptions } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import type { FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { PLAN_UPDATE_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { llmcSystemAppendix } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { planPath } from '@shannon/mind';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { layersMap } from './support/minecraftMaps.js';
import { quiet, requestDigest, scenario, WIDE_POLICY, SUMMARY_POLICY } from './fcaCoreToolsHarness.js';

/**
 * SHANNON_MINECRAFT_OWN_PROMPT off is the request of 3008876b (rel38), byte for byte. The digests below were taken from the code of
 * origin/main 3008876b before the switch existed: the transient body task through the real runtime (`fcaCoreToolsHarness.ts`, old mode:
 * the default model, no appendix), and the LLM-centric model with r3's and r9's appendix (two decisions each, with a shared context and an
 * owner clock). A change that moves one is a change of the production request and of its cache.
 */
const GOLDEN = {
  transient_one_epoch: ['eddf94d3b1ef91bb', '4654cbc14a63f06f', '29c338928c4f6968', 'c7d701daf38462bd', '5e224b1666fe64a8', '1f954f2300fd6062', '6c83287ac9460438', 'bd159dbfd829db5b', '6ab0fa01fc78289a', '1397581d5bbb00b6', '487fc2bee410a252', 'b2cd43c94761cbf6', '7f9f42697d6b700a', '53b878aeefb97208', 'b540873b8ee66064', 'd77f872cf418d38d', '8db7b5e317f65b39', 'cf8ec4d3ab6c8691', 'c3b146509c653106', 'b668f42c6e455171', 'cb4208ac8ca666f7', '412a88b09a2c50f7', 'cab86c3978620ec7', '6ba2885d250f3f8d', '1b3c7567bab82722', '0183e65c217bc13a', '92553a4daf637b05', 'b938600758edf66c', 'd67e7e86df5d810b', 'ca0735af3b0b45f1'],
  transient_summaries: ['eddf94d3b1ef91bb', '4654cbc14a63f06f', '29c338928c4f6968', 'c7d701daf38462bd', '5e224b1666fe64a8', '1f954f2300fd6062', '6c83287ac9460438', 'bd159dbfd829db5b', '6ab0fa01fc78289a', '1397581d5bbb00b6', '96e65cc04c6eecc9', '618e7cbfa9e928ca', '14861444176cfc3b', '4b95dcc001993096', '8082bd578945bd54', '986243b7895b2b7c', '2fcdd4ee172a4ea6', 'a26562c0f4493a6e', '40e1720a7e199452', '85a712416337f6cd', '4e5fd1ac8522395d', '47b5ea5fcd6dedcb', '320e614b4b3f2400', 'f9b05a5c5e73477c', 'a3440dfd6e93254e', '91c50bf7552be186', '9932b51e0651bf11', 'd4f5a098babc10ee', 'c4b888ef93df63b6', '71a51e890bcadd55'],
  llmc_r9: ['98cd4677604476d9', 'ab830df7827b78a4'],
  llmc_r3: ['eaf06e2c7aeae254', '4ae1fde19f78e950'],
};

const live = (step: number) => ({ observation: { position: { x: 10 + step, y: 64, z: -3 }, health: 20, food: 18 }, pace: { minutes: step } });

async function transientDigests(policy: typeof WIDE_POLICY): Promise<string[]> {
  quiet();
  const run = scenario({ mode: () => 'transient', policy, body: live });
  expect(await run.settle()).toBe('completed');
  expect(run.violations).toEqual([]);
  return run.bodies.map(requestDigest);
}

const body = (name: string, description: string, schema: Record<string, unknown>, effect: 'read' | 'write'): FcaToolDefinition => ({
  name, description, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, nativeInputSchema: schema,
  domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
export const LLMC_TOOLS = [body(MC_ACT_TOOL, ACT_DESCRIPTION, ACT_INPUT_SCHEMA, 'write'), body(MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, 'read'),
  PLAN_UPDATE_DEFINITION];
const world = (x: number) => ({ position: { x, y: 45, z: 277 }, health: 20, food: 18, localMap: layersMap({ x, y: 45, z: 277 }),
  mapLandmarks: [`F かまど (${x},52,277) 上7`], inventory: [{ name: 'bread', count: 3 }] });
const llmcLive = (x: number) => minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(() => 0), events: [],
  observation: { schemaVersion: 1, bodyId: 'b', sequence: x, stateAt: 't', receivedAt: 't', connected: true, state: { world: world(x) }, facts: {} } });
const SHARED = { version: 1, affect: { mood: 'calm', valence: 0.2 }, recentOutcomes: [{ eventId: 'ev-1', taskId: 'task-1', name: 'mc_act', observation: 'observed',
  appraisalRevision: 0, result: { ok: true, text: 'act 全部済み' } }] };

/** Two decisions of an LLM-centric body task (the second replays the first), with the given model options. */
export async function llmcRequests(options: Partial<AnthropicFcaOptions>): Promise<Array<Record<string, unknown>>> {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const fixture = scriptedAnthropic((_body, index) => message([{ type: 'thinking', thinking: '', signature: `s${index}` },
    { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { hands: [{ do: 'jump' }] } }], 'tool_use'));
  const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher: fixture.fetcher, recordUsage() {},
    clock: () => ({ localTime: '2026-10-22 21:00', timeZone: 'Asia/Tokyo' }), ...options });
  const tree = seedPlan('エンドラを倒して')!;
  const input = (history: readonly unknown[], x: number): FcaModelInput => ({
    task: { id: 'task-1', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [],
    history, tools: LLMC_TOOLS, coreTools: LLMC_TOOLS, transient: llmcLive(x), plan: { ...planPath(tree) }, sharedContext: SHARED as never,
    catalog: LLMC_TOOLS.map(tool => ({ name: tool.name, description: tool.description })) });
  const first = await model.decide(input([], 201), new AbortController().signal);
  const history = [...first.history, model.toolResults([{ id: 'toolu_0', text: 'act 全部済み', ok: true }])];
  await model.decide(input(history, 205), new AbortController().signal);
  vi.restoreAllMocks();
  return fixture.bodies;
}

describe('SHANNON_MINECRAFT_OWN_PROMPT off is the production request, byte for byte', () => {
  it('prints the digests (golden capture)', async () => {
    const found = {
      transient_one_epoch: await transientDigests(WIDE_POLICY), transient_summaries: await transientDigests(SUMMARY_POLICY),
      llmc_r9: (await llmcRequests({ systemAppendix: llmcSystemAppendix(true) })).map(requestDigest),
      llmc_r3: (await llmcRequests({ systemAppendix: llmcSystemAppendix(false) })).map(requestDigest),
    };
    if (process.env.GOLDEN_CAPTURE) console.error(`GOLDEN ${JSON.stringify(found)}`);
    expect(found).toEqual(GOLDEN);
  }, 120_000);
});
