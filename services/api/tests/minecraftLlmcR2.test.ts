import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import {
  actExpectedMilliseconds, actMilliseconds, MAP_LEGEND, MC_ACT_TOOL, MC_VIEW_TOOL, ACT_INPUT_SCHEMA, ACT_DESCRIPTION, type ActResult,
} from '../src/contracts/minecraftActContract.js';
import { normalizeActInput, schemaProblem } from '../src/surfaces/minecraft/minecraftLlmcShape.js';
import { actResultText, llmcLongCall, llmcMilliseconds, llmcPrepare, llmcResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { createFoodTrend, LLMC_LIVE_TOKENS, llmcLiveTokens, llmcPlanTokens, llmcTokens, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { LLMC_SYSTEM_APPENDIX } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { FIRST_PLAN, FIRST_PLAN_SCHEMA, FIRST_PLAN_SYSTEM, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { createBodyTaskRecall } from '../src/mind/recall/bodyTaskRecall.js';
import type { TaskMemory, TaskMemoryItem } from '../src/mind/memory/taskMemoryPorts.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { planPath } from '@shannon/mind';

/**
 * r2 of the LLM-centric mode (2026-10-22): what the scene replay of 2026-10-21 and production run 27 found, mended. Each test fails on
 * 23adae0 (rel31).
 */
const root = new URL('../../../', import.meta.url);

describe('the act as the model writes it (scene replay: Haiku wrote why in a hand 4 times in 12, Sonnet one at as an object)', () => {
  it('takes a hand\'s why out (the act\'s why when it has none) and a lone at as a list, and says so', () => {
    const written = { hands: [{ do: 'walk', to: { x: 1, y: 64, z: 2 }, why: '木へ' },
      { do: 'chest', at: { x: 202, y: 52, z: 277 }, op: 'look' }, { do: 'furnace', at: [{ x: 202, y: 52, z: 277 }], op: 'take', why: 'x' }] };
    const prepared = llmcPrepare(MC_ACT_TOOL, written);
    expect(prepared.problem).toBeNull();
    expect(prepared.input).toEqual({ why: '木へ', hands: [{ do: 'walk', to: { x: 1, y: 64, z: 2 } },
      { do: 'chest', at: [{ x: 202, y: 52, z: 277 }], op: 'look' }, { do: 'furnace', at: [{ x: 202, y: 52, z: 277 }], op: 'take' }] });
    expect(prepared.fixes).toEqual(['手1 の why を act の why にした（why は act に 1 つ）', '手2 の at を配列にした',
      '手3 の why は捨てた（why は act に 1 つ。手には note）']);
    expect(normalizeActInput({ hands: [{ do: 'drop', items: 'cobblestone', target: 41 }], accept: 'blaze' }).input)
      .toEqual({ hands: [{ do: 'drop', items: [{ item: 'cobblestone' }], target: '#41' }], accept: ['blaze'] });
    expect(llmcPrepare(MC_VIEW_TOOL, { mode: 'layers', only: 'water' })).toMatchObject({ input: { mode: 'layers', only: ['water'] }, problem: null });
  });

  it('a refusal says in one line where and how it is wrong', () => {
    expect(schemaProblem({ hands: [{ do: 'walk', to: [1, 64, 2] }] }, ACT_INPUT_SCHEMA)).toBe('手1（walk）の to は {x,y,z}（今は 配列）');
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'walk', to: { x: 1, y: 2, z: 3 }, block: 'dirt' }] }).problem)
      .toBe('手1（walk）: block は使えない（walk の欄: to・path・sprint・range・rel・note・onFail）');
    expect(schemaProblem({ hands: [{ do: 'walk', to: { x: 1, y: 2, z: 3 }, why: 'x', speed: 2 }] }, ACT_INPUT_SCHEMA))
      .toBe('手1（walk）の why・speed は無い欄（why は act に 1 つ）。walk の欄: to・path・sprint・range・rel・note・onFail');
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'wait', seconds: 45 }] }).problem).toContain('手1（wait）の seconds は 0.5〜30（今は 45）');
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'fly' }] }).problem).toContain('手1（fly）の do は walk・dig・');
    expect(llmcPrepare(MC_ACT_TOOL, { hands: Array.from({ length: 13 }, () => ({ do: 'jump' })) }).problem).toContain('hands は 1〜12 個（今は 13 個）');
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'dig', at: [{ x: 1, y: 2 }] }] }).problem).toContain('手1（dig）の at[1] に z が要る');
  });

  it('the result says what the head put into shape, and a stopped hand\'s 3×3×3', () => {
    const act: ActResult = { v: 1, ok: false, done: 0, of: 1, stoppedBy: 'failure', at: { x: 201, y: 45, z: 277 }, hp: 20, food: 18, ms: 900,
      lines: [{ i: 1, do: 'walk', status: 'stopped', line: '一歩ではない: (201,48,277) …', where: { x: 201, y: 48, z: 277 },
        around: 'x=200..202 z=276..278 y=49: #.#/#.#/### y=48: #.#/#.#/### y=47: #.#/#.#/###' }] };
    expect(actResultText(act)).toContain('  周り（上の層から、北が上・西が左）x=200..202 z=276..278 y=49: #.#/#.#/###');
    const receipt = { id: 'r', connectionId: 'c', outcome: 'failed' as const, inputsReleased: true, observedAt: '2026-10-22T00:00:00Z', result: JSON.stringify(act) };
    expect(llmcResult(MC_ACT_TOOL, receipt, null, ['手1 の at を配列にした']).text.startsWith('（頭が形を直して送った: 手1 の at を配列にした）\n')).toBe(true);
  });
});

