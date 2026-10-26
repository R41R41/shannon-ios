import { loadAllRuns } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
import { readLayers, mapView, NAMES } from '../../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
/**
 * 場面の live の地図で、マスの記号を引く（点検の補助）。`node --import tsx tests/decisionReplay/cellLook.ts s01 309,67,73 310,66,73 …`
 * 出力: 座標 → 記号（名前）と、その層の x の範囲。地図に無いマスは「地図に無い」。
 */
const [sceneId, ...cells] = process.argv.slice(2);
const runs = loadAllRuns();
const scene = loadScenes().find(item => item.id.startsWith(`${sceneId}-`))!;
const live = decisionOf(runs, scene).live as Record<string, any>;
const map = live.body?.map as string | undefined;
const layers = readLayers(map);
if (!layers) { console.log('地図を読めない'); process.exit(0); }
const view = mapView(layers);
const ranges = new Map<number, string>();
for (const [y, grid] of layers.layers) {
  const xs = [...grid.keys()].map(k => Number(k.split(',')[0])), zs = [...grid.keys()].map(k => Number(k.split(',')[1]));
  ranges.set(y, `x=${Math.min(...xs)}..${Math.max(...xs)} z=${Math.min(...zs)}..${Math.max(...zs)}`);
}
console.log(`足=(${layers.feet.x},${layers.feet.y},${layers.feet.z}) 方式=${layers.mode} 層 y=${[...ranges.keys()].join(',')}`);
for (const cell of cells) {
  const [x, y, z] = cell.split(',').map(Number) as [number, number, number];
  const symbol = view.symbol(x, y, z);
  console.log(`(${x},${y},${z}) → ${symbol === undefined ? '地図に無い' : `${symbol}（${NAMES[symbol] ?? '名前なし'}）`}${ranges.has(y) ? `  [y=${y} の層: ${ranges.get(y)}]` : '  [その高さの層なし]'}`);
}
