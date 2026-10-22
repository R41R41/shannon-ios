import { loadAllRuns } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
import { rewriteLive } from './rewriteLive.js';
/** 書き直した live を見る: `showRewrite.ts s01 [s02 …]`（地図・lastResults は改行を展開）。 */
const runs = loadAllRuns();
for (const id of process.argv.slice(2)) {
  const scene = loadScenes().find(item => item.id.startsWith(`${id}-`))!;
  const d = decisionOf(runs, scene);
  const { live, notes } = rewriteLive(d.live as Record<string, any>);
  const { map, lastResults, around, route, ...body } = live.body;
  console.log(`\n######## ${scene.id}\n`, JSON.stringify({ ...live, body }, null, 1));
  console.log('--- around\n' + (around ?? []).join('\n'));
  console.log('--- route\n' + (route ?? []).join('\n'));
  console.log('--- lastResults\n' + (lastResults ?? []).join('\n====\n'));
  console.log('--- map\n' + map);
  console.log('--- notes', JSON.stringify(notes), 'chars', JSON.stringify(live).length, 'orig', JSON.stringify(d.live).length);
}
