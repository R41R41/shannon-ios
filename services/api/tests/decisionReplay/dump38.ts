import { writeFileSync } from 'node:fs';
import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { rebuiltLive } from './liveRebuild.js';
/** 実走38 の判断（d 番号）の seq・epoch・live（この木の作り直し）・記録の答え・結果を書き出す。`node --import tsx tests/decisionReplay/dump38.ts 6 27 54 89 127 出力ファイル` */
const want = process.argv.slice(2, -1).map(Number), out = process.argv[process.argv.length - 1]!;
const ds = decisions(loadAllRuns().get('r38')!);
let text = '';
for (const n of want) {
  const d = ds[n - 1]!;
  const live = rebuiltLive(d.live as Record<string, any>) ?? d.live;
  const body = (live as Record<string, any>).body ?? {};
  text += `\n\n========== d${n} seq=${d.row.seq} epoch=${d.epoch} at=${d.row.at}\n`;
  for (const key of ['planNow', 'shortage', 'road', 'meter', 'obsidian', 'liquid', 'state', 'food', 'inventory', 'threats', 'stops', 'lastResults', 'jobs', 'scan', 'landmarks']) {
    if (body[key] !== undefined) text += `${key}: ${JSON.stringify(body[key]).slice(0, 1500)}\n`;
  }
  text += `plan: ${JSON.stringify((live as Record<string, any>).plan ?? null).slice(0, 1500)}\n`;
  text += `--- RECORDED ANSWER ---\n${JSON.stringify(d.call?.input ?? null).slice(0, 1500)}\n--- RESULT ---\n${String(d.resultText).slice(0, 1200)}\n`;
}
writeFileSync(out, text);
console.log('wrote', out, text.length);
