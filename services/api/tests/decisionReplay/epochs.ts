import { decisions, loadRuns } from './load.js';
import { decisionOf, loadScenes } from './score.js';
/** 場面が使う bootstrap の内訳: なし（最初の epoch）/ 本物（最後の epoch）/ 作り直し。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
let none = 0, real = 0, regenerated = 0;
for (const scene of loadScenes()) {
  const decision = decisionOf(runs, scene);
  const last = decisions(runs.get(scene.run)!).at(-1)!.epoch;
  if (decision.epoch === 0) none += 1; else if (decision.epoch === last) real += 1; else regenerated += 1;
}
console.log({ none, real, regenerated });
