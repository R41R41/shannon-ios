import { loadAllRuns } from './allRuns.js';
import { candFrame } from './candidateAdapter.js';
import { decisionOf } from './score.js';
import { frames } from './sceneSet.js';
import { latest } from './views5.js';
import { readRows26, scenes26 } from './sonnet26.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { BODY_RULES, mapView, readLayers } from '../../src/surfaces/minecraft/minecraftLlmcPreflightMap.js';
import { lavaDigStop } from '../../src/surfaces/minecraft/minecraftLlmcPreflightStand.js';

/** 全ての答え（1 回目・聞き直し）の dig の各マスについて、溶岩が隣にあるか・守りが止める条件かを数える。 */
const rows = latest(readRows26()) as any[];
const runs = loadAllRuns();
let digs = 0, lavaNear = 0, held = 0;
for (const scene of scenes26(rows)) {
  const decision = decisionOf(runs, scene);
  const frame = candFrame(decision, frames(runs, decision.run.key)) as any;
  const view = mapView(readLayers(frame.state.world.localMap, BODY_RULES)!);
  for (const row of rows.filter(r => r.scene === scene.id && ['S', 'C', 'O'].includes(r.variant))) {
    for (const raw of [row.rawFirst, row.rawFinal]) {
      if (!raw || !Array.isArray(raw.hands)) continue;
      const input = candidateInput('mc.act', raw) as any;
      for (const hand of input.hands ?? []) {
        if (hand?.do !== 'dig' || hand.rel) continue;
        for (const c of hand.at ?? []) {
          digs += 1;
          const near = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => 'Ll'.includes(view.symbol(c.x + dx!, c.y + dy!, c.z + dz!) ?? '-'));
          if (near) { lavaNear += 1; const stop = lavaDigStop(c, view); if (stop) held += 1; console.log(scene.id.slice(0, 3), row.variant + row.rep, `(${c.x},${c.y},${c.z})`, view.symbol(c.x, c.y, c.z), stop ? 'HELD' : 'not held'); }
        }
      }
    }
  }
}
console.log({ digs, lavaNear, held });
