import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MAP_LEGEND } from '../src/contracts/minecraftActContract.js';
import { MAP_LEGEND_V2 } from '../src/contracts/minecraftMapLegendV2.js';
import { PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA } from '../src/contracts/minecraftProbeContract.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { liquidLines, USE_REACH, useReachStop } from '../src/surfaces/minecraft/minecraftLlmcLiquid.js';
import { BODY_RULES, blocked, bodySymbol, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { repeatedFailures } from '../src/surfaces/minecraft/minecraftLlmcRepeat.js';
import { candidateMenuTools } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { noFloor } from '../src/surfaces/minecraft/minecraftLlmcWalkRules.js';
import { LLMC_TOOLS } from './support/minecraftBodyRequests.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, the body's second candidate (Shannon mb-llmc-cand 974c19f, body cd28661): the legend of the map word for word, the symbols
 * read by what the body's walk does with the block, the reach of 5 m measured from the eye to the middle of the block, and the new text of a walk that
 * did not get on. The legend of the body at 974c19f is `fixtures/body-map-legend-974c19f.txt` (cut from its \`utils/localMap.ts\`).
 */
const bodyLegend = readFileSync(new URL('./fixtures/body-map-legend-974c19f.txt', import.meta.url), 'utf8').replace(/\n$/u, '');

describe('the legend of the map', () => {
  it('is the body\'s, word for word, in the contract, and the instructions of the mode carry its symbol lines as they are', () => {
    expect(MAP_LEGEND_V2).toBe(bodyLegend);
    for (const line of MAP_LEGEND_V2.split('\n').slice(0, 10)) expect(V2_ALWAYS).toContain(line);
    for (const symbolLine of ['Y ネザーのウォートブロック・シュルームライト（固い）', 'q 看板・感圧板・ボタン・レバー（通れる。ブロックは置けない）', 'K 鉄の扉・鉄のトラップドア（手では開かない＝壁）']) {
      expect(V2_ALWAYS).toContain(symbolLine);
    }
  });
  it('leaves the legend of the switch off as it was (its request is the same bytes)', () => {
    expect(MAP_LEGEND).toContain('% 葉・ネザーの葉ブロック / P 板・木の建物 / D 扉 / + 柵・壁・鉄格子・ガラス');
    expect(MAP_LEGEND).not.toContain('Y ネザーのウォートブロック');
    expect(MAP_LEGEND.split('\n')).toHaveLength(MAP_LEGEND_V2.split('\n').length - 1);
  });
});

describe('the symbols as the body\'s walk classes them (the body\'s list, 2026-10-23 15:20)', () => {
  const read = (symbol: string) => bodySymbol(symbol, BODY_RULES);
  // mb-llmc-cand 9 (run 37): a portal is a cell she goes into on purpose, not a cell she never enters.
  const PASSABLE = '., *@!mw-htk=q'.replace(/[ ]/gu, '');
  const OPENED = 'DAJ', BROKEN = '%';
  const WALLS = '#:sIYPK+bNW$EnuOMGXFTCBHS', NEVER = ['L', 'l', 'f', 'x'];
  it('walks through the passable ones, opens D A J and breaks % on the way: none of them is a wall to the guards', () => {
    for (const symbol of [...PASSABLE, ...OPENED, ...BROKEN, 'p', 'e']) expect(blocked(read(symbol)), symbol).toBe(false);
  });
  it('stops at every wall of the body\'s list and at the cells it never enters', () => {
    for (const symbol of [...WALLS, ...NEVER]) expect(blocked(read(symbol)), symbol).toBe(true);
  });
  it('knows what is no floor: a door, a trapdoor, a gate, an iron door, a fence; the other walls hold her', () => {
    for (const symbol of ['D', 'A', 'J', 'K', '+', 'p', 'e', '.', 'w']) expect(noFloor(read(symbol)), symbol).toBe(true);
    for (const symbol of ['#', 'Y', 'P', 'b', 'N', '$', '%']) expect(noFloor(read(symbol)), symbol).toBe(false);
  });
  it('is not changed for a map read without the body\'s rules: the switch off reads P, D and + as before', () => {
    const map = ['地図 v1 足=(0,0,0) x=-1..1 z=-1..1 方式=layers 上=北', 'y=0 x=-1..1 z=-1..1', ' -1 P D +', ' 0 . @ .', ' 1 . . .'].join('\n');
    expect(readLayers(map)!.layers.get(0)!.get('-1,-1')).toBe('P');
    expect(readLayers(map, BODY_RULES)!.layers.get(0)!.get('-1,-1')).toBe('$');
    expect(readLayers(map, BODY_RULES)!.layers.get(0)!.get('0,-1')).toBe('A');
  });
});

describe('the reach of 5 m (utils/blockReach.ts BLOCK_REACH), from the eye (feet + 1.62) to the middle of the block', () => {
  /** An open room, the floor under y=-24, feet (248,-24,204); a water source at (tx,-24,tz). */
  function room(target: [number, number]): BodyObservation {
    const lines = ['地図 v1 足=(248,-24,204) x=245..255 z=202..212 方式=layers 上=北'];
    for (let y = -22; y >= -25; y -= 1) {
      lines.push(y === -22 ? `y=${y} x=245..255 z=202..212` : `y=${y}`);
      for (let z = 202; z <= 212; z += 1) {
        const row = Array.from({ length: 11 }, (_, i) => {
          const x = 245 + i;
          if (y === -24 && x === target[0] && z === target[1]) return 'w';
          if (x === 248 && y === -24 && z === 204) return '@';
          return y === -25 ? '#' : '.';
        });
        lines.push(` ${z} ${row.join(' ')}`);
      }
    }
    return { schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't', receivedAt: 't', connected: true,
      state: { world: { localMap: lines.join('\n'), position: { x: 248.5, y: -24, z: 204.5 }, dimension: 'overworld' } as never }, facts: {} };
  }
  const bucket = (x: number, z: number) => ({ do: 'use', item: 'bucket', at: [{ x, y: -24, z }] });
  it('is one number, 5.0: 4.4 m and 4.6 m go to the body, 5.1 m and 5.8 m are held', () => {
    expect(USE_REACH).toBe(5);
    expect(useReachStop({ hands: [bucket(251, 207)] }, room([251, 207]))).toBeNull();
    expect(useReachStop({ hands: [bucket(250, 208)] }, room([250, 208]))).toBeNull();
    expect(useReachStop({ hands: [bucket(251, 208)] }, room([251, 208]))).toMatchObject({ code: 'use_reach' });
    expect(useReachStop({ hands: [bucket(252, 208)] }, room([252, 208]))!.line).toMatch(/目から 5\.8m（dig・place・use は 5m まで）/u);
  });
  it('says 5 m in the lines of the liquid facts, and 4.6 m is `届く` where the old 4.5 said it was out of reach', () => {
    const mapOf = (target: [number, number]) => (room(target).state.world as { localMap: string }).localMap;
    const lines = liquidLines(mapView(readLayers(mapOf([250, 208]))!), { x: 248, y: -24, z: 204 });
    expect(lines.join('\n')).toContain('(250,-24,208) 目から 4.6m・届く');
    const far = liquidLines(mapView(readLayers(mapOf([252, 208]))!), { x: 248, y: -24, z: 204 });
    expect(far.join('\n')).toContain('届かない（5m まで）');
  });
  it('says 5 m in the descriptions of the mode\'s tools (the probe\'s sight), and not in the switch off\'s', () => {
    const probe: FcaToolDefinition = { name: 'mc.probe', description: PROBE_DESCRIPTION, input: { type: 'object', properties: {}, required: [], additionalProperties: false },
      nativeInputSchema: PROBE_INPUT_SCHEMA, domain: 'minecraft_body', effect: 'read', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] };
    const tools = candidateMenuTools([...LLMC_TOOLS, probe]);
    const text = tools.map(tool => tool.description).join('\n');
    expect(text).not.toContain('4.5m');
    expect(tools.find(tool => tool.name === 'mc.probe')!.description).toContain('5m で届くか');
    expect(PROBE_DESCRIPTION).toContain('4.5m で届くか');
  });
});

describe('the new text of a walk that did not get on (body cd28661)', () => {
  const NEW = '1 walk 止 一歩ではない: 道の5/7番目で: 4秒進めず止まった（今 (251,-24,204)（自分から同じマス）、的まで 1.4m）。probe path の決まりでは歩いて行ける（2 マス）が、'
    + '体はそこまで進まなかった。足のマス (251,-24,204) は 足 water（流れ 5（0 が源、7 が先））・頭 air・下 deepslate。体: 水の中。経路探索は道を見つけた（2 マス）が体は進まなかった。'
    + '次のマス (250,-24,204)（西1）は 足 water（流れ 3（0 が源、7 が先））・頭 air・下 deepslate';
  it('is the same stop to the count of the same stops: the word and the first cell are where they were', () => {
    const body = { lastResults: [NEW], stops: ['(251,-24,204) 一歩ではない ×2 5秒前'] };
    expect(repeatedFailures(body)).toEqual(['同じやり直しはしない: (251,-24,204) の walk は「一歩ではない」で 2 回止まった']);
  });
});
