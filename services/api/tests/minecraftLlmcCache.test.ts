import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import type { FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { PLAN_UPDATE_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { LLMC_SYSTEM_APPENDIX } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { createFoodTrend, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { applyPlanUpdate, planPath } from '@shannon/mind';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { layersMap } from './support/minecraftMaps.js';

/**
 * Design mb-llm-centric 1.7 (cache): the tools and the instructions (with the mode's rules, legend and knowledge) are the same bytes at
 * every decision, a request extends the one before (append only), and the map and the plan's path are only in the turn-scoped live
 * message (`clear_at`), never in a stored message.
 */
const body = (name: string, description: string, schema: Record<string, unknown>, effect: 'read' | 'write'): FcaToolDefinition => ({
  name, description, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, nativeInputSchema: schema,
  domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
const TOOLS = [body(MC_ACT_TOOL, ACT_DESCRIPTION, ACT_INPUT_SCHEMA, 'write'), body(MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, 'read'),
  PLAN_UPDATE_DEFINITION];
const world = (x: number) => ({ position: { x, y: 45, z: 277 }, health: 20, food: 18, localMap: layersMap({ x, y: 45, z: 277 }),
  mapLandmarks: [`F かまど (${x},52,277) 上7`], inventory: [{ name: 'bread', count: 3 }] });
const live = (x: number) => minecraftLlmcLive({ elapsedMinutes: 1, trend: createFoodTrend(), events: [],
  observation: { schemaVersion: 1, bodyId: 'b', sequence: x, stateAt: 't', receivedAt: 't', connected: true, state: { world: world(x) }, facts: {} } });

describe('LLM-centric requests keep the cache', () => {
  it('tools and instructions are byte-identical, the request only grows, and the map and the plan are live only', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic((_body, index) => message([{ type: 'thinking', thinking: '', signature: `s${index}` },
      { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { hands: [{ do: 'jump' }] } }], 'tool_use'));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {},
      systemAppendix: LLMC_SYSTEM_APPENDIX });
    const tree = seedPlan('エンドラを倒して')!;
    const input = (history: readonly unknown[], x: number, plan: typeof tree): FcaModelInput => ({
      task: { id: 'task-1', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [],
      history, tools: TOOLS, coreTools: TOOLS, transient: live(x), plan: { ...planPath(plan) }, catalog: TOOLS.map(tool => ({ name: tool.name, description: tool.description })) });
    const first = await model.decide(input([], 201, tree), new AbortController().signal);
    const history = [...first.history, model.toolResults([{ id: 'toolu_0', text: 'act 全部済み', ok: true }])];
    const next = applyPlanUpdate(tree, { ops: [{ op: 'set', id: 'p1.1', state: 'done' }] }).tree;
    await model.decide(input(history, 205, next), new AbortController().signal);
    const [one, two] = fixture.bodies;
    expect(JSON.stringify(two!.tools)).toBe(JSON.stringify(one!.tools));
    expect(JSON.stringify(two!.system)).toBe(JSON.stringify(one!.system));
    expect(JSON.stringify(one!.system)).toContain('マイクラの体の動かし方');
    const before = withoutCacheMarkers(one!.messages as unknown[]), after = withoutCacheMarkers(two!.messages as unknown[]);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    const lastOf = (messages: unknown[]) => messages.at(-1) as { role: string; clear_at?: string; content: string };
    for (const [messages, x, now] of [[before, 201, 'p1.1 原木を集める'], [after, 205, 'p1.2 作業台と木のツルハシ']] as const) {
      const last = lastOf(messages as unknown[]);
      expect(last).toMatchObject({ role: 'system', clear_at: 'next_user_message' });
      const state = JSON.parse(last.content) as { plan: { now: string }; body: { map: string } };
      expect(state.body.map.startsWith(`地図 v1 足=(${x},45,277)`)).toBe(true);
      expect(state.plan.now).toContain(now);
      expect(Object.keys(state).indexOf('plan')).toBeLessThan(Object.keys(state).indexOf('body'));
    }
    // No stored message (everything but the newest live one, which the provider clears) holds a map or the plan.
    const stored = JSON.stringify(after.filter(item => (item as { clear_at?: string }).clear_at === undefined));
    expect(stored).not.toContain('地図 v1');
    expect(stored).not.toContain('"plan"');
  });
});