describe('the act\'s time from its hands (run 27: a walk of 80 m was cut at 17 s; 4 of the first 5 acts hit their deadline)', () => {
  const feet = { x: -5.5, y: 69, z: 10.5 };
  const west80 = { hands: [{ do: 'walk' as const, to: { x: -85, y: 69, z: 10 } }] };
  it('a walk\'s ceiling and its guess grow with its length from where she stands', () => {
    expect(actMilliseconds(west80, feet)).toBeGreaterThan(35_000);
    expect(llmcMilliseconds(MC_ACT_TOOL, west80, feet)).toBeGreaterThan(40_000);
    expect(actExpectedMilliseconds(west80, feet)).toBeGreaterThan(15_000);
    expect(llmcLongCall({ name: MC_ACT_TOOL, input: west80 }, feet)).toBe(true);
    // A path is its points' length; a short one stays short; each hand starts where the one before ended.
    const path = { hands: [{ do: 'walk' as const, path: [{ x: 0, y: 69, z: 10 }, { x: 0, y: 69, z: 40 }] }] };
    expect(actExpectedMilliseconds(path, feet)).toBeGreaterThan(7_000);
    expect(actMilliseconds({ hands: [{ do: 'walk', to: { x: -3, y: 69, z: 10 } }] }, feet)).toBe(5_000);
    const there = { hands: [{ do: 'walk' as const, to: { x: -85, y: 69, z: 10 } }, { do: 'walk' as const, to: { x: -84, y: 69, z: 10 } }] };
    expect(actMilliseconds(there, feet) - actMilliseconds(west80, feet)).toBeLessThan(4_000);
    // Never past the body's own bound (180 s, the command's margin within it).
    expect(actMilliseconds({ hands: [{ do: 'walk', to: { x: 2_000, y: 69, z: 0 } }] }, feet)).toBe(170_000);
  });
  it('every other hand by what it is asked: cells, n, seconds, count', () => {
    const at = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0 }));
    expect(actExpectedMilliseconds({ hands: [{ do: 'dig', at: at(8) }] })).toBeGreaterThan(actExpectedMilliseconds({ hands: [{ do: 'dig', at: at(2) }] }));
    expect(actExpectedMilliseconds({ hands: [{ do: 'craft', item: 'stick', count: 16 }] })).toBeGreaterThan(actExpectedMilliseconds({ hands: [{ do: 'craft', item: 'stick' }] }));
    expect(actExpectedMilliseconds({ hands: [{ do: 'equip', item: 'iron_sword' }] })).toBe(300);
  });
});

