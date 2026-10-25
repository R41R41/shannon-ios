import { loadAllRuns } from './allRuns.js';
import { answerOf, contextOf } from './checks.js';
import { decisionOf, scoreAnswer } from './score.js';
import { latest } from './views5.js';
import { readRows26, scenes26, short } from './sonnet26.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcPrepare } from '../../src/surfaces/minecraft/minecraftLlmc.js';
import { MC_ACT_TOOL } from '../../src/contracts/minecraftActContract.js';

/**
 * 守りが止めた 1 回目の答えを、守りに止められなかったとして（送る手の全部）台の決まった検査にかけ、止めた手が本当に悪い手だったかを見る。
 * 検査が ×（体が断る・塞がったマスへ歩く・止まりのくり返し・場面の規則）なら「止めて正しい」、○（検査だけで決まる）なら「良い手を止めたかもしれない」、
 * ? は検査で決まらない（ここでは決めず、止めた手の理由を読む）。
 *   node --import tsx tests/decisionReplay/heldAudit26.ts [S|C]...
 */
const want = process.argv.slice(2).length ? process.argv.slice(2) : ['S', 'C'];
const rows = latest(readRows26()) as any[];
const scenes = scenes26(rows);
const runs = loadAllRuns();
const tally: Record<string, Record<string, number>> = {};
const lines: string[] = [];
for (const scene of scenes) {
  const decision = decisionOf(runs, scene), context = contextOf(decision);
  for (const row of rows.filter(r => r.scene === scene.id && want.includes(r.variant) && r.sent?.guard && r.rawFirst)) {
    const prepared = llmcPrepare(MC_ACT_TOOL, candidateInput(MC_ACT_TOOL, row.rawFirst));
    if (prepared.problem) continue;
    const answer = answerOf([{ type: 'tool_use', name: 'mc_act', input: prepared.input }] as never);
    const score = scoreAnswer(scene, context, answer);
    const text = String(row.sent.guard.text);
    const m = /手 (\d+) (\w+) ([^:]+): ([^（。]*)/u.exec(text);
    const kind = m ? `${m[2]} ${m[3]}` : /見られる/u.test(text) ? 'dig 見られる' : /急ぎの判断は/u.test(text) ? '急ぎの手の数' : '他';
    tally[row.variant] ??= {};
    const key = `${kind} | 検査 ${score.verdict}`;
    tally[row.variant]![key] = (tally[row.variant]![key] ?? 0) + 1;
    lines.push(`${row.variant} ${short(scene.id)} r${row.rep} ${row.sent.guard.stopped ? '全' : '部'}${row.sent.guard.hand} ${kind} | 止めずに送った場合の検査 ${score.verdict}${score.failed.length ? `（${score.failed.join(' / ').slice(0, 110)}）` : ''} | ${m ? m[4]!.slice(0, 90) : text.slice(0, 90)}`);
  }
}
console.log(lines.join('\n'));
for (const variant of want) {
  console.log(`\n== ${variant}`);
  for (const [key, count] of Object.entries(tally[variant] ?? {}).sort()) console.log(`${count}\t${key}`);
}
