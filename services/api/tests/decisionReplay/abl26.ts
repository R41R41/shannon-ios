import { loadAllRuns, dataFile } from './allRuns.js';
import { loadJudged, type Candidate } from './judge.js';
import { decisionOf } from './score.js';
import { candidatesOf5, latest } from './views5.js';
import { readRows26, scenes26, VIEWS26, short } from './sonnet26.js';

/** 切り分け（urgent の 6 場面）: 同じ採点の呼び出しの中での各版の平均点。 node --import tsx tests/decisionReplay/abl26.ts judge26c.jsonl */
const judged = loadJudged(dataFile(process.argv[2] ?? 'judge26c.jsonl'));
const rows = latest(readRows26());
const runs = loadAllRuns();
const want = ['s17', 's62', 's34', 's21', 's16', 's18'];
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const variants = ['S', 'C', 'A1', 'A2'];
const per: Record<string, Record<string, number[]>> = {};
for (const scene of scenes26(rows).filter(s => want.includes(short(s.id)))) {
  const decision = decisionOf(runs, scene);
  for (const item of await candidatesOf5(scene, decision, rows, VIEWS26)) {
    if (!variants.includes(item.variant)) continue;
    let verdict: string = item.score.verdict;
    if (verdict !== '×' && !(verdict === '○' && scene.judge !== 'always')) verdict = judged.get(`${scene.id}|${item.key}`)?.verdict ?? '?';
    ((per[short(scene.id)] ??= {})[item.variant] ??= []).push(points[verdict]!);
  }
}
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
console.log('| 場面 | ' + variants.join(' | ') + ' |', '\n|---|' + variants.map(() => '---:').join('|') + '|');
const totals: Record<string, number[]> = {};
for (const s of want) { console.log(`| ${s} | ${variants.map(v => mean(per[s]?.[v] ?? []).toFixed(2)).join(' | ')} |`); for (const v of variants) (totals[v] ??= []).push(mean(per[s]?.[v] ?? [])); }
console.log(`| 平均 | ${variants.map(v => mean(totals[v]!.filter(Number.isFinite)).toFixed(2)).join(' | ')} |`);
