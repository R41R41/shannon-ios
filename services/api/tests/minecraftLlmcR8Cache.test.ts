import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { estimatedAnthropicTokens } from '../src/infra/models/anthropic/anthropicFcaHistory.js';
import { isFcaClearAtMessage, renderedRequest } from '../src/infra/models/anthropic/anthropicFcaTransient.js';
import type { FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { createFcaPlanTools, PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import { ACT_DESCRIPTION, ACT_INPUT_SCHEMA, MC_ACT_TOOL, MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { LLMC_SYSTEM_APPENDIX_R7, LLMC_SYSTEM_APPENDIX_R8 } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createFoodTrend, llmcPlanTokens, llmcTokens, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { readinessParts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { layersMap } from './support/minecraftFootingMaps.js';

/**
 * mb-llmc r8, the cache (production run 32, 2026-10-22: 「キャッシュに無い入力」 a median of 4.7k a decision, about the part of the bill that was
 * not the history's, and a thought that the cache read was nearly 0). What the request is, and what is after its last breakpoint, measured on
 * a request shaped as production's: the Nether, a tunnel in the rock, the map of 917 cells, the plan of the dragon's route, a pack of 16 stacks.
 *
 * - The cache serves the history: three breakpoints (the transport prefix, the fixed instructions, the last stored block), and what is read
 *   from them is the whole replay but the last round (run 32: 32–50k a decision). Nothing in the prefix changes between decisions.
 * - The live state is a turn-scoped system message (`clear_at`): the provider may carry no breakpoint on it, so it is the part after the last
 *   breakpoint, `new` in the usage, at the full input price at every decision. The last round (the answer and its results) is written.
 * - So the input that is not served by the cache is the live state and the last round. The live state is bounded (`LLMC_LIVE_TOKENS`, 3,000,
 *   the plan's path and the body's part together) and has outside the bound the urgent lines, the investigation and the results shown once.
 */
const body = (name: string, description: string, schema: Record<string, unknown>, effect: 'read' | 'write'): FcaToolDefinition => ({
  name, description, input: { type: 'object', properties: {}, required: [], additionalProperties: false }, nativeInputSchema: schema,
  domain: 'minecraft_body', effect, cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
const TOOLS = [body(MC_ACT_TOOL, ACT_DESCRIPTION, ACT_INPUT_SCHEMA, 'write'), body(MC_VIEW_TOOL, VIEW_DESCRIPTION, VIEW_INPUT_SCHEMA, 'read'),
  body(MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA, 'read'), PLAN_UPDATE_RULES_DEFINITION];

const FEET = { x: 251, y: 58, z: 76 };
/** A fortress's rock: netherrack, bricks, air, a few lava cells. */
const mix = (dx: number, dz: number, dy: number): string => {
  const h = Math.abs((dx * 73_856_093) ^ (dz * 19_349_663) ^ (dy * 83_492_791)) % 100;
  return h < 55 ? 'n' : h < 70 ? 'N' : h < 85 ? '.' : h < 92 ? '#' : h < 96 ? 'L' : '*';
};
const world = (x: number) => ({ position: { x: x + 0.5, y: FEET.y, z: FEET.z + 0.5 }, dimension: 'the_nether', health: 20, food: 17, saturation: 3, time: 6000,
  heldItem: 'diamond_pickaxe', worn: 'iron_helmet, iron_chestplate, iron_leggings, iron_boots', inside: 'ネザー要塞の脇',
  localMap: layersMap({ ...FEET, x }, mix),
  mapLandmarks: ['T 作業台 (250,58,77) 東1・上 0', 'F かまど (240,58,70) 西11・上 0', 'S スポナー (262,64,70) 東11・上 6', 'N 要塞のブロック (255,59,74) 東4',
    '[overworld] p ネザーポータル (31,70,9) 拠点', 'L 溶岩の海 (236,31,80) 西15・下 27', 'W 歪んだ幹 (195,66,60) 西56', 'C チェスト (253,58,78) 東2'],
  recentStops: ['(251,58,76)→(250,58,76) 掘れない（見られる） ×2 14秒前', '(252,58,76)→(255,58,76) 一歩ではない ×1 40秒前', '(250,58,76)→(247,58,76) 届かない ×1 60秒前'],
  inventory: [{ name: 'diamond_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }, { name: 'netherrack', count: 192 },
    { name: 'cobbled_deepslate', count: 31 }, { name: 'nether_bricks', count: 45 }, { name: 'basalt', count: 45 }, { name: 'gold_nugget', count: 11 },
    { name: 'water_bucket', count: 1 }, { name: 'cooked_mutton', count: 1 }, { name: 'crimson_stem', count: 3 }, { name: 'crimson_planks', count: 12 },
    { name: 'crafting_table', count: 1 }, { name: 'stick', count: 8 }, { name: 'cobblestone_slab', count: 12 }, { name: 'oak_log', count: 2 }],
  nearbyThreats: [{ id: 696, name: 'wither_skeleton', kind: 'hostile', distance: 14.2, position: { x: 262, y: 64, z: 80 }, canSee: false, canReachMe: true }],
  nearbyEntities: [{ id: 12, name: 'zombified_piglin', distance: 17.5, position: { x: 240, y: 58, z: 90 } }, { id: 13, name: 'item', distance: 3.1, position: { x: 253, y: 58, z: 76 } }] });
const observation = (x: number) => ({ schemaVersion: 1 as const, bodyId: 'b', sequence: x, stateAt: 't', receivedAt: 't', connected: true, state: { world: world(x) as never }, facts: {} });
const LAST_RESULT = ['act 全部済み（7/7、9.4秒）', '1 dig 済 (252,58,76) netherrack を掘った', '2 walk 済 (252,58,76) に着いた（1m、1.1秒）', '3 dig 済 (253,58,76) netherrack を掘った',
  '4 walk 済 (253,58,76) に着いた（1m、1.0秒）', '5 dig 済 (254,58,76) netherrack を掘った', '6 walk 済 (254,58,76) に着いた（1m、1.1秒）', '7 wait 済 0.5秒待った',
  '今 (254,58,76) 体力20 満腹17'].join('\n');
/** An answer as Opus gives one in this mode: a thought (its text is not kept by the provider's account but its signature is), and an act of eight hands. */
const ANSWER = (index: number) => message([{ type: 'thinking', thinking: '', signature: `s${'x'.repeat(380)}${index}` },
  { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { why: '[p1.1] 要塞の下の岩を西へ 1 段下のトンネルで進む', stopIf: { hostileWithin: 8, hpBelow: 12 },
    hands: Array.from({ length: 4 }, (_, k) => [{ do: 'dig', at: [{ x: 252 + k, y: 58, z: 76 }, { x: 252 + k, y: 59, z: 76 }], tool: 'diamond_pickaxe' },
      { do: 'walk', to: { x: 252 + k, y: 58, z: 76 } }]).flat() } }], 'tool_use');

function liveOf(x: number, options: { compact: boolean }) {
  const tree = seedPlan('エンドラを討伐して', 'the_nether')!;
  const port = createFcaPlanTools({ taskId: 'cache-8', checkpoint: { fcaPlanTree: tree }, rules: true, ...(options.compact ? { compact: true } : {}) }).port;
  const view = port.view()!, plan = { ...(options.compact ? port.liveView!() : view) };
  const ready = readinessParts({ plan: () => port.display(), planView: () => view, planTree: () => port.tree() }, view, observation(x));
  const live = minecraftLlmcLive({ observation: observation(x), elapsedMinutes: 8.5, trend: createFoodTrend(), events: ['反射が mc.act を止めた'], lastResults: [],
    ...ready }, llmcPlanTokens(view));
  return { live, plan, tree };
}

describe('the request of a decision of the mode, measured (run 32: the cache and the part that is not its)', () => {
  async function twoDecisions(appendix: string, options: { compact: boolean }) {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic((_body, index) => ANSWER(index));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher: fixture.fetcher, recordUsage() {}, systemAppendix: appendix });
    const first = liveOf(251, options), second = liveOf(254, options);
    const input = (history: readonly unknown[], live: ReturnType<typeof liveOf>): FcaModelInput => ({
      task: { id: 'task-8', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [],
      history, tools: TOOLS, coreTools: TOOLS, transient: live.live, plan: live.plan, catalog: TOOLS.map(tool => ({ name: tool.name, description: tool.description })) });
    const one = await model.decide(input([], first), new AbortController().signal);
    const history = [...one.history, model.toolResults([{ id: 'toolu_0', text: LAST_RESULT, ok: true }])];
    await model.decide(input(history, second), new AbortController().signal);
    return { bodies: fixture.bodies, second };
  }

  /** The index of the message that carries the last cache breakpoint of a request (-1 if none), and how many breakpoints the request has. */
  function breakpoints(request: Record<string, unknown>) {
    const messages = request.messages as Array<{ content: unknown }>;
    const at = messages.map((item, index) => Array.isArray(item.content) && item.content.some(block => (block as { cache_control?: unknown }).cache_control) ? index : -1)
      .filter(index => index >= 0);
    const system = (request.system as Array<{ cache_control?: unknown }>).filter(block => block.cache_control).length;
    return { messageMarks: at, systemMarks: system };
  }

  it('three breakpoints; the prefix is the same bytes; the live state is after the last one; the last round is written', async () => {
    const { bodies, second } = await twoDecisions(LLMC_SYSTEM_APPENDIX_R8, { compact: true });
    const [one, two] = bodies as [Record<string, unknown>, Record<string, unknown>];
    expect(JSON.stringify(two.tools)).toBe(JSON.stringify(one.tools));
    expect(JSON.stringify(two.system)).toBe(JSON.stringify(one.system));
    // The first request marks its stored state (the task, the catalog); the second marks the last stored block, the results of the first round.
    expect(breakpoints(one)).toEqual({ messageMarks: [0], systemMarks: 2 });
    const marks = breakpoints(two);
    expect(marks.systemMarks).toBe(2);
    expect(marks.messageMarks).toHaveLength(1);
    const messages = (two.messages as Array<{ role: string; content: unknown }>);
    const cached = marks.messageMarks[0]!;
    expect(messages[cached]!.role).toBe('user');
    // After the breakpoint there is only the live state, a system message that carries no breakpoint.
    const after = messages.slice(cached + 1);
    expect(after).toHaveLength(1);
    expect(isFcaClearAtMessage(after[0])).toBe(true);
    const live = estimatedAnthropicTokens(after);
    expect(live).toBeGreaterThan(llmcTokens(JSON.stringify(second.live)) * 0.8);
    expect(live).toBeLessThan(llmcTokens(JSON.stringify(second.live)) * 1.3 + 400);
    // The first request's messages (stored) are the start of the second's, but for the markers: the cache's prefix is the same bytes.
    const before = withoutCacheMarkers(one.messages as unknown[]);
    expect(JSON.stringify(withoutCacheMarkers(messages.slice(0, before.length)))).toBe(JSON.stringify(before));
  });

  it('what is not the cache\'s at the second decision, r7\'s shape and r8\'s: the live state, the last round, and the sum', async () => {
    const tokens = (messages: unknown[]) => estimatedAnthropicTokens(messages);
    const measure = async (appendix: string, compact: boolean) => {
      const { bodies, second } = await twoDecisions(appendix, { compact });
      const two = bodies[1] as { messages: Array<{ role: string; content: unknown }>; system: unknown; tools: unknown };
      // As the provider renders it: the first request's live state, cleared by the later user message, is not part of the prompt.
      const rendered = renderedRequest({ messages: two.messages }).messages;
      const mark = rendered.findIndex(item => JSON.stringify(item.content).includes('cache_control'));
      // Read: the system, the tools and the stored state (the first request's breakpoint); written: the last round (the answer and its
      // results); new: after this request's breakpoint, the live state.
      const read = tokens(rendered.slice(0, 1)), written = tokens(rendered.slice(1, mark + 1)), fresh = tokens(rendered.slice(mark + 1));
      const fixed = estimatedAnthropicTokens({ system: two.system, tools: two.tools });
      // The same, counted as the provider counts (`llmcTokens`, fitted to count_tokens): the live message's text, and the last round's calls and results.
      const liveText = String((rendered.at(-1) as { content: unknown }).content);
      const roundText = JSON.stringify(rendered.slice(1, mark + 1).map(item => item.content).map(content => Array.isArray(content)
        ? content.map(block => (block as { type: string }).type === 'thinking' ? null : block) : content));
      return { read, written, fresh, fixed, liveTokens: llmcTokens(JSON.stringify(second.live)), planTokens: llmcTokens(JSON.stringify(second.plan)),
        counted: { fresh: llmcTokens(liveText), written: llmcTokens(roundText) } };
    };
    const before = await measure(LLMC_SYSTEM_APPENDIX_R7, false), after = await measure(LLMC_SYSTEM_APPENDIX_R8, true);
    console.warn(`r8 cache, second decision (estimated tokens): r7 shape new ${before.fresh} + write ${before.written} = ${before.fresh + before.written} `
      + `(live ${before.liveTokens}, plan ${before.planTokens}); r8 shape new ${after.fresh} + write ${after.written} = ${after.fresh + after.written} `
      + `(live ${after.liveTokens}, plan ${after.planTokens}); fixed prefix ${before.fixed} -> ${after.fixed}; counted as the provider counts: r7 new ${before.counted.fresh} `
      + `+ write ${before.counted.written}, r8 new ${after.counted.fresh} + write ${after.counted.written}`);
    // The plan's path and now, repeated by planNow, are left out of the live state.
    expect(after.planTokens).toBeLessThan(before.planTokens);
    expect(after.liveTokens).toBe(before.liveTokens);
    expect(before.fresh - after.fresh).toBeGreaterThan(40);
    // The sum is the live state and the last round. Here, with nothing shown once and no investigation, 3.0k; run 32's median 4.7k had those
    // besides (the results shown once, the scan, the surprises' lines: outside the live state's bound). The map alone is about 1.5k of it.
    expect(after.fresh + after.written).toBeGreaterThan(2_500);
    expect(after.fresh + after.written).toBeLessThan(4_000);
    expect(after.fresh).toBeGreaterThan(after.liveTokens * 0.8);
    // The knowledge's r8 section is in the cached instructions (read at a tenth of the price), not in the live state.
    expect(after.fixed).toBeGreaterThan(before.fixed);

  });
});
