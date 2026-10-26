import { writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { candFrame, candidateAct } from './candidateAdapter.js';
import { answerOf } from './checks.js';
import { loadJudged, type Candidate } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, type SceneFile } from './score.js';
import { frames } from './sceneSet.js';
import { candidatesOf5, latest } from './views5.js';
import { readRowsQ, scenesQ, short, VIEWS_Q, WAIT_SEQ } from './sonnetQ.js';
import { isUrgentLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import type { Row2 } from './run2.js';

/**
 * 10/26 mc-task-queue の表。 node --import tsx tests/decisionReplay/reportQ.ts [--judge=judgeQ.jsonl] [--out=tq-tables.md]
 * 1. 正しさ（B と Q の対、本番の記録は参考） 2. 場面ごと 3. 列の欄の使い方（Q） 4. 手の数・判断の回数の見込み 5. 守り 6. 時間・費用。
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const all = latest(readRowsQ()) as Array<Row2 & { sent?: any; rawFirst?: unknown; rawFinal?: unknown; requestChars?: number }>;
const scenes = scenesQ(all);
const both = scenes.filter(scene => ['B', 'Q'].every(id => all.some(row => row.scene === scene.id && row.variant === id)));
const ids = new Set(both.map(scene => scene.id));
const rows = all.filter(row => ids.has(row.scene));
const runs = loadAllRuns();
const judged = loadJudged(dataFile(flag('judge', 'judgeQ.jsonl')));
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const f = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const signed = (value: number, digits = 2) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}` : '-';

type Final = { verdict: '○' | '△' | '×' | '?'; by: string; reason: string };
interface Entry { scene: SceneFile; variant: string; rep: number | 'prod'; final: Final; failed: string[] }
function finalOf(scene: SceneFile, item: Candidate): Final {
  if (item.score.verdict === '×') return { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
  if (item.score.verdict === '○' && scene.judge !== 'always') return { verdict: '○', by: 'check', reason: '検査' };
  const judge = judged.get(`${scene.id}|${item.key}`);
  if (judge) return { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason };
  return { verdict: item.score.verdict === '○' ? '○' : '?', by: item.score.verdict === '○' ? 'check' : 'pending', reason: '' };
}
const table: Entry[] = [];
for (const scene of both) {
  const decision = decisionOf(runs, scene);
  for (const item of await candidatesOf5(scene, decision, rows, VIEWS_Q)) table.push({ scene, variant: item.variant, rep: item.rep, final: finalOf(scene, item), failed: item.score.failed });
}
writeFileSync(dataFile('tq-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, variant: item.variant, rep: item.rep, verdict: item.final.verdict, by: item.final.by, reason: item.final.reason, failed: item.failed }))));
const sceneMean = (variant: string, scene: string): number => {
  const mine = table.filter(item => item.scene.id === scene && item.variant === variant && item.final.verdict !== '?');
  return mine.length ? mean(mine.map(item => points[item.final.verdict]!)) : NaN;
};
function boot(a: string, b: string, list: SceneFile[]) {
  const diffs = list.map(scene => sceneMean(a, scene.id) - sceneMean(b, scene.id)).filter(Number.isFinite);
  let state = 12345;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const samples: number[] = [];
  for (let k = 0; k < 10000; k += 1) { let sum = 0; for (let i = 0; i < diffs.length; i += 1) sum += diffs[Math.floor(next() * diffs.length)]!; samples.push(sum / Math.max(1, diffs.length)); }
  samples.sort((x, y) => x - y);
  return { diff: mean(diffs), low: samples[Math.floor(0.025 * samples.length)]!, high: samples[Math.floor(0.975 * samples.length)]!, n: diffs.length };
}
const seqOf = (scene: SceneFile) => Number(/-r39-(\d+)-/u.exec(scene.id)?.[1]);
const groups: Array<[string, SceneFile[]]> = [['全 ' + both.length + ' 場面', both],
  ['成功の後（steady）', both.filter(s => /steady/u.test(s.id))], ['止まりの後（after-stop）', both.filter(s => /after-stop/u.test(s.id))], ['急ぎ（urgent）', both.filter(s => /urgent/u.test(s.id))],
  ['かまどなどの待ち（WAIT 4）', both.filter(s => WAIT_SEQ.includes(seqOf(s)))]];
const out: string[] = [];
out.push('## 1. 正しさ（場面ごとの平均の平均。○=1 △=0.5 ×=0。1 場面 1 回ずつ。差の幅は場面を引き直した 95%）\n');
out.push('| 場面の集合 | 場面 | 本番の記録（参考） | 基準 B | 候補 Q | Q−B | 95% の幅 | 0 をまたぐか |', '|---|---:|---:|---:|---:|---:|---|---|');
for (const [name, list] of groups) {
  const b = boot('Q', 'B', list);
  out.push(`| ${name} | ${list.length} | ${f(mean(list.map(s => sceneMean('prod', s.id)).filter(Number.isFinite)))} | ${f(mean(list.map(s => sceneMean('B', s.id)).filter(Number.isFinite)))} | ${f(mean(list.map(s => sceneMean('Q', s.id)).filter(Number.isFinite)))} | ${signed(b.diff, 3)} | ${f(b.low, 3)}〜${f(b.high, 3)} | ${b.low <= 0 && b.high >= 0 ? 'またぐ' : 'またがない'} |`);
}
out.push('\n答えごと:\n', '| 版 | 答え | ○ | △ | × | 未採点 | 平均 |', '|---|---:|---:|---:|---:|---:|---:|');
for (const id of ['prod', 'B', 'Q']) {
  const list = table.filter(item => item.variant === id), decided = list.filter(item => item.final.verdict !== '?');
  out.push(`| ${id === 'prod' ? '本番の記録' : id} | ${list.length} | ${list.filter(i => i.final.verdict === '○').length} | ${list.filter(i => i.final.verdict === '△').length} | ${list.filter(i => i.final.verdict === '×').length} | ${list.filter(i => i.final.verdict === '?').length} | ${f(mean(decided.map(i => points[i.final.verdict]!)))} |`);
}
out.push('\n## 2. 場面ごと\n', '| 場面 | 種類 | 本番の記録 | B | Q | Q−B |', '|---|---|---:|---:|---:|---:|');
for (const scene of both) {
  const [p, b, q] = [sceneMean('prod', scene.id), sceneMean('B', scene.id), sceneMean('Q', scene.id)];
  out.push(`| ${short(scene.id)} ${scene.title.slice(0, 24)}${WAIT_SEQ.includes(seqOf(scene)) ? '（待ち）' : ''} | ${scene.category.join('+')} | ${f(p)} | ${f(b)} | ${f(q)} | ${signed(q - b)} |`);
}

// ---- 3. 列の欄の使い方（Q）
out.push('\n## 3. 列の欄の使い方（Q の 1 回目の答え。モデルの書いた物 = rawFirst）\n');
const qRows = rows.filter(row => row.variant === 'Q') as any[], bRows = rows.filter(row => row.variant === 'B') as any[];
const acts = (list: any[]) => list.filter(row => (row.sent?.guard ? 'mc.act' : row.answer?.tool) === 'mc.act' || row.sent?.tool === 'mc.act');
const has = (row: any, key: string) => row.rawFirst && typeof row.rawFirst === 'object' && (row.rawFirst as any)[key] !== undefined;
const qActs = acts(qRows);
const count = (key: string) => qActs.filter(row => has(row, key));
const problemOf = (row: any): string | null => { const p = row.sent?.problem; return typeof p === 'string' ? p : null; };
const queueProblem = (row: any) => /^(?:pre|done|repeat) の書き方の誤り|repeat の手は rel|repeat は 2〜8|pre・done|条件/u.test(problemOf(row) ?? '');
out.push('| 欄 | 書いた答え | mc.act の答えに対する割合 | 書き方の誤り・断られた | 読めた・通った |', '|---|---:|---:|---:|---:|');
for (const key of ['pre', 'done', 'repeat', 'replace']) {
  const used = count(key), bad = used.filter(queueProblem);
  out.push(`| ${key} | ${used.length} | ${f(100 * used.length / Math.max(1, qActs.length), 0)}% | ${bad.length} | ${used.length - bad.length} |`);
}
const anyQueue = qActs.filter(row => ['pre', 'done', 'repeat', 'replace'].some(key => has(row, key)));
out.push(`\nmc.act の答え ${qActs.length}（全 ${qRows.length} 答え）、新しい欄を 1 つでも書いた答え ${anyQueue.length}（${f(100 * anyQueue.length / Math.max(1, qActs.length), 0)}%）、うち書き方の誤りで断られた ${anyQueue.filter(queueProblem).length}。`);
out.push('\n新しい欄を書いた答え（採点つき）:\n', '| 場面 | 欄 | 中身 | 断られた理由 | 採点 |', '|---|---|---|---|---|');
for (const row of anyQueue) {
  const raw = row.rawFirst as Record<string, unknown>;
  const fields = ['pre', 'done', 'repeat', 'replace'].filter(key => raw[key] !== undefined).map(key => `${key}=${JSON.stringify(raw[key])}`).join(' ');
  const verdict = table.find(item => item.scene.id === row.scene && item.variant === 'Q')?.final.verdict ?? '-';
  out.push(`| ${short(row.scene)}${WAIT_SEQ.includes(seqOf(scenes.find(s => s.id === row.scene)!)) ? '（待ち）' : ''} | ${fields.slice(0, 90)} | hands ${Array.isArray(raw.hands) ? raw.hands.length : '?'} | ${(problemOf(row) ?? '-').slice(0, 70)} | ${verdict} |`);
}
// repeat の手は rel か（断られなかったものの中身）
const repeatRows = count('repeat').filter(row => !queueProblem(row));
const relOk = repeatRows.filter(row => ((row.sent?.input?.hands ?? []) as any[]).every(hand => hand?.rel === true || !(hand?.at || hand?.to || hand?.path))).length;
out.push(`\nrepeat を書いて断られなかった ${repeatRows.length} のうち、手が rel か座標の無い手だけ: ${relOk}。`);
// 待ちの場面
out.push('\n待ちの場面（WAIT 4）で Q が書いた物:\n');
for (const scene of both.filter(s => WAIT_SEQ.includes(seqOf(s)))) {
  const row = qRows.find(r => r.scene === scene.id);
  out.push(`- ${short(scene.id)} (seq ${seqOf(scene)}): ${row ? JSON.stringify(row.rawFirst).slice(0, 260) : '-'}`);
}

// ---- 4. 手の数と判断の回数の見込み
out.push('\n## 4. 1 判断あたりの手の数と、判断の回数の見込み\n');
const handsOf = (row: any): number => ((row.sent?.input?.hands ?? []) as unknown[]).length;
const repeatOf = (row: any): number => typeof row.sent?.input?.repeat === 'number' ? row.sent.input.repeat : 1;
const prodHands = both.map(scene => answerOf((decisionOf(runs, scene).assistant?.content ?? []) as never)).filter(a => a.tool === 'mc.act').map(a => a.hands.length);
const bActs = acts(bRows);
out.push('| 版 | mc.act の答え | 手の数 平均（1 回目の答え = 送る手の合計） | 繰り返しを数えた手の数（最大） | 手の数が 12 の答え | probe・view・plan の答え |', '|---|---:|---:|---:|---:|---:|');
out.push(`| 本番の記録 | ${prodHands.length} | ${f(mean(prodHands), 1)} | ${f(mean(prodHands), 1)} | ${prodHands.filter(n => n >= 12).length} | ${both.length - prodHands.length} |`);
for (const [id, list, all_] of [['B', bActs, bRows], ['Q', qActs, qRows]] as const) {
  out.push(`| ${id} | ${list.length} | ${f(mean(list.map(handsOf)), 1)} | ${f(mean(list.map(row => handsOf(row) * repeatOf(row))), 1)} | ${list.filter(row => handsOf(row) >= 12).length} | ${all_.length - list.length} |`);
}
const gain = mean(qActs.map(row => handsOf(row) * repeatOf(row))) / mean(bActs.map(handsOf));
out.push(`\n**判断の回数の見込み（測っていない）**: repeat を最大まわした時の手の数の比は Q/B = ${f(gain, 2)}。体が手の組を最後までまわし切れば、同じ仕事の判断は ${f(100 * (1 / gain - 1), 0)}% 変わる計算（上限。repeat は no_progress・done・damage で早く終わる）。`
  + ` 実際に repeat を書いた答えは ${count('repeat').length}/${qActs.length}。設計の予測は 124 → 約 115（−7%）。`);

// ---- 5. 守り
out.push('\n## 5. 送る前の守りが止めた数（1 回目の答え）\n', '| 版 | 答え | 止めた | 全部止め | 一部止め | 割合 |', '|---|---:|---:|---:|---:|---:|');
for (const [id, list] of [['B', bRows], ['Q', qRows]] as const) {
  const held = list.filter(row => row.sent?.guard), whole = held.filter(row => row.sent.guard.stopped);
  out.push(`| ${id} | ${list.length} | ${held.length} | ${whole.length} | ${held.length - whole.length} | ${f(100 * held.length / Math.max(1, list.length), 0)}% |`);
}
const problems = qRows.filter(row => problemOf(row)), bProblems = bRows.filter(row => problemOf(row));
out.push(`\n守りの前の形の誤り（体に送れない形）: B ${bProblems.length}、Q ${problems.length}（${problems.map(row => `${short(row.scene)}: ${String(problemOf(row)).slice(0, 60)}`).join(' / ') || '-'}）。`);

// ---- 6. 時間・費用
out.push('\n## 6. 時間・費用（1 判断。聞き直しを含む。自分の PC からストリーム、基準と候補を並べて走らせた）\n');
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const assumedOne = (u: Usage) => costOf('claude-sonnet-5-5', { input: u.input, output: u.output, cacheWrite: 800, cacheRead: Math.max(0, u.cacheRead + u.cacheWrite - 800), cacheWrite1h: 800, cacheWrite5m: 0 });
function assumed(row: any): number {
  const f1 = row.firstUsage;
  if (!f1 || row.usage.output === f1.output) return assumedOne(row.usage);
  return assumedOne(f1) + assumedOne({ input: row.usage.input - f1.input, output: row.usage.output - f1.output, cacheWrite: row.usage.cacheWrite - f1.cacheWrite, cacheRead: row.usage.cacheRead - f1.cacheRead });
}
out.push('| 版 | 判断 | 最初のブロックまで p50 (s) | 全体 p50 / p95 (s) | 出力 平均 tok | 入力（新規）平均 tok | 費用 平均（この台の実額） | 本番想定 1 判断 | 要求の文字数 平均 |', '|---|---:|---:|---|---:|---:|---:|---:|---:|');
for (const [id, list] of [['B', bRows], ['Q', qRows]] as const) {
  const t = list.map(r => r.tEnd / 1000), first = list.map(r => (r.tFirstBlock ?? 0) / 1000);
  out.push(`| ${id} | ${list.length} | ${f(quantile(first, 0.5), 1)} | ${f(quantile(t, 0.5), 1)} / ${f(quantile(t, 0.95), 1)} | ${f(mean(list.map(r => r.usage.output)), 0)} | ${f(mean(list.map(r => r.usage.input)), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(mean(list.map(assumed)), 4)} | ${f(mean(list.map(r => r.requestChars ?? NaN)), 0)} |`);
}
const dq = mean(qRows.map(assumed)) / mean(bRows.map(assumed)) - 1;
out.push(`\n本番想定の 1 判断の費用は Q が B より ${signed(100 * dq, 1)}%。`);
writeFileSync(dataFile(flag('out', 'tq-tables.md')), out.join('\n'));
console.log(out.join('\n'));
