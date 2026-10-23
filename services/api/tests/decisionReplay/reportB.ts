import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { answerOf, contextOf } from './checks.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { answerOfSent } from './headTransform.js';
import { appendJudged, answerText, judgeScene, loadJudged, type Candidate } from './judge.js';
import { spent } from './ledger.js';
import { replayClient } from './request.js';
import { decisionOf, loadScenes, scoreAnswer } from './score.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import type { Row6 } from './run6.js';

/**
 * B の直しの比べ（基準 73244fc と修正 8607283）の採点と表。run6.ts の結果（results-b.jsonl の variant=candB・candF）を、検査 + 後知恵つきの採点（judge.ts）にかける。
 *   DECISION_REPLAY_SCENES_DIR=scenes-b node --import tsx tests/decisionReplay/reportB.ts [--judge] [--out=judge-b.jsonl] [--results=results-b.jsonl] [--force] [--tables=b-tables.md]
 * 基準と修正の答えは、同じ場面の同じ呼び出しで一緒に採点する（出どころは伏せて混ぜる）。--judge が無ければ、採点済みの分だけで表を作る。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const doJudge = args.includes('--judge');
const judgeFile = dataFile(flag('out') ?? 'judge-b.jsonl');
const resultsFile = dataFile(flag('results') ?? 'results-b.jsonl');
const VARIANTS = (flag('variants') ?? 'candB,candF').split(',');
const label = (variant: string) => variant === VARIANTS[0] ? '基準' : '修正';
const runs = loadAllRuns();
const rows = new Map<string, Row6>();
for (const line of existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean) : []) {
  const row = JSON.parse(line) as Row6;
  if (row.ok && VARIANTS.includes(row.variant)) rows.set(`${row.variant}|${row.scene}|${row.rep}`, row);
}
const judged = args.includes('--force') ? new Map() : loadJudged(judgeFile);
const client = doJudge ? replayClient(process.env.SHANNON_ANTHROPIC_API_KEY ?? '') : null;
if (doJudge && !process.env.SHANNON_ANTHROPIC_API_KEY) throw new Error('SHANNON_ANTHROPIC_API_KEY');

interface Cell { key: string; variant: string; rep: number | 'prod'; verdict: string; by: string; reason: string; text: string; passed: string[]; failed: string[]; row?: Row6 }
const out: string[] = [];
const summary: Record<string, { n: number; ok: number; half: number; bad: number; seconds: number[]; cost: number[]; output: number[]; chars: number[] }> = {};
for (const scene of loadScenes()) {
  if (![...rows.values()].some(item => item.scene === scene.id)) continue;
  const decision = decisionOf(runs, scene);
  const context = contextOf(decision);
  const list: Candidate[] = [];
  // 実走36・37 の本番の答えは候補と同じ短い書き方の行（"walk 1,2,3"）なので、手の JSON に戻してから採点する。
  const prod = answerOf(((decision.assistant?.content ?? []) as Array<Record<string, any>>).map(block => block.type === 'tool_use' && block.name === 'mc_act' ? { ...block, input: candidateInput('mc.act', block.input) } : block) as never);
  list.push({ key: 'prod', variant: 'prod', rep: 'prod', answer: prod, score: scoreAnswer(scene, context, prod) });
  for (const row of [...rows.values()].filter(item => item.scene === scene.id).sort((a, b) => a.variant.localeCompare(b.variant) || a.rep - b.rep)) {
    const sent = row.sent;
    let answer = answerOfSent({ tool: sent.tool, input: sent.input, fixes: sent.fixes, problem: sent.problem, changed: sent.changed });
    if (sent.combined && answer.shapeProblem && /hands は 1〜12 個/u.test(answer.shapeProblem)) answer = { ...answer, shapeProblem: null };
    if (sent.combined && sent.guard?.sentHands !== undefined) answer = { ...answer, partsMax: Math.max(sent.guard.sentHands, answer.hands.length - sent.guard.sentHands) };
    list.push({ key: `${row.variant}|${row.rep}`, variant: row.variant, rep: row.rep, answer, score: scoreAnswer(scene, context, answer) });
  }
  const need = list.filter(item => (item.score.verdict === '?' || (scene.judge === 'always' && item.score.verdict !== '×')) && !judged.has(`${scene.id}|${item.key}`));
  if (need.length && client) {
    const graded = await judgeScene(client, scene, decision, list);
    appendJudged(judgeFile, graded);
    for (const item of graded) judged.set(`${scene.id}|${item.key}`, item);
    console.error(scene.id, graded.map(item => `${item.variant}${item.rep === 'prod' ? '' : item.rep}:${item.verdict}`).join(' '), 'spent', spent().toFixed(3));
  }
  const cells: Cell[] = list.map(item => {
    const j = judged.get(`${scene.id}|${item.key}`);
    const row = item.variant === 'prod' ? undefined : rows.get(`${item.variant}|${scene.id}|${item.rep}`);
    const verdict = item.score.verdict === '×' ? '×' : j ? j.verdict : item.score.verdict;
    return { key: item.key, variant: item.variant, rep: item.rep, verdict, by: item.score.verdict === '×' ? '検査' : j ? '採点' : item.score.by === 'check' ? '検査' : '未採点', reason: item.score.verdict === '×' ? item.score.failed.join(' / ') : j?.reason ?? '',
      text: answerText(item.answer), passed: item.score.passed, failed: item.score.failed, ...(row ? { row } : {}) };
  });
  out.push(`### ${scene.id}`, `${scene.title}`, '');
  const mark = (variant: string) => cells.filter(cell => cell.variant === variant).map(cell => cell.verdict).join('');
  out.push(`- 本番の記録: ${cells.find(cell => cell.variant === 'prod')?.verdict ?? '-'}　基準 ${mark(VARIANTS[0]!)}　修正 ${mark(VARIANTS[1]!)}`, '');
  out.push('| 版 | 回 | 判定 | 決め方 | 理由・外れた検査 | 答え（要約） | 秒 | 出力 tok |', '|---|---:|:-:|---|---|---|---:|---:|');
  for (const cell of cells) {
    const head = cell.text.split('\n').slice(0, 5).map(line => line.trim()).join(' / ').replace(/\|/gu, '/').slice(0, 170);
    out.push(`| ${cell.variant === 'prod' ? '本番' : label(cell.variant)} | ${cell.rep === 'prod' ? '-' : cell.rep} | ${cell.verdict} | ${cell.by} | ${cell.reason.replace(/\|/gu, '/').slice(0, 90)} | ${head} | ${cell.row ? (cell.row.tEnd / 1000).toFixed(1) : '-'} | ${cell.row?.usage.output ?? '-'} |`);
    if (cell.row) {
      const s = (summary[`${cell.variant}`] ??= { n: 0, ok: 0, half: 0, bad: 0, seconds: [], cost: [], output: [], chars: [] });
      s.n += 1; if (cell.verdict === '○') s.ok += 1; else if (cell.verdict === '△') s.half += 1; else if (cell.verdict === '×') s.bad += 1;
      s.seconds.push(cell.row.tEnd / 1000); s.cost.push(cell.row.costUsd); s.output.push(cell.row.usage.output);
    }
  }
  out.push('');
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2 : 0; };
const head = ['## 全体（場面 × 3 回）', '', '| 版 | 答え数 | ○ | △ | × | 平均点（○1・△0.5） | 中央値の秒 | 平均の出力 tok | 費用合計 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
for (const variant of VARIANTS) {
  const s = summary[variant]; if (!s) continue;
  head.push(`| ${label(variant)} | ${s.n} | ${s.ok} | ${s.half} | ${s.bad} | ${((s.ok + 0.5 * s.half) / s.n).toFixed(2)} | ${median(s.seconds).toFixed(1)} | ${(s.output.reduce((a, b) => a + b, 0) / s.n).toFixed(0)} | $${s.cost.reduce((a, b) => a + b, 0).toFixed(3)} |`);
}
const tables = [...head, '', ...out].join('\n');
writeFileSync(dataFile(flag('tables') ?? 'b-tables.md'), tables);
console.log(tables);
