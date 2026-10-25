import { readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { answerText } from './judge.js';
import { answerOfSent } from './headTransform.js';
import { decisionOf } from './score.js';
import { candTurn } from './candidateAdapter.js';
import { latest, sentOf } from './views5.js';
import { readRows10, scenes10, VIEWS10 } from './sonnet10.js';

/**
 * 10/26: 場面ごとに、O・S・N・S×2 の答え（採点つき）と、モデルが見た live（今の main の形）を並べて出す。仕分け用。
 *   node --import tsx tests/decisionReplay/dump10.ts s52,s42 出力ファイル [--map=3000]
 * 先に report10.ts を回して data/sonnet-entries.json を作る。
 */
const [list = '', out = dataFile('sonnet-dump.txt')] = process.argv.slice(2);
const mapChars = Number(process.argv.find(arg => arg.startsWith('--map='))?.slice(6) ?? 2500);
const want = list.split(',').filter(Boolean);
const entries = JSON.parse(readFileSync(dataFile('sonnet-entries.json'), 'utf8')) as Array<{ scene: string; key: string; variant: string; rep: number | 'prod'; verdict: string; by: string; reason: string; failed: string[] }>;
const rows = latest(readRows10());
const runs = loadAllRuns();
let text = '';
for (const scene of scenes10(rows).filter(item => want.includes(item.id.split('-')[0]!))) {
  const decision = decisionOf(runs, scene);
  text += `\n\n################ ${scene.id}: ${scene.title}  [${scene.category.join('+')}]\nSITUATION: ${scene.situation}\nCORRECT: ${scene.correct}\nHINDSIGHT: ${scene.hindsight}\n`;
  for (const id of ['O', 'S', 'N']) {
    for (const item of entries.filter(entry => entry.scene === scene.id && entry.variant === id)) {
      const row = rows.find(r => r.variant === id && r.scene === scene.id && r.rep === item.rep) as any;
      const view = VIEWS10.find(v => v.id === id)!;
      const sent = await sentOf(view, row, decision);
      text += `\n--- ${id} 回${item.rep} 採点 ${item.verdict}（${item.by}）: ${item.reason}\n検査で外れた: ${item.failed.join(' / ') || '-'}\n${answerText(answerOfSent(sent))}\n`;
      if (row.sent?.guard) text += `守り: ${JSON.stringify(row.sent.guard).slice(0, 600)}\n`;
      text += `1回目の生の答え: ${JSON.stringify(row.rawFirst).slice(0, 700)}\n`;
    }
  }
  const turn = candTurn(decision).turn;
  const system = turn.find(entry => entry.role === 'system');
  let live: Record<string, any> = {};
  try { live = JSON.parse(String(system?.content)); } catch { /* keep empty */ }
  const body = (live.body ?? {}) as Record<string, any>;
  const { map, lastResults, around, route, ...rest } = body;
  text += `\n--- モデルが見た live（map・lastResults・around・route 以外）\n${JSON.stringify({ ...live, body: rest }, null, 1).slice(0, 6000)}\n`;
  text += `around:\n${(around ?? []).join('\n')}\nroute:\n${(route ?? []).join('\n') || '(なし)'}\nlastResults:\n${(lastResults ?? []).join('\n===\n') || '(なし)'}\n`;
  text += `map(先頭 ${mapChars} 字):\n${String(map ?? '').slice(0, mapChars)}\n`;
}
writeFileSync(out, text);
console.log('wrote', out, text.length);
