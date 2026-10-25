import { describe, expect, it, vi } from 'vitest';
import type { PlanNode, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import type { FcaModelInput, FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { llmcCoreKnowledge } from '../src/surfaces/minecraft/minecraftKnowledgeCore.js';
import { preflightAct, preflightText } from '../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { BODY_RULES, bodySymbol, END_PORTAL, FENCE, mapView, PORTAL, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { heldBeforeSend } from '../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { goalOf, routeLines } from '../src/surfaces/minecraft/minecraftLlmcRoute.js';
import { candidateAct, candidateLive, candidateMenuTools, minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { stagesFor } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { doneFacts, nodesSeenDone, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';
import lives from './fixtures/minecraft-v2-lives-v1.json' with { type: 'json' };

/**
 * SHANNON_MINECRAFT_LLMC_V2, the fourth round (run 35, death 0 and stop 0 but the body active 49%): the map's symbols read as the body's walk reads
 * them, a place with onFail continue that is not a stop, a target that is a wall told with the standing place beside it, a plan whose places are
 * passed through on the way to work not yet done, and a run from the start of a new world.
 */
const fixtureLive = (lives as Record<string, Record<string, any>>)['s01-r32-1321-head-cell']!;
type Cell = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): Cell => ({ x, y, z });
const feet = at(0, 0, 0);
/** A map of rock (the symbol `rock`) with the cells in `open` made `.` or the symbol given, in the body's layers form around `feet`. */
function mapOf(open: Array<Cell | [Cell, string]> = [], rock = '#'): string {
  const changed = new Map<string, string>(open.map(item => Array.isArray(item) ? [`${item[0].x},${item[0].y},${item[0].z}`, item[1]] : [`${item.x},${item.y},${item.z}`, '.']));
  const lines = [`地図 v1 足=(${feet.x},${feet.y},${feet.z}) x=${feet.x - 7}..${feet.x + 7} z=${feet.z - 7}..${feet.z + 7} 方式=layers 上=北`];
  for (const dy of [2, 1, 0, -1, -2]) {
    const y = feet.y + dy, half = Math.abs(dy) === 2 ? 5 : 7;
    lines.push(Math.abs(dy) === 2 ? `y=${y} x=${feet.x - half}..${feet.x + half} z=${feet.z - half}..${feet.z + half}` : `y=${y}`);
    for (let z = feet.z - half; z <= feet.z + half; z += 1) {
      const row: string[] = [];
      for (let x = feet.x - half; x <= feet.x + half; x += 1) row.push(changed.get(`${x},${y},${z}`) ?? (x === feet.x && y === feet.y && z === feet.z ? '@' : rock));
      lines.push(` ${z} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}
/** A level corridor along +x from the feet, with a floor under it. */
const corridor = (length: number): Cell[] => Array.from({ length: length + 1 }, (_, x) => at(x, 0, 0)).flatMap(cell => [cell, at(cell.x, 1, 0)]);
const walk = (x: number, y: number, z: number) => ({ do: 'walk', to: at(x, y, z) });
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
  state: { world: world as never }, facts: {} });

describe('the map\'s symbols as the body\'s walk reads them (utils/walkRules.ts, utils/localMap.ts)', () => {
  it('reads a portal as a cell she goes into and does not stand on (not harm), the frame, planks and fences as walls, a wooden door as one opened on the way', () => {
    expect(bodySymbol('p', BODY_RULES)).toBe(PORTAL);
    expect(bodySymbol('e', BODY_RULES)).toBe(END_PORTAL);
    for (const symbol of ['Q', 'R', 'P']) expect(bodySymbol(symbol, BODY_RULES)).toBe('$');
    expect(bodySymbol('+', BODY_RULES)).toBe(FENCE);
    expect(bodySymbol('D', BODY_RULES)).toBe('A');
    // The wart blocks have their own symbol (Y) in the legend of mb-llmc-cand 2; the leaves are the only '%': no rule of the dimension.
    for (const symbol of ['%', 'Y', 'K', 'b', 'q', 'J', '#']) expect(bodySymbol(symbol, BODY_RULES)).toBe(symbol);
  });
  it('leaves the map as drawn when no rules are given (the act preflight alone reads what it read before)', () => {
    const map = mapOf([[at(1, 0, 0), 'p']]);
    expect(readLayers(map)!.layers.get(0)!.get('1,0')).toBe('p');
    expect(readLayers(map, BODY_RULES)!.layers.get(0)!.get('1,0')).toBe(PORTAL);
    expect(mapView(readLayers(map)!).symbol(1, 0, 0)).toBe('p');
  });
  it('stops a walk onto a wart block (Y), a pane (b), an iron door (K) and a fence (+); lets a leaf (%), a wooden door (D) and a plate (q) go', () => {
    const stand = (symbol: string) => preflightAct({ hands: [walk(3, 0, 0)] }, { map: mapOf([...corridor(2), at(3, 1, 0), [at(3, 0, 0), symbol] as [Cell, string]]), feet, rules: BODY_RULES });
    for (const symbol of ['Y', 'b', 'K', '+', 'P']) expect(stand(symbol), symbol).toMatchObject({ kind: 'walk', code: 'feet_solid' });
    for (const symbol of ['%', 'D', 'A', 'J', 'q']) expect(stand(symbol), symbol).toBeNull();
  });
  it('stops a walk to a place over a portal with the portal named as the floor that is not one', () => {
    const open = [...corridor(2), [at(2, -1, 0), 'p'] as [Cell, string]];
    const stop = preflightAct({ hands: [walk(2, 0, 0)] }, { map: mapOf(open), feet, rules: BODY_RULES })!;
    expect(stop.why).toContain('下 (2,-1,0) がポータル（立つ床にならない）');
  });
});

describe('a place with onFail continue the map faults', () => {
  /** A place into (5,0,0), a cell of rock the corridor does not reach: the body would not set a block there (occupied). */
  const place = (onFail: string) => ({ do: 'place', block: 'stone', at: [at(5, 0, 0)], onFail });
  it('is not a stop in the mode: the fact goes to a note and the act goes whole', () => {
    const notes: string[] = [];
    const stop = preflightAct({ hands: [place('continue'), walk(2, 0, 0)] }, { map: mapOf(corridor(3)), feet }, { continuePlace: true, notes });
    expect(stop).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('手 1 place:');
    expect(notes[0]).toContain('onFail continue なので体は飛ばして続ける');
  });
  it('is a stop with onFail stop, and as before without the mode', () => {
    expect(preflightAct({ hands: [place('stop')] }, { map: mapOf(corridor(3)), feet }, { continuePlace: true, notes: [] })).toMatchObject({ hand: 1, kind: 'place' });
    expect(preflightAct({ hands: [place('continue')] }, { map: mapOf(corridor(3)), feet })).toMatchObject({ hand: 1, kind: 'place' });
  });
  it('goes through the part-send as a note on the result, and through the replay\'s entry as `note`', () => {
    const world = frame({ localMap: mapOf(corridor(3)), position: feet, dimension: 'overworld' });
    const act = { hands: [place('continue'), walk(2, 0, 0)] };
    const sent = heldBeforeSend(false, act, world, 't')!;
    expect(sent.result).toBeUndefined();
    expect(sent.input).toBeUndefined();
    expect(sent.note).toContain('onFail continue');
    const entry = candidateAct({ hands: ['place stone 5,0,0 onFail=continue', 'walk 2,0,0'] }, world);
    expect(entry.guard).toBeUndefined();
    const stopped = candidateAct({ hands: ['place stone 5,0,0', 'walk 2,0,0'] }, world);
    expect(stopped.note).toBeUndefined();
  });
});

describe('a target that is a wall', () => {
  const map = mapOf(corridor(2));
  it('route: the goal\'s own solid cell is not the aim; the standing place beside it is, and the line says the cell is solid', () => {
    const lines = routeLines(mapView(readLayers(map)!), feet, goalOf('[p1.1] 幹を取る＠3,0,0')!, 'p1.1');
    expect(lines.join('\n')).toContain('目的地のマス (3,0,0) は固い（# 石の類）。隣の立てるマス (2,0,0) を行き先にする（行ける）');
    expect(lines.join('\n')).toContain('(2,0,0)');
  });
  it('route: a goal she can stand in is the aim as it was, and no line is added', () => {
    const lines = routeLines(mapView(readLayers(map)!), feet, goalOf('[p1.1] 歩く＠2,0,0')!, 'p1.1');
    expect(lines.join('\n')).not.toContain('は固い');
  });
  it('route: no standing place beside it is said as the fact it is', () => {
    const lines = routeLines(mapView(readLayers(map)!), feet, goalOf('[p1.1] 岩の奥＠6,0,-5')!, 'p1.1');
    expect(lines.join('\n')).toContain('隣の立てるマスは地図に無い');
  });
  it('guard: a walk to a wall says the standing place beside it in the mode, and the text as before without', () => {
    const plain = preflightAct({ hands: [walk(3, 0, 0)] }, { map, feet })!;
    const mode = preflightAct({ hands: [walk(3, 0, 0)] }, { map, feet }, { bodyRules: true })!;
    expect(plain.why).not.toContain('隣の立てるマス');
    expect(mode).toMatchObject({ kind: 'walk', code: 'feet_solid' });
    expect(mode.why).toContain('隣の立てるマス (2,0,0)');
    expect(preflightText(mode)).toContain('隣の立てるマス (2,0,0)');
  });
});

describe('a plan\'s places are passed through on the way to work not yet done', () => {
  type Row = [id: string, parent: string | null, title: string, doneWhen?: string, state?: PlanNode['state']];
  function treeOf(rows: readonly Row[]): PlanTree {
    const order = new Map<string | null, number>();
    const nodes: PlanNode[] = rows.map(([id, parent, title, doneWhen, state]) => {
      const next = order.get(parent) ?? 0;
      order.set(parent, next + 1);
      return { id, parentId: parent, order: next, title, state: state ?? 'continue', ...(doneWhen ? { doneWhen } : {}) };
    });
    return { schema: 'shannon.plan-tree.v1', revision: 1, current: null, nodes };
  }
  /** Run 35's plan in its shape: p1 the check (open), p2 the place in the Nether, p3 the rods, p5 the overworld. */
  const RUN35: readonly Row[] = [
    ['p1', null, '出発の点検', 'have:crafting_table&food>=100'],
    ['p2', null, '要塞の湧き場', 'at:310,66,74~10@nether'],
    ['p3', null, 'ブレイズの棒', 'have:blaze_rod>=7'],
    ['p5', null, '地上へ戻る', 'dim:overworld'],
  ];
  const nether = frame({ dimension: 'the_nether', position: at(310, 66, 74), inventory: [] });
  const overworld = frame({ dimension: 'overworld', position: at(40, 64, 96), inventory: [] });
  it('closes a node its place shows only once everything before it is done, in the mode', () => {
    const tree = treeOf(RUN35);
    expect(nodesSeenDone(tree, doneFacts(nether)!)).toEqual(['p2']);
    expect(nodesSeenDone(tree, doneFacts(nether)!, true)).toEqual([]);
    expect(nodesSeenDone(tree, doneFacts(overworld)!)).toEqual(['p5']);
    expect(nodesSeenDone(tree, doneFacts(overworld)!, true)).toEqual([]);
  });
  it('closes it when the earlier nodes are done, blocked or closed by the pack in the same pass', () => {
    const done = treeOf(RUN35.map(([id, parent, title, doneWhen]) => [id, parent, title, doneWhen, id === 'p1' ? 'done' : undefined] as Row));
    expect(nodesSeenDone(done, doneFacts(nether)!, true)).toEqual(['p2']);
    const blocked = treeOf(RUN35.map(([id, parent, title, doneWhen]) => [id, parent, title, doneWhen, id === 'p1' || id === 'p2' || id === 'p3' ? 'blocked' : undefined] as Row));
    expect(nodesSeenDone(blocked, doneFacts(overworld)!, true)).toEqual(['p5']);
    const pack = frame({ dimension: 'overworld', position: at(40, 64, 96), inventory: [{ name: 'blaze_rod', count: 7 }, { name: 'crafting_table', count: 1 }], food: 20 });
    const withFood = treeOf([['p1', null, '点検', 'have:crafting_table'], ['p2', null, '地上', 'dim:overworld']]);
    expect(nodesSeenDone(withFood, doneFacts(pack)!, true)).toEqual(['p1', 'p2']);
  });
  it('does not make a node done because of its own parent, and leaves a parent\'s place to its children', () => {
    const tree = treeOf([['p1', null, '地上へ', 'dim:overworld'], ['p1.1', 'p1', '歩く', 'at:40,64,96~4@overworld'], ['p2', null, '次', 'have:iron_ingot>=3']]);
    expect(nodesSeenDone(tree, doneFacts(overworld)!, true)).toEqual(['p1', 'p1.1']);
  });
  it('is the update the plan tool applies', () => {
    const tree = treeOf(RUN35);
    expect(seenDoneUpdate(tree, nether)).toBeNull();
  });
});

describe('a run from the start of a new world (the overworld, nothing carried)', () => {
  const OPEN = [...corridor(4), ...corridor(4).map(cell => at(cell.x, cell.y, 1))];
  const body = () => ({
    planNow: '[p1.1] 原木を集める＠5,0,0', shortage: [], unreachable: [], landmarks: [], stops: [], inventory: [], threats: [], lastResults: [],
    state: { at: '(0,0,0)', dimension: 'overworld', biome: 'plains', time: '1000', weather: 'clear', heldItem: 'なし', worn: '', health: 20, food: 20, saturation: 5, oxygen: 20, minutes: 0.1 },
    map: mapOf(OPEN),
  });
  const plan = { revision: 1, done: '0/12', path: ['出発の点検'], now: 'p1.1 原木を集める＠5,0,0', next: ['p1.2 作業台を作る', 'p1.3 木のツルハシ'], blocked: [] };
  it('picks the preparation stage alone, and builds the around and the route for the plan\'s goal', () => {
    const live = { body: body(), plan };
    expect(stagesFor(live)).toEqual(['prep']);
    const made = candidateLive(live);
    expect(made.stage).toContain('この場面の知識: prep');
    expect(made.stage).not.toContain('nether');
    const out = made.live.body as Record<string, unknown>;
    expect(out.around).toBeTruthy();
    expect(JSON.stringify(out.route)).toContain('目的地のマス (5,0,0) は固い');
  });
  it('is read by the model\'s request: the stage of the preparation in the stored state, the route and the around in the live message', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const probe: FcaToolDefinition = { name: 'mc.probe', description: PROBE_DESCRIPTION, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      nativeInputSchema: PROBE_INPUT_SCHEMA, domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
    const tools = candidateMenuTools([...LLMC_TOOLS, probe]);
    const fixture = scriptedAnthropic((_body, index) => message([{ type: 'thinking', thinking: '', signature: `s${index}` },
      { type: 'tool_use', id: `toolu_${index}`, name: 'mc_act', input: { hands: ['jump 1'] } }], 'tool_use'));
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-opus-5-5', fetcher: fixture.fetcher, recordUsage() {},
      clock: () => ({ localTime: '2026-10-23 04:00', timeZone: 'Asia/Tokyo' }), minecraftOwnPrompt: true, systemAppendix: llmcCoreKnowledge(), minecraftV2: minecraftV2Hooks() });
    const input = { task: { id: 'task-1', title: 'エンドラ', goal: 'エンドラを倒して', completionCriteria: 'ドラゴンを倒す' }, messages: [], children: [], history: [], tools, coreTools: tools,
      transient: body(), plan, waiting: fixtureLive.waiting, observations: fixtureLive.observations, catalog: tools.map(tool => ({ name: tool.name, description: tool.description })) } as unknown as FcaModelInput;
    await model.decide(input, new AbortController().signal);
    vi.restoreAllMocks();
    const sent = JSON.stringify((fixture.bodies[0] as { messages: unknown[] }).messages);
    expect(sent).toContain('この場面の知識: prep');
    expect(sent).not.toContain('この場面の知識: nether');
    expect(sent).toContain('目的地のマス (5,0,0) は固い');
    expect(sent).toContain('around');
  });
});
