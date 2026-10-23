import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACTION_SECTIONS } from '@shannon/mind';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { foreignToolNames, scrubForeignToolItems } from '../src/contracts/minecraftLlmcToolWords.js';
import { createAnthropicFcaSummarizer } from '../src/infra/models/anthropic/anthropicFcaSummary.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { aroundLines } from '../src/surfaces/minecraft/minecraftLlmcAround.js';
import { createFoodTrend, lookHint, minecraftLlmcLive, minecraftLlmcUrgentLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { preflightAct, preflightText } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { BODY_RULES, HARM, legendOf, mapView, PORTAL, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { breathWords, timeWords } from '../src/surfaces/minecraft/minecraftLlmcStateWords.js';
import { stageKnowledge, V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { candidateFixed } from '../src/wiring/minecraftLlmcV2Request.js';
import { llmcV2Enabled } from '../src/wiring/minecraftLlmcWiring.js';
import { MINECRAFT_REQUEST_CONTEXT, MINECRAFT_REQUEST_CONTEXT_V2 } from '../src/wiring/fcaMinecraftRequests.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the ninth round (run 37, rel41: facts in the model's request that a reader would be misled by). The scenes are built from the
 * words of the run: the lit gate cell told as 「歩けない: がポータル」 among the lava (symbol ¤, not in the legend), the walk into it held (+2,324), the task note
 * naming minecraft.observe, the stages naming find-blocks, a summary that wrote rules and 「次: minecraft.observe で所持品…」, "time":"99" and oxygen 400.
 */
afterEach(() => { vi.restoreAllMocks(); });
type Cell = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });
const feet = at(0, 0, 0);
/** Rock round feet (0,0,0) in the body's layers form, with the cells in `open` (`.` or the symbol given). */
function mapOf(open: Array<Cell | [Cell, string]>): string {
  const changed = new Map<string, string>(open.map(item => Array.isArray(item) ? [`${item[0].x},${item[0].y},${item[0].z}`, item[1]] : [`${item.x},${item.y},${item.z}`, '.']));
  const lines = ['地図 v1 足=(0,0,0) x=-7..7 z=-7..7 方式=layers 上=北'];
  for (const dy of [2, 1, 0, -1, -2]) {
    const half = Math.abs(dy) === 2 ? 5 : 7;
    lines.push(Math.abs(dy) === 2 ? `y=${dy} x=-${half}..${half} z=-${half}..${half}` : `y=${dy}`);
    for (let z = -half; z <= half; z += 1) {
      const row: string[] = [];
      for (let x = -half; x <= half; x += 1) row.push(changed.get(`${x},${dy},${z}`) ?? (x === 0 && dy === 0 && z === 0 ? '@' : '#'));
      lines.push(` ${z} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}
/** A corridor of air east of her to x=`gate - 1`, the gate at x=`gate`: three cells of `symbol` over one of obsidian, as the lit frame is. */
function gateMap(gate: number, symbol = 'p'): string {
  const open: Array<Cell | [Cell, string]> = [];
  for (let x = 1; x < gate; x += 1) open.push(at(x, 0, 0), at(x, 1, 0));
  open.push([at(gate, 0, 0), symbol], [at(gate, 1, 0), symbol], [at(gate, 2, 0), symbol], [at(gate, -1, 0), 'O']);
  return mapOf(open);
}
const viewOf = (map: string) => mapView(readLayers(map, BODY_RULES)!);
const walk = (x: number, y: number, z: number, range = 0) => ({ do: 'walk', to: at(x, y, z), range });
const world = (map: string) => ({ map, feet, rules: BODY_RULES });
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });

describe('B1: a portal is a place she goes into, never lava', () => {
  it('writes the cell next to her as one she can enter, with what it does, and never as 「歩けない」 or with the reader\'s own mark', () => {
    const lines = aroundLines(viewOf(gateMap(1)), feet);
    const east = lines.find(line => line.startsWith('東 '))!;
    expect(east).toBe('東 (1,0,0): 入れる: ネザーポータル（中に立って約 4 秒で次元が変わる）');
    expect(lines.join('\n')).not.toMatch(/歩けない: |¤|¢/u);
    expect(lines.join('\n')).not.toContain('ポータル）が');
  });
  it('lists the gate\'s first cell among the cells to enter (the cells inside over it are the same way in), apart from the lava bucket', () => {
    const lines = aroundLines(viewOf(gateMap(3)), feet);
    expect(lines).toContain('y=0（足） 入れる: ネザーポータル（中に立って約 4 秒で次元が変わる）: z=0 x=3');
    expect(lines.join('\n')).not.toContain('溶岩・火・クモの巣・マグマ');
    expect(lines.join('\n')).not.toMatch(/¤|¢/u);
    // The upper cells of the gate are not listed again, and the lines name no portal at y=+1 or +2.
    expect(lines.filter(line => line.includes('入れる:'))).toHaveLength(1);
  });
  it('tells an end portal by its own words and writes the legend\'s symbols p and e', () => {
    expect(aroundLines(viewOf(gateMap(1, 'e')), feet).find(line => line.startsWith('東 '))).toBe('東 (1,0,0): 入れる: エンドポータル（入ると次元が変わる）');
    expect(legendOf(PORTAL)).toBe('p');
    expect(HARM.has(PORTAL)).toBe(false);
  });
  it('lets the walk into the gate (its first cell, a cell inside over it, a path through both, the end portal too) go, and holds a wall as before', () => {
    const go = (hands: unknown[], symbol = 'p') => preflightAct({ hands }, world(gateMap(3, symbol)), { bodyRules: true });
    expect(go([walk(3, 0, 0)])).toBeNull();
    expect(go([walk(3, 1, 0)])).toBeNull();
    expect(go([{ do: 'walk', path: [at(1, 0, 0), at(2, 0, 0), at(3, 0, 0)], range: 0 }])).toBeNull();
    expect(go([{ do: 'walk', path: [at(1, 0, 0), at(3, 0, 0), at(3, 1, 0)], range: 0 }])).toMatchObject({ code: 'portal_path' });
    expect(go([walk(3, 0, 0)], 'e')).toBeNull();
    expect(go([walk(4, 0, 0)])).toMatchObject({ kind: 'walk', code: 'feet_solid' });
  });
  it('still refuses a block placed into the gate, naming the portal with the legend\'s symbol, and a floor on top of it', () => {
    const stop = preflightAct({ hands: [{ do: 'place', block: 'stone', at: [at(3, 0, 0)] }] }, world(gateMap(3)), { bodyRules: true })!;
    expect(stop).toMatchObject({ kind: 'place', code: 'occupied' });
    expect(stop.why).toContain('ネザーポータル（地図 p）');
    expect(preflightText(stop)).not.toMatch(/¤|¢/u);
    const over = [at(1, 0, 0), at(1, 1, 0), at(2, 0, 0), at(2, 1, 0), at(2, 2, 0), [at(2, -1, 0), 'p'] as [Cell, string]];
    expect(preflightAct({ hands: [walk(2, 0, 0)] }, world(mapOf(over)), { bodyRules: true })!.why).toContain('下 (2,-1,0) がポータル（立つ床にならない）');
  });
  it('says how to go in in the stages\' knowledge (the gate, the way back, the end portal), not in the cached instructions', () => {
    expect(V2_STAGES.prep).toContain('ポータル（p ネザー・e エンド）の入り方: そのマスの中へ walk（range=0');
    expect(V2_STAGES.prep).toContain('約 4 秒立って待つ。着いた先が次元の変化');
    expect(V2_STAGES.nether).toContain('帰りも p のマスの中へ walk して約 4 秒待つ');
    expect(V2_STAGES.pearl).toContain('中の e のマスへ walk（range=0）で入る');
    expect(V2_ALWAYS).not.toContain('入り方');
  });
});

const PROBE: FcaToolDefinition = { name: 'mc.probe', description: PROBE_DESCRIPTION, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  nativeInputSchema: PROBE_INPUT_SCHEMA, domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };

describe('B2: no text of the mode names a tool it does not offer', () => {
  it('finds the names of run 37 and lets the six pass', () => {
    expect(foreignToolNames('全体はminecraft.observeで読む。minecraft.reflexで')).toEqual(['minecraft.observe', 'minecraft.reflex']);
    expect(foreignToolNames('（find-blocks・view top）と find-structure、mc.find-blocks、mc.mine-block')).toEqual(['find-blocks', 'view top', 'find-structure', 'mc.find-blocks', 'mc.mine-block']);
    expect(foreignToolNames('mc.act mc.probe kind=scan mc.view mode=top plan.update fca_wait fca_complete mc_act mc_probe mc_view plan_update')).toEqual([]);
    expect(foreignToolNames('次: minecraft.observe で所持品を確認')).toEqual(['minecraft.observe']);
    expect(scrubForeignToolItems(['a', '次: find-blocks で探す', 'b'])).toEqual({ kept: ['a', 'b'], neutralized: 0, dropped: 1 });
  });
  it('is true of the request\'s fixed part (system blocks and the six tools), the stages, the first plan, the task note and the hints', async () => {
    const fixed = await candidateFixed([...LLMC_TOOLS, PROBE]);
    expect(fixed.tools.map(tool => tool.name)).toEqual(['mc_act', 'mc_probe', 'mc_view', 'plan_update', 'fca_wait', 'fca_complete']);
    for (const block of fixed.system) expect(foreignToolNames(block.text), block.text.slice(0, 40)).toEqual([]);
    for (const tool of fixed.tools) expect(foreignToolNames(JSON.stringify(tool)), String(tool.name)).toEqual([]);
    expect(foreignToolNames(V2_ALWAYS)).toEqual([]);
    for (const [id, text] of Object.entries(V2_STAGES)) expect(foreignToolNames(text), id).toEqual([]);
    const known = stageKnowledge({ body: { state: { dimension: 'overworld' }, planNow: '[p1] 木・鉄・ネザー' }, plan: {} });
    expect(foreignToolNames(known ?? '')).toEqual([]);
    expect(foreignToolNames(JSON.stringify(seedPlan('エンドラを倒して', null, true)))).toEqual([]);
    expect(foreignToolNames(lookHint({ recentStops: ['一歩ではない ×2'] }) ?? '')).toEqual([]);
    expect(foreignToolNames(lookHint({ oxygen: 4 }) ?? '')).toEqual([]);
    expect(foreignToolNames(MINECRAFT_REQUEST_CONTEXT_V2)).toEqual([]);
  });
  it('writes the task note of the mode with its own tools, and keeps the earlier note for every other mode (the switches decide)', () => {
    expect(foreignToolNames(MINECRAFT_REQUEST_CONTEXT)).toEqual(['minecraft.observe', 'minecraft.reflex']);
    expect(MINECRAFT_REQUEST_CONTEXT_V2).toContain('毎判断の live');
    expect(MINECRAFT_REQUEST_CONTEXT_V2).toContain('mc.probe');
    expect(MINECRAFT_REQUEST_CONTEXT_V2).toContain('mc.view');
    const all = { SHANNON_MINECRAFT_LLM_CENTRIC: 'on', SHANNON_MINECRAFT_OWN_PROMPT: 'on', SHANNON_MINECRAFT_LLMC_PROBE: 'on', SHANNON_MINECRAFT_ACT_PREFLIGHT: 'on',
      SHANNON_MINECRAFT_LLMC_V2: 'on' };
    expect(llmcV2Enabled(all)).toBe(true);
    expect(llmcV2Enabled({ ...all, SHANNON_MINECRAFT_LLMC_V2: undefined })).toBe(false);
    expect(llmcV2Enabled({ ...all, SHANNON_MINECRAFT_ACT_PREFLIGHT: undefined })).toBe(false);
  });
  it('tells the scan and the view by the tools\' own words where the stages sent her to find-blocks and view top', () => {
    expect(V2_STAGES.prep).toContain('mc.probe kind=scan');
    expect(V2_STAGES.nether).toContain('mc.probe kind=scan radius=32');
    expect(V2_STAGES.nether).toContain('mc.view mode=top');
  });
});

const usage = { input_tokens: 12, output_tokens: 50, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
const answer = (template: unknown) => message([{ type: 'tool_use', id: 'summary', name: 'fca_history_summary', input: { template } }], 'tool_use',
  { model: 'claude-haiku-5-5', usage });
const empty = () => Object.fromEntries(COMPACTION_SECTIONS.map(section => [section, []]));
const summaryInput = { previous: null, rounds: [{ sequence: 1, stepId: 'step', messages: [{ id: 'm', role: 'user' as const, content: 'Public transcript' }] }] };

describe('B3: the history summary of the mode keeps facts', () => {
  const summarize = async (template: unknown, previous: unknown = null, v2 = true) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const fixture = scriptedAnthropic([answer(template)]);
    const result = await createAnthropicFcaSummarizer({ apiKey: 'synthetic', fetcher: fixture.fetcher, recordUsage() {}, body: true, minecraftOwnPrompt: true,
      ...(v2 ? { minecraftV2Facts: true } : {}) }).summarize({ ...summaryInput, previous: previous as never }, new AbortController().signal);
    return { result: result as Record<string, string[]>, sent: JSON.stringify(fixture.bodies[0]), lines: info.mock.calls.map(call => String(call[0])) };
  };
  it('asks for what was done, where, what failed and why and what is open; no rules, no 「未確認」 for what every live state shows, only the six tools', async () => {
    const { sent } = await summarize({ ...empty(), 済み: ['鉄 4 を (253,-55,154) で掘った'] });
    for (const wanted of ['Write facts only', 'Never write a rule, a limit, a threshold, a constraint or an order for the next step', 'Use [] for 制約',
      'Never call the inventory, the worn armor, health, hunger or the position unknown or unchecked', 'Name no tool except mc.act, mc.probe, mc.view, plan.update, fca_wait and fca_complete',
      'Keep coordinates']) expect(sent).toContain(wanted);
    expect(sent).not.toContain('Preserve constraints');
    for (const section of COMPACTION_SECTIONS) expect(sent).toContain(section);
    expect(foreignToolNames(sent)).toEqual([]);
  });
  it('drops the summary items that name a tool outside the six, from the answer and from the previous summary the answer kept, and logs the count', async () => {
    const previous = { ...empty(), 次: ['find-blocks で黒曜石を探す', 'p2.1 ゲートを建てる'], coversFromId: null, coversToId: null };
    const { result, lines } = await summarize({ 済み: ['鉄 4 を (253,-55,154) で掘った'], 詰まり: ['次: minecraft.observe で所持品・装備を確認（未確認のため）', '(229,-54,196) への walk が止まった: 足の下が空気'] }, previous);
    expect(result['詰まり']).toEqual(['(229,-54,196) への walk が止まった: 足の下が空気']);
    expect(result['次']).toEqual(['p2.1 ゲートを建てる']);
    expect(result['済み']).toEqual(['鉄 4 を (253,-55,154) で掘った']);
    expect(lines.filter(line => line.includes('fca_summary_scrubbed')).map(line => JSON.parse(line))).toEqual([{ event: 'fca_summary_scrubbed', dropped: 2, neutralized: 0 }]);
  });
  it('keeps the words of a fact that only mentions such a name (the name replaced), and leaves real names of the six and look-alikes alone', () => {
    expect(scrubForeignToolItems(['find-blocks が (1,2,3) を指した（計画の where と違う）']))
      .toEqual({ kept: ['（道具名略） が (1,2,3) を指した（計画の where と違う）'], neutralized: 1, dropped: 0 });
    const same = ['mc.act の 3 手目が止まった', 'mc.probe kind=scan で村を見つけた', 'mc.view mode=top で確認済み', 'plan.update で節を足した',
      'mc.acting は道具でない', 'Minecraft.net の話ではない', 'mc.act-ion', 'observed the lava at (1,2,3)', 'observe した結果は無い'];
    expect(scrubForeignToolItems(same).kept.slice(0, 7)).toEqual(same.slice(0, 7));
    expect(scrubForeignToolItems(same.slice(0, 5)).dropped).toBe(0);
    expect(scrubForeignToolItems(['Minecraft.net', 'observed it']).neutralized).toBe(0);
    expect(scrubForeignToolItems(['task.replan を使う', 'goal.verify で確かめる', 'mc.find-blocks で探す', 'minecraft.reflex を呼ぶ']).dropped).toBe(4);
  });
  it('falls back to the previous summary when the scrub leaves nothing, and refuses an answer that is nothing after it when there is none', async () => {
    const previous = { ...empty(), 済み: ['鉄 4 を (253,-55,154) で掘った'], coversFromId: null, coversToId: null };
    const only = { 次: ['次: minecraft.observe で所持品を確認'], 詰まり: ['find-blocks で探す'] };
    const { result } = await summarize(only, { ...previous, 済み: [] });
    expect(Object.values(result).flat().filter(item => typeof item === 'string')).toEqual([]);
    const kept = await summarize({ ...only }, previous);
    expect(kept.result['済み']).toEqual(['鉄 4 を (253,-55,154) で掘った']);
    await expect(summarize(only)).rejects.toMatchObject({ reason: 'empty' });
  });
  it('changes nothing for a summary that is not of the mode (the earlier instruction and no scrub)', async () => {
    const { result, sent, lines } = await summarize({ ...empty(), 次: ['minecraft.observe で確認'] }, null, false);
    expect(result['次']).toEqual(['minecraft.observe で確認']);
    expect(sent).toContain('Preserve constraints, unresolved work');
    expect(sent).not.toContain('Write facts only');
    expect(lines.filter(line => line.includes('fca_summary_scrubbed'))).toEqual([]);
  });
});

describe('B4: her state in words', () => {
  it('says the time of day as a person reads it, from the world\'s ticks', () => {
    expect(timeWords('99', 'overworld')).toBe('朝（日の出から 5 秒、夜まで 約 11 分）');
    expect(timeWords('4439', 'overworld')).toBe('朝（日の出から 約 4 分、夜まで 約 7 分）');
    expect(timeWords('9000', 'overworld')).toBe('昼（夜まで 約 3 分）');
    expect(timeWords('12500', 'overworld')).toBe('夕方（夜まで 25 秒）');
    expect(timeWords('15000', 'overworld')).toBe('夜（朝まで 約 7 分）');
    expect(timeWords('23500', 'overworld')).toBe('明け方（日の出まで 25 秒）');
    expect(timeWords('99', 'the_nether')).toBe('（時刻なし）');
    expect(timeWords('99', 'the_end')).toBe('（時刻なし）');
    expect(timeWords('昼 6:00', 'overworld')).toBeNull();
  });
  it('says the air on one scale: 400 on dry land is full', () => {
    expect(breathWords(400)).toBe('息 20/20');
    expect(breathWords(20)).toBe('息 20/20');
    expect(breathWords(7.4)).toBe('息 7/20');
    expect(breathWords(-3)).toBe('息 0/20');
    expect(breathWords(null)).toBeNull();
  });
  const live = (world: Record<string, unknown>, v2: boolean) => minecraftLlmcLive({ elapsedMinutes: 3, trend: createFoodTrend(() => 0), events: [],
    observation: frame({ position: { x: 1, y: 2, z: 3 }, dimension: 'overworld', health: 20, food: 20, ...world }) }, 0, v2).state as Record<string, unknown>;
  it('puts them in the mode\'s live state (and leaves the other mode\'s as it was: the raw numbers)', () => {
    const early = live({ time: '99', oxygen: 400 }, true), later = live({ time: '4439', oxygen: 20 }, true);
    expect(early).toMatchObject({ time: '朝（日の出から 5 秒、夜まで 約 11 分）', oxygen: '息 20/20' });
    expect(later).toMatchObject({ time: '朝（日の出から 約 4 分、夜まで 約 7 分）', oxygen: '息 20/20' });
    expect(live({ time: '15000', oxygen: 6, dimension: 'the_nether' }, true)).toMatchObject({ time: '（時刻なし）', oxygen: '息 6/20' });
    expect(live({ time: '99', oxygen: 400 }, false)).toMatchObject({ time: '99', oxygen: 400 });
    // The body's numeric timeOfDay is read first, its time string is the fallback.
    expect(live({ time: '24099', timeOfDay: 99, oxygen: 20 }, true)).toMatchObject({ time: '朝（日の出から 5 秒、夜まで 約 11 分）' });
  });
  it('is the same in the urgent live state of the mode', () => {
    const urgent = minecraftLlmcUrgentLive({ observation: frame({ position: { x: 1, y: 2, z: 3 }, dimension: 'overworld', time: '15000', oxygen: 400 }),
      elapsedMinutes: 1, events: [], planNowTitle: null, answer: 'a', v2: true });
    expect(urgent.state).toMatchObject({ time: '夜（朝まで 約 7 分）', oxygen: '息 20/20' });
  });
});

/**
 * The rule the head and the body share for entering a portal: a cell is entered as a portal only when its FEET cell is a portal (`p`, or `e` for the
 * end portal and the end gateway alike) and its head cell is a portal or passable; only as the LAST point of a walk; a walk into one ends the act's
 * walk-through (the dimension changes). The column: floor y=-2, rows y=-1 (bottom), 0 (middle: her own level), +1 (top), the frame over it at y=+2.
 */
describe('the portal cases the head and the body agree on', () => {
  const corridor = [at(1, 0, 0), at(2, 0, 0), at(1, 1, 0), at(2, 1, 0)];
  /** The rows not given as portal are air (the bottom one) or the frame's rock. */
  const column = (symbol: string, rows: number[] = [-1, 0, 1], floor = 'O'): string => mapOf([...corridor, [at(3, -2, 0), floor] as [Cell, string],
    ...rows.map(y => [at(3, y, 0), symbol] as [Cell, string]), ...(rows.includes(-1) ? [] : [at(3, -1, 0)]), [at(3, 2, 0), 'O'] as [Cell, string]]);
  const go = (map: string, hands: unknown[]) => preflightAct({ hands }, world(map), { bodyRules: true });
  const table: Array<[string, string, unknown[], string | null]> = [
    ['bottom row', column('p'), [walk(3, -1, 0)], null],
    ['middle row', column('p'), [walk(3, 0, 0)], null],
    ['middle row with the default range', column('p'), [{ do: 'walk', to: at(3, 0, 0) }], null],
    ['top row: the head meets the frame', column('p'), [walk(3, 1, 0)], 'portal_top'],
    ['end portal over lava', column('e', [-1, 0, 1], 'L'), [walk(3, -1, 0)], null],
    ['end gateway (read as e)', column('e'), [walk(3, 0, 0)], null],
    ['a portal as a middle point of a path', column('p'), [{ do: 'walk', path: [at(2, 0, 0), at(3, -1, 0), at(3, 0, 0)], range: 0 }], 'portal_path'],
    ['a portal as the last point of a path', column('p'), [{ do: 'walk', path: [at(1, 0, 0), at(2, 0, 0), at(3, 0, 0)], range: 0 }], null],
    ['feet in air, a portal over the head', column('p', [0, 1]), [walk(3, -1, 0)], null],
    ['a wall beside the column', column('p'), [walk(4, 0, 0)], 'feet_solid'],
  ];
  it.each(table)('walk to %s', (_name, map, hands, code) => {
    const stop = go(map, hands);
    if (code === null) expect(stop).toBeNull();
    else expect(stop).toMatchObject({ kind: 'walk', code });
    if (stop) expect(preflightText(stop)).not.toMatch(/¤|¢/u);
  });
  it('says the top row is no way in, in the words the coordinator gave', () => {
    expect(go(column('p'), [walk(3, 1, 0)])!.why).toBe('ポータルの最上段は頭が枠に当たって入れない。下の段のポータルのマスへ');
    expect(go(column('p'), [{ do: 'walk', path: [at(2, 0, 0), at(3, -1, 0), at(3, 0, 0)], range: 0 }])!.why).toContain('ポータルは walk の最後の点にだけ');
  });
  it('lists the cell to enter the way the preflight reads it: the bottom row (the rows over it have a portal under them), an end portal over lava, never the top row or a cell in air', () => {
    const around = (map: string) => aroundLines(viewOf(map), feet).join('\n');
    expect(around(column('p'))).toContain('y=-1（-1） 入れる: ネザーポータル（中に立って約 4 秒で次元が変わる）: z=0 x=3');
    expect(around(column('p'))).not.toMatch(/y=0（足） 入れる|y=1（\+1） 入れる/u);
    expect(around(column('e', [-1, 0, 1], 'L'))).toContain('y=-1（-1） 入れる: エンドポータル（入ると次元が変わる）: z=0 x=3');
    expect(around(column('e', [-1, 0, 1], 'L'))).not.toContain('溶岩・火・クモの巣・マグマ: z=0 x=3');
    expect(around(column('p', [0, 1]))).not.toMatch(/y=-1（-1） 入れる/u);
  });
  it('does not walk the hands after a walk into a portal against the old dimension\'s map (the body stops the act there)', () => {
    const wall = walk(4, 0, 0);
    expect(go(column('p'), [wall])).toMatchObject({ code: 'feet_solid' });
    expect(go(column('p'), [walk(3, 0, 0), wall])).toBeNull();
    expect(go(column('p'), [walk(3, 0, 0, 1), wall])).toMatchObject({ hand: 2, code: 'feet_solid' });
    expect(go(column('p'), [walk(2, 0, 0), wall])).toMatchObject({ hand: 2, code: 'feet_solid' });
  });
});
