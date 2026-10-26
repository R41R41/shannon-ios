import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { answerText, loadJudged, type JudgeRow } from './judge.js';
import { decisionOf, loadScenes } from './score.js';
import { candidatesOf5, latest, readRows, VIEWS } from './views5.js';

/**
 * 守りを足した候補（cand3）の採点の下ごしらえ（API を使わない）: judge6.jsonl の採点を judge7.jsonl に写し、cand3t の答えが直した候補 cand2t の同じ回の答えと
 * 同じ（手も stopIf も同じ文）なら、cand2t の採点をそのまま cand3t の採点として写す。残り（変わった答え・検査を直して決まらなくなった答え）だけ judge5.ts が採点する。
 */
const out = dataFile('judge7.jsonl');
if (existsSync(out)) writeFileSync(out, '');
const old = loadJudged(dataFile('judge6.jsonl'));
for (const row of old.values()) appendFileSync(out, `${JSON.stringify(row)}\n`);
const runs = loadAllRuns(), rows = latest(readRows());
const views = VIEWS.filter(view => ['cand2t', 'cand3t'].includes(view.id));
let copied = 0, changed = 0;
for (const scene of loadScenes()) {
  const decision = decisionOf(runs, scene);
  const list = await candidatesOf5(scene, decision, rows, views);
  for (const item of list.filter(entry => entry.variant === 'cand3t')) {
    const twin = list.find(entry => entry.variant === 'cand2t' && entry.rep === item.rep);
    const judged = twin ? old.get(`${scene.id}|${twin.key}`) : undefined;
    if (twin && judged && answerText(twin.answer) === answerText(item.answer) && twin.score.failed.join() === item.score.failed.join()) {
      const row: JudgeRow = { ...judged, key: item.key, variant: 'cand3t', rep: item.rep };
      appendFileSync(out, `${JSON.stringify(row)}\n`); copied += 1;
    } else changed += 1;
  }
}
console.log(`copied ${copied}, to judge (changed or newly undecided) ${changed}`);
