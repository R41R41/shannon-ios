import { writeFileSync } from 'node:fs';
import { loadAllRuns } from './allRuns.js';
import { decisionOf, loadScenes } from './score.js';
/** 場面ごとに、Opus が見た live（と直前の結果・記録の答え）を書き出す。`node --import tsx tests/decisionReplay/dumpScene.ts s01 s05 … 出力ファイル`（`all` で全場面。実走27〜34 を読む） */
const runs = loadAllRuns();
const want = process.argv.slice(2, -1); const out = process.argv[process.argv.length - 1]!;
let text = '';
for (const scene of loadScenes().filter(item => want.includes('all') || want.includes(item.id.slice(0, 3)))) {
  const d = decisionOf(runs, scene);
  text += `\n\n========== ${scene.id}: ${scene.title}\nSITUATION: ${scene.situation}\nCORRECT: ${scene.correct}\nHINDSIGHT: ${scene.hindsight}\n`;
  text += `\n--- LIVE (what the model saw this turn) ---\n${JSON.stringify(d.live, null, 1)}\n`;
  text += `\n--- TURN entries (non-live) ---\n${d.turn.filter(e => e.role !== 'system').map(e => JSON.stringify(e.content).slice(0, 4000)).join('\n')}\n`;
  text += `\n--- RECORDED ANSWER ---\n${JSON.stringify(d.call?.input ?? null, null, 1)}\n`;
  text += `\n--- RESULT ---\n${d.resultText.slice(0, 2000)}\n`;
}
writeFileSync(out, text);
console.log('wrote', out, text.length);
