import { describe, expect, it } from 'vitest';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { liquidLines } from '../src/surfaces/minecraft/minecraftLlmcLiquid.js';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { givenUp, keptSurfaceWaterWalk, summaryWaterPlaces, waterFailures, waterFailuresOfFrame, waterSwitchLine } from '../src/surfaces/minecraft/minecraftLlmcWaterSwitch.js';

/**
 * 2026-11-13 (flow design D, run 9: 11 not_filled stops on one underground pool, two `replace` hands that cancelled the walk to the surface water):
 * after two failures of one pool its sources are not offered again, the line says the surface water, and the walk to it is kept. Pure functions only.
 */
const SUMMARY = '水源 3か所: 12m 南 (194,35,-198)、95m 北 (210,63,-300)、140m 東 (400,62,-190)\n鉱石: 鉄 2か所';
const fails = (stops: string[]) => waterFailures({ stops });
const act = (hands: unknown[], why = '', extra: Record<string, unknown> = {}): ActInput => ({ hands, why, ...extra }) as unknown as ActInput;

describe('a pool the bucket could not draw twice', () => {
  it('is read from the body counts: not_filled twice or more at a cell, a single failure is not enough', () => {
    expect(fails(['(195,35,-200) not_filled ×3 12秒前'])).toEqual([{ cell: { x: 195, y: 35, z: -200 }, count: 3 }]);
    expect(fails(['(195,35,-200) not_filled ×1 12秒前'])).toEqual([]);
    expect(fails(['(195,35,-200) cannot_dig ×5 12秒前'])).toEqual([]);
    expect(waterFailuresOfFrame({ recentStops: ['(195,35,-200) not_filled ×2 5秒前'] })).toHaveLength(1);
    expect(waterFailuresOfFrame(undefined)).toEqual([]);
  });
  it('gives up every source within 4 m of the failed cell, not a pond far away', () => {
    const failed = fails(['(195,35,-200) not_filled ×2 12秒前']);
    expect(givenUp({ x: 194, y: 35, z: -198 }, failed)).toBe(true);
    expect(givenUp({ x: 210, y: 63, z: -300 }, failed)).toBe(false);
  });
  it('says the underground pool is given up and the surface water of the map, not the pool, with the count', () => {
    const line = waterSwitchLine(fails(['(195,35,-200) not_filled ×3 12秒前']), SUMMARY, { x: 195, y: 36, z: -199 });
    expect(line).toBe('地下のこの水は汲めなかった（3 回）。地表の水へ: 95m (210,63,-300)・140m (400,62,-190)');
    expect(waterSwitchLine([], SUMMARY, { x: 0, y: 36, z: 0 })).toBeNull();
    expect(summaryWaterPlaces(SUMMARY)).toHaveLength(3);
    expect(summaryWaterPlaces(undefined)).toEqual([]);
  });
});

describe('the liquid lines after a pool is given up', () => {
  // A small rock room with one water source at (251,-24,208); feet (248,-24,204).
  const FEET = { x: 248, y: -24, z: 204 };
  const mapText = (): string => {
    const lines = [`地図 v1 足=(${FEET.x},${FEET.y},${FEET.z}) x=245..255 z=202..212 方式=layers 上=北`];
    for (let y = -22; y >= -25; y -= 1) {
      lines.push(y === -22 ? `y=${y} x=245..255 z=202..212` : `y=${y}`);
      for (let z = 202; z <= 212; z += 1) {
        const row: string[] = [];
        for (let x = 245; x <= 255; x += 1) row.push(x === FEET.x && y === FEET.y && z === FEET.z ? '@' : x === 251 && y === -24 && z === 208 ? 'w' : '.');
        lines.push(` ${z} ${row.join(' ')}`);
      }
    }
    return lines.join('\n');
  };
  it('lists the source before, and after two failures leaves it out and says the switch with the surface water', () => {
    const layers = readLayers(mapText())!;
    const view = mapView(layers);
    expect(liquidLines(view, layers.feet).join('\n')).toContain('水の源（汲み戻せる）: (251,-24,208)');
    const failed = waterFailures({ stops: ['(251,-24,208) not_filled ×2 5秒前'] });
    const after = liquidLines(view, layers.feet, { fails: failed, summary: SUMMARY }).join('\n');
    expect(after).toContain('地下のこの水は汲めなかった（2 回）。地表の水へ: 95m (210,63,-300)');
    expect(after).not.toContain('水の源（汲み戻せる）');
  });
  it('is the same as before when nothing failed twice', () => {
    const layers = readLayers(mapText())!;
    const view = mapView(layers);
    expect(liquidLines(view, layers.feet, { fails: [] })).toEqual(liquidLines(view, layers.feet));
  });
});

describe('a walk to the surface water is not cancelled by a retry of the underground pool', () => {
  const failed = fails(['(195,35,-200) not_filled ×2 12秒前']);
  const walk = { item: 'q79', input: act([{ do: 'go', to: { x: 210, y: 63, z: -300 } }], '地表の水へ向かう') };
  const other = { item: 'q78', input: act([{ do: 'dig', at: [{ x: 1, y: 1, z: 1 }] }], '掘る') };
  const retry = act([{ do: 'use', item: 'bucket', at: [{ x: 195, y: 35, z: -200 }] }], '水を汲む', { replace: ['q79'] });
  it('keeps the walk named by replace when the new act draws the given-up pool, and says so', () => {
    const kept = keptSurfaceWaterWalk([walk, other], ['q79'], retry, failed);
    expect(kept.keep).toEqual(['q79']);
    expect(kept.note).toContain('残した: q79');
  });
  it('keeps it when replace says all, and leaves a walk that is not to the surface water, and other pools, alone', () => {
    expect(keptSurfaceWaterWalk([walk, other], ['all'], retry, failed).keep).toEqual(['q79']);
    expect(keptSurfaceWaterWalk([other], ['q78'], retry, failed).keep).toEqual([]);
    expect(keptSurfaceWaterWalk([walk], ['q79'], act([{ do: 'use', item: 'bucket', at: [{ x: 300, y: 35, z: 300 }] }]), failed).keep).toEqual([]);
    expect(keptSurfaceWaterWalk([walk], ['q79'], act([{ do: 'go', to: { x: 0, y: 40, z: 0 } }]), failed).keep).toEqual([]);
  });
  it('changes nothing when no pool failed twice (the general replace is the decision\'s)', () => {
    expect(keptSurfaceWaterWalk([walk], ['q79'], retry, [])).toEqual({ keep: [], note: null });
  });
});
