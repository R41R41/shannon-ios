import { writeFileSync } from 'node:fs';
import { loadAllRuns } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
/** 点検用: 場面ごとに、Opus が見た live を読める形（地図・直前の結果は改行のまま）で書き出す。`dumpReadable.ts s01 s02 … 出力ファイル`。 */
const runs = loadAllRuns();
const want = process.argv.slice(2, -1); const out = process.argv[process.argv.length - 1]!;
let text = '';
for (const scene of loadScenes().filter(item => want.includes(item.id.slice(0, 3)))) {
  const d = decisionOf(runs, scene);
  const live = d.live as Record<string, any>;
  const { map, lastResults, ...body } = live.body ?? {};
  text += `\n\n################ ${scene.id}: ${scene.title}\nカテゴリ: ${scene.category.join(',')}\nSITUATION: ${scene.situation}\nCORRECT: ${scene.correct}\nHINDSIGHT: ${scene.hindsight}\n`;
  text += `\n--- LIVE（地図と lastResults 以外。Opus が見た JSON のまま）---\n${JSON.stringify({ ...live, body }, null, 1)}\n`;
  text += `\n--- LIVE body.map（Opus が見た文字列。改行を展開）---\n${map ?? '(なし)'}\n`;
  text += `\n--- LIVE body.lastResults（改行を展開）---\n${(lastResults ?? []).join('\n=====\n') || '(なし)'}\n`;
  text += `\n--- 記録の答え（本番の Opus）---\n${JSON.stringify(d.call?.input ?? null)}\n`;
  text += `\n--- その答えの結果 ---\n${d.resultText.slice(0, 1500)}\n`;
}
writeFileSync(out, text);
console.log('wrote', out, text.length);