describe('the live state\'s tokens as the provider counts them (scene replay: the estimate was 10–48% short)', () => {
  // count_tokens (Opus 5.5), 2026-10-22: 15 rows of 15 cells with their z.
  const grid = (symbol: string) => Array.from({ length: 15 }, (_, i) => `${270 + i} ${Array.from({ length: 15 }, () => symbol).join(' ')}`).join('\n');
  it('water written `~` was three tokens a cell, `w` one; the count is within +0…+15% of the provider\'s', () => {
    for (const [symbol, counted] of [['~', 703], ['#', 268], [';', 493], ['.', 268], ['@', 478], ['w', 268], ['s', 268], ['k', 268]] as const) {
      const tokens = llmcTokens(grid(symbol));
      expect(tokens, symbol).toBeGreaterThanOrEqual(counted);
      expect(tokens, symbol).toBeLessThanOrEqual(counted * 1.15);
    }
    const mixed = Array.from({ length: 20 }, (_, i) => `${270 + i} # . ~ : # # . c ~ ~ # : ; , * # o i ~ #`).join('\n');
    expect(llmcTokens(mixed)).toBeGreaterThanOrEqual(638);
    expect(llmcTokens(mixed)).toBeLessThanOrEqual(638 * 1.15);
  });

  it('a lake\'s map with a full frame and the plan fits 3,000 as counted: the map whole and first, the landmarks and the pack cut last', () => {
    // Shaped as scene 5's map of r2: three layers of 15×15 and two of 11×11, about half of it water (`w`, one token a cell).
    const wide = (y: number) => [`y=${y}`, 'z\\x 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8',
      ...Array.from({ length: 15 }, (_, i) => `${251 + i} # # w w w w w w w # # # # # #`)].join('\n');
    const narrow = (y: number) => [`y=${y} x=196..206 z=253..263`, 'z\\x 6 7 8 9 0 1 2 3 4 5 6',
      ...Array.from({ length: 11 }, (_, i) => `${253 + i} # w w w w w w # # # #`)].join('\n');
    const map = ['地図 v1 足=(201,48,258) x=194..208 z=251..265 方式=layers 上=北', narrow(50), ...[49, 48, 47].map(wide), narrow(46),
      '縦 (201,258) 上: y=49〜51 .×3 / y=52〜64 #×13 …', '縦 (201,258) 下: y=47 # / y=46〜40 w×7 / y=39 #'].join('\n');
    const world = { position: { x: 201.5, y: 48, z: 258.3 }, dimension: 'minecraft:overworld', health: 19.6, food: 14, saturation: 2, localMap: map,
      mapLandmarks: Array.from({ length: 12 }, (_, i) => `F かまど (202,${52 + i},277) 東1・南19・上${4 + i} 自分が置いた raw_iron×3 焼き上がり`),
      recentStops: Array.from({ length: 5 }, (_, i) => `(201,48,258)→(202,47,258) 水の隣 ×${i + 1} ${3 + i}秒前`),
      inventory: Array.from({ length: 30 }, (_, i) => ({ name: `item_${i}`, count: 12 })),
      nearbyThreats: Array.from({ length: 8 }, (_, i) => ({ name: 'zombie', distance: 9 + i, id: 100 + i, position: { x: 210 + i, y: 45, z: 277 } })),
      nearbyEntities: Array.from({ length: 16 }, (_, i) => ({ name: 'cow', distance: 4 + i, id: 200 + i, position: { x: 190 + i, y: 64, z: 270 } })) };
    const observation: BodyObservation = { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z',
      connected: true, state: { world: world as never }, facts: { alive: true } };
    const plan = planPath(seedPlan('エンドラを倒して')!), planTokens = llmcPlanTokens(plan);
    const live = minecraftLlmcLive({ observation, elapsedMinutes: 25.5, trend: createFoodTrend(), events: ['反射が mc.act を止めた'] }, planTokens);
    expect(Object.keys(live)[0]).toBe('map');
    expect(live.map).toBe(map);
    expect(llmcLiveTokens(live) + planTokens).toBeLessThanOrEqual(LLMC_LIVE_TOKENS);
    expect((live.landmarks as string[]).slice(0, 2)).toEqual(world.mapLandmarks.slice(0, 2));
    expect((live.inventory as string[]).length).toBeGreaterThanOrEqual(7);
    expect(live.state).toMatchObject({ at: '(201,48,258)', health: 19.6, food: 14 });
  });
});

