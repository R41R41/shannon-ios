import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeMap } from '../src/surfaces/minecraft/minecraftLlmcLiveMap.js';
import { BODY_RULES, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { denormalizeMap, rebuiltLive } from './decisionReplay/liveRebuild.js';
import { dataFile, loadAllRuns } from './decisionReplay/allRuns.js';
import { decisions } from './decisionReplay/load.js';

/** B の直しの比べ（実走36・37 の場面、そろえた地図の書き戻し、基準と修正の木の違い）。API は使わない。 */
const haveData = existsSync(dataFile('export3.txt'));

/** 足 (0,0,0) の周りの岩に、東 1 マスの廊下とその先のポータル（p が足と頭、下は枠 O）。 */
function rawMap(): string {
  const lines = ['地図 v1 足=(0,0,0) x=-7..7 z=-7..7 方式=layers 上=北'];
  for (const dy of [2, 1, 0, -1, -2]) {
    lines.push(`y=${dy} x=-5..5 z=-5..5`);
    for (let z = -5; z <= 5; z += 1) {
      const row: string[] = [];
      for (let x = -5; x <= 5; x += 1) {
        let symbol = '#';
        if (dy === 0 && x === 0 && z === 0) symbol = '@';
        else if (z === 0 && x === 1 && dy >= 0 && dy <= 1) symbol = 'p';
        else if (z === 0 && x === 1 && dy === -1) symbol = 'O';
        row.push(symbol);
      }
      lines.push(` ${z} ${row.join(' ')}`);
    }
  }
  return lines.join('\n');
}

describe('decision replay B: records of runs 36 and 37 are already rewritten lives', () => {
  it('puts the equalised map back to the layers form the rewrite reads', () => {
    const normalized = normalizeMap(rawMap())!;
    expect(readLayers(normalized, BODY_RULES)!.layers.size).toBe(0);
    const back = denormalizeMap(normalized)!;
    const layers = readLayers(back, BODY_RULES)!;
    expect(layers.layers.size).toBe(5);
    expect(denormalizeMap(rawMap())).toBeNull();
  });

  it('rebuilds the map-made fields of a recorded live with this tree\'s rules, and leaves the rest as recorded', () => {
    const live = { plan: { revision: 1 }, body: { planNow: '[p6.4] ゲートを建て入る', around: ['記録のまま'], map: normalizeMap(rawMap()),
      stops: ['(1,0,0) 一歩ではない 3秒前'], state: { at: '(0,0,0)', dimension: 'overworld', time: '99', oxygen: 400 }, inventory: ['coal×3'] } };
    const out = rebuiltLive(live)!.body as Record<string, any>;
    expect(out.around).not.toEqual(['記録のまま']);
    expect(out.around.some((line: string) => line.startsWith('東 (1,0,0):'))).toBe(true);
    expect(out.stops).toEqual(live.body.stops);
    expect(out.inventory).toEqual(live.body.inventory);
    expect(Object.keys(out).indexOf('around')).toBeLessThan(Object.keys(out).indexOf('map'));
    // a live that is not rewritten yet is not touched (the caller uses candidateLive)
    expect(rebuiltLive({ body: { map: rawMap() } })).toBeNull();
  });

  it.runIf(haveData)('reads run 37\'s 146 decisions and the scenes\' rows', () => {
    const run = loadAllRuns().get('r37')!;
    expect(decisions(run)).toHaveLength(146);
    const decision = decisions(run)[127]!;
    expect(decision.row.seq).toBe(1931);
    const out = rebuiltLive(decision.live)!.body as Record<string, any>;
    expect(out.around.some((line: string) => line.startsWith('北 (229,-54,196):'))).toBe(true);
  });
});
