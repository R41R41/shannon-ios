import { vi } from 'vitest';
import { createAnthropicFcaModel, type AnthropicFcaOptions } from '../../src/infra/models/anthropic/anthropicFcaModel.js';
import type { FcaModelInput, FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA } from '../../src/contracts/minecraftActContract.js';
import { PLAN_UPDATE_DEFINITION } from '../../src/mind/action/fca/fcaPlanTools.js';
import { createFoodTrend, minecraftLlmcLive } from '../../src/surfaces/minecraft/minecraftLlmcLive.js';
import { seedPlan } from '../../src/surfaces/minecraft/minecraftFirstPlan.js';
import { planPath } from '@shannon/mind';
import { message, scriptedAnthropic } from './anthropicFixtures.js';
import { layersMap } from './minecraftMaps.js';

/** Two decisions of an LLM-centric body task (`minecraftOwnPromptOff.test.ts`, `minecraftOwnPrompt.test.ts`): the requests as sent. */
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