describe('the knowledge the scenes asked for (the furnace, water behind stone, the lake, the blaze\'s place)', () => {
  it('is in the cached instructions and the act\'s description', () => {
    for (const words of ['furnace op=take で取る（chest では取れない）', 'その石を dig してから use', '水の溜まり', '下へ掘らない',
      'hold は届く所で', '部屋の床と同じ高さ', '縦穴を上るのは walk ではなく pillarUp', '急ぐ手（離れる walk・食べる）は act の先頭に置く']) expect(LLMC_SYSTEM_APPENDIX).toContain(words);
    for (const words of ['why は act に 1 つ', 'at・path・items は 1 つでも配列', 'かまど（F・燻製器・溶鉱炉）は furnace', '間に固いブロックがあれば先に dig']) {
      expect(ACT_DESCRIPTION).toContain(words);
    }
    expect(MAP_LEGEND).toContain('縦: 足の列の上');
    expect(MAP_LEGEND).toContain('足 ±2 は 11×11');
    for (const words of ['w 水源', 's 砂・砂利', 'k 畑の作物']) expect(MAP_LEGEND).toContain(words);
    expect(LLMC_SYSTEM_APPENDIX).not.toContain('（~）');
  });
});

describe('the first plan asked shorter (run 27: 46 s, 5,221 tokens out, 54 nodes)', () => {
  it('asks 40 nodes of short fields without notes, in fewer tokens', () => {
    expect(FIRST_PLAN.outputTokens).toBeLessThanOrEqual(6_000);
    expect(FIRST_PLAN_SYSTEM).toContain(`節は全部で${FIRST_PLAN.nodes}まで`);
    expect(FIRST_PLAN.nodes).toBe(40);
    expect(FIRST_PLAN_SYSTEM).toContain('note は書かない');
    expect(Object.keys((FIRST_PLAN_SCHEMA.properties.nodes as { items: { properties: object } }).items.properties)).not.toContain('note');
  });
});

describe('the body recall lets the thread go between its searches (run 27: one pool held the API 3.1 s, the loop blocked 4.96 s)', () => {
  it('runs each search on its own turn of the event loop', async () => {
    const turns: string[] = [];
    let ticking = true;
    const tick = () => { if (!ticking) return; turns.push('tick'); setImmediate(tick); };
    const items: TaskMemoryItem[] = [{ id: 'a', summary: 'タスク経験 [success] 目的: x\n行動: 鉄を掘った\n観測結果: 鉄を得た', observedAt: '2026-10-21T00:00:00Z',
      evidence: '', applicability: '', confidence: null, conflicts: [], detailRef: 'a' }];
    const memory: TaskMemory = { available: () => true,
      search() { turns.push('search'); return items; }, read: (_scope, ids) => items.filter(item => ids.includes(item.id)),
      sources: (_scope, ids) => ids.map(id => `source:${id}`), async execute() { throw new Error('unused'); } };
    const recall = createBodyTaskRecall({ memory, state: { snapshot: () => ({}) as never } });
    setImmediate(tick);
    await recall.packet({ scopeKey: 'owner', taskId: 't', goal: 'エンドラ', cues: { words: ['鉄'], tags: [] }, present: OWNER_AUDIENCE });
    ticking = false;
    const searches = turns.flatMap((turn, index) => turn === 'search' ? [index] : []);
    expect(searches).toHaveLength(3);
    // Another turn ran between each search and the next.
    expect(turns.slice(searches[0]! + 1, searches[1]).includes('tick')).toBe(true);
    expect(turns.slice(searches[1]! + 1, searches[2]).includes('tick')).toBe(true);
  });
});

describe('the scene replay\'s script resolves its packages where the API is deployed', () => {
  const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import [^'"]*['"]([^'"]+)['"]/gmu)].map(match => match[1]!)
    .filter(name => !name.startsWith('.') && !name.startsWith('node:') && !builtinModules.includes(name))
    .map(name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!);
  const dependencies = (file: URL) => { const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
    return new Set([...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})]); };
  it('no script at the root imports a package the root does not depend on', () => {
    const rootDeps = dependencies(new URL('package.json', root));
    const scripts = readdirSync(new URL('scripts/', root)).filter(name => name.endsWith('.ts'));
    const missing = scripts.flatMap(name => imports(fileURLToPath(new URL(`scripts/${name}`, root)))
      .filter(name => !rootDeps.has(name)).map(dep => `${name}: ${dep}`));
    expect(missing).toEqual([]);
  });
  it('the scene replay lives in services/api, beside its packages', () => {
    const file = new URL('services/api/scripts/minecraft-llmc-scene.ts', root);
    expect(existsSync(file)).toBe(true);
    const apiDeps = dependencies(new URL('services/api/package.json', root));
    expect(imports(fileURLToPath(file)).filter(name => !apiDeps.has(name))).toEqual([]);
  });
});
