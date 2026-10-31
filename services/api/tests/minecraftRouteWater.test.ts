import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BODY_RULES, mapView, readLayers } from '../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { routeLines } from '../src/surfaces/minecraft/minecraftLlmcRoute.js';

const scene = JSON.parse(readFileSync(new URL('./fixtures/run57-water-entry-map.json', import.meta.url), 'utf8'));
// The recorded model input is a displayed crop, with human-readable height labels.
// Restore only the layer headers for the parser; never invent the omitted cells.
const lines = (map: string) => routeLines(mapView(readLayers(map.replace(/^y=(-?\d+).*$/gmu, 'y=$1'), BODY_RULES)!), scene.feet, scene.goal, 'p4.1');

describe('water exposure in candidate routes', () => {
  it('shows submerged head cells in the actual pre-entry run57 map instead of silently offering the aquifer route', () => {
    expect(scene.recordedRoute.join('\n')).not.toContain('頭のマスが水');
    const route = lines(scene.map).join('\n');
    expect(route).toContain('頭のマスが水の道の点（足の座標）');
    expect(route).toContain('呼吸地点への退路・往復時間は未検証');
    expect(route).not.toContain('呼吸を確保');
  });
  it('also exposes flowing water, without declaring its return route safe', () => {
    expect(lines(scene.map.replaceAll('w', '-')).join('\n')).toContain('頭のマスが水');
  });
  it('does not invent water when the observed cells are dry', () => {
    expect(lines(scene.map.replaceAll('w', '.')).join('\n')).not.toContain('頭のマスが水');
  });
});
