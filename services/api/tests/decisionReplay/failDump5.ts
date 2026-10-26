import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { answerText } from './judge.js';
import { answerOfSent } from './headTransform.js';
import { candidateLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { decisionOf, loadScenes } from './score.js';
import { latest, readRows, sentOf, VIEWS } from './views5.js';

/**
 * 間違えた答え（採点が × か △）を、その判断が見た live（候補の live ならその整形）と並べて出す。仕分け（A 事実はあったのに Opus が誤った / B live に事実が無い・
 * 読みにくい / C 作れない / D 採点・検査の問題）に使う。先に report5.ts を回して data/report5-entries.json を作る。
 *   node --import tsx tests/decisionReplay/failDump5.ts candt [×|△] 出力ファイル
 */
const [viewId = 'candt', verdict = '×', out = dataFile('fail-dump5.txt')] = process.argv.slice(2);
const view = VIEWS.find(item => item.id === viewId)!;
const runs = loadAllRuns();
const entries = JSON.parse(readFileSync(dataFile('report5-entries.json'), 'utf8')) as Array<{ scene: string; key: string; variant: string; rep: number | 'prod'; verdict: string; by: string; reason: string; failed: string[] }>;
const rows = latest(readRows());
let text = '';
for (const scene of loadScenes()) {
  const bad = entries.filter(item => item.scene === scene.id && item.variant === viewId && item.verdict === verdict);
  if (!bad.length) continue;
  const decision = decisionOf(runs, scene);
  const prodLive = process.env.PROD_LIVE === '1';
  const live = prodLive ? decision.live : candidateLive(decision.live).live;
  const body = live.body as Record<string, any>;
  text += `\n\n################ ${scene.id}: ${scene.title}\nSITUATION: ${scene.situation}\nCORRECT: ${scene.correct}\nHINDSIGHT: ${scene.hindsight}\n`;
  for (const item of bad) {
    const row = rows.find(r => r.variant === view.variant && r.scene === scene.id && r.rep === item.rep)!;
    const sent = await sentOf(view, row, decision);
    const guard = (row as { sent?: { guard?: unknown } }).sent?.guard;
    text += `\n--- ${viewId} 回${item.rep} 採点 ${item.verdict}（${item.by}）: ${item.reason}\n検査で外れた: ${item.failed.join(' / ') || '-'}\n${answerText(answerOfSent(sent))}\n`;
    if (guard) text += `守り: ${JSON.stringify(guard).slice(0, 700)}\n`;
    if (viewId.startsWith('cand')) text += `モデルが書いた短い書き方(1 回目): ${JSON.stringify((row as { rawFirst?: unknown }).rawFirst).slice(0, 900)}\n`;
  }
  text += `\n--- ${prodLive ? '本番の live（モデルが見た物）の関係する所' : '候補の live の関係する所'}\nknowledge(先頭 300 字): ${String(live.knowledge ?? '').slice(0, 300)}\nurgent: ${JSON.stringify(body.urgent ?? null)}\nplanNow: ${body.planNow}\nthreats: ${JSON.stringify(body.threats ?? null)}\nfooting: ${body.footing ?? '-'}\n`;
  text += `around:\n${(body.around ?? []).join('\n')}\nroute:\n${(body.route ?? []).join('\n') || '(なし)'}\nlastResults:\n${(body.lastResults ?? []).join('\n===\n') || '(なし)'}\n`;
  if (body.investigation) text += `investigation:\n${body.investigation.join('\n')}\n`;
  if (body.repeat) text += `repeat:\n${body.repeat.join('\n')}\n`;
  if (body.stops) text += `stops:\n${body.stops.join('\n')}\n`;
  text += `map(先頭 2500 字):\n${String(body.map ?? '').slice(0, 2500)}\n`;
}
writeFileSync(out, text);
console.log('wrote', out, text.length, existsSync(out));
