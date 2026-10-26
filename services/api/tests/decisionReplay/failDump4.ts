import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { handLine, answerText } from './judge.js';
import { answerOf } from './checks.js';
import { decisionOf, loadScenes } from './score.js';
import { rewriteLive } from './rewriteLive.js';
import type { Row2 } from './run2.js';

/**
 * 間違えた答え（採点が × か △）を、書き直した live と並べて出す（点検 4: 事実はあったのに Opus が外したのか、書き直しに足りなかったのか）。
 *   node --import tsx tests/decisionReplay/failDump4.ts v9b [×|△] [出力ファイル]
 * 先に report4.ts を回して data/report4-entries.json を作る。
 */
const [variant = 'v9b', verdict = '×', out] = process.argv.slice(2);
const runs = loadAllRuns();
const entries = JSON.parse(readFileSync(dataFile('report4-entries.json'), 'utf8')) as Array<{ scene: string; key: string; variant: string; rep: number | 'prod'; verdict: string; by: string; reason: string; failed: string[] }>;
const read = (name: string): Row2[] => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : [];
const rows = [...read('results.jsonl'), ...read('results2.jsonl'), ...read('results4.jsonl')];
let text = '';
for (const scene of loadScenes()) {
  const bad = entries.filter(item => item.scene === scene.id && item.variant === variant && item.verdict === verdict);
  if (!bad.length) continue;
  const decision = decisionOf(runs, scene);
  const { live } = rewriteLive(decision.live);
  const body = live.body as Record<string, any>;
  text += `\n\n################ ${scene.id}: ${scene.title}\nSITUATION: ${scene.situation}\nCORRECT: ${scene.correct}\nHINDSIGHT: ${scene.hindsight}\n`;
  for (const item of bad) {
    const row = rows.find(r => r.variant === variant && r.scene === scene.id && r.rep === item.rep && r.ok)!;
    const answer = answerOf([{ type: 'tool_use', name: String(row.answer.tool).replace(/^mc\./, 'mc_').replace(/^plan\./, 'plan_'), input: row.answer.input }]);
    text += `\n--- ${variant} 回${item.rep} 採点 ${item.verdict}（${item.by}）: ${item.reason}\n検査で外れた: ${item.failed.join(' / ') || '-'}\n${answerText(answer)}\n`;
    void handLine;
  }
  text += `\n--- 書き直した live の関係する所\nurgent: ${JSON.stringify(body.urgent ?? null)}\nplanNow: ${body.planNow}\nthreats: ${JSON.stringify(body.threats ?? null)}\nfooting: ${body.footing ?? '-'}\n`;
  text += `around:\n${(body.around ?? []).join('\n')}\nroute:\n${(body.route ?? []).join('\n') || '(なし)'}\nlastResults:\n${(body.lastResults ?? []).join('\n===\n') || '(なし)'}\n`;
  if (body.investigation) text += `investigation:\n${body.investigation.join('\n')}\n`;
  text += `記録の答え（本番）の結果:\n${decision.resultText.slice(0, 900)}\n`;
}
if (out) writeFileSync(out, text); else console.log(text);
console.log('scenes with failures:', text.split('################').length - 1);
