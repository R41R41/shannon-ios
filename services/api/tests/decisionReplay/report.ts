import { readFileSync, writeFileSync } from 'node:fs';
import { answerOf, contextOf } from './checks.js';
import { costOf } from './ledger.js';
import { candidatesOf, loadJudged } from './judge.js';
import { loadRuns } from './load.js';
import { VARIANTS } from './request.js';
import { decisionOf, loadScenes, type SceneFile } from './score.js';
import type { ResultRow } from './run.js';

/** 結果の表（markdown）。results.jsonl・judge.jsonl・場面のファイルから作る。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow);
const judged = loadJudged(p('judge.jsonl'));
const scenes = loadScenes();
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const f = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';

type Final = { verdict: '○' | '△' | '×' | '?'; by: 'check' | 'judge' | 'pending'; reason: string };
function finalOf(scene: SceneFile, item: ReturnType<typeof candidatesOf>[number]): Final {
  if (item.score.verdict === '×') return { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
  const judge = judged.get(`${scene.id}|${item.key}`);
  if (item.score.verdict === '○' && scene.judge !== 'always') return { verdict: '○', by: 'check', reason: '検査' };
  if (judge) return { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason };
  return { verdict: item.score.verdict === '○' ? '○' : '?', by: item.score.verdict === '○' ? 'check' : 'pending', reason: '' };
}

const table: Array<{ scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; flags: { stopIfFixes: string[]; whyTag: boolean }; shape: boolean; failed: string[] }> = [];
for (const scene of scenes) {
  const decision = decisionOf(runs, scene);
  for (const item of candidatesOf(scene, decision, rows)) {
    table.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final: finalOf(scene, item), flags: { stopIfFixes: item.score.stopIfFixes, whyTag: item.score.whyTag }, shape: !item.answer.shapeProblem, failed: item.score.failed });
  }
}

const out: string[] = [];
const variants = ['prod', ...VARIANTS.map(variant => variant.id)];
const label = (id: string) => id === 'prod' ? '本番の記録（実走32〜34、n=1、場面の時の指示文・版）' : VARIANTS.find(variant => variant.id === id)!.label;

out.push('## 1. 正しさ（場面 × 回数）\n');
out.push('| 版 | 回数 | ○ | △ | × | 未採点 | ○の割合 | ×の割合 | 検査で決まった割合 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const id of variants) {
  const list = table.filter(item => item.variant === id);
  const count = (verdict: string) => list.filter(item => item.final.verdict === verdict).length;
  const byCheck = list.filter(item => item.final.by === 'check').length;
  out.push(`| ${label(id)} | ${list.length} | ${count('○')} | ${count('△')} | ${count('×')} | ${count('?')} | ${f(100 * count('○') / list.length, 0)}% | ${f(100 * count('×') / list.length, 0)}% | ${f(100 * byCheck / list.length, 0)}% |`);
}

out.push('\n## 2. 種類ごとの ○ の割合（○ / 回数）\n');
const categories = ['stopped', 'urgent', 'death', 'progress', 'plan'];
out.push(`| 版 | ${categories.join(' | ')} |`, `|---|${categories.map(() => '---:').join('|')}|`);
for (const id of variants) {
  out.push(`| ${id} | ${categories.map(category => { const list = table.filter(item => item.variant === id && item.scene.category.includes(category)); return `${list.filter(item => item.final.verdict === '○').length}/${list.length}`; }).join(' | ')} |`);
}

out.push('\n## 3. 時間・出力・入力・費用（再現の呼び出しごと）\n');
out.push('| 版 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 最初のツール入力まで p50 (s) | 全体 p50 / p95 (s) | 出力トークン 平均 / p50 / p95 | 新規入力 平均 | キャッシュ読み 平均 | キャッシュ書き 平均 | 費用 平均 / p50 ($) | 合計 ($) |', '|---|---:|---|---:|---|---|---:|---:|---:|---|---:|');
const stats: Record<string, { all: ResultRow[] }> = {};
for (const variant of VARIANTS) {
  const list = rows.filter(row => row.variant === variant.id && row.ok);
  stats[variant.id] = { all: list };
  out.push(`| ${variant.label} | ${list.length} | ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.5))} / ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.95))} | ${f(quantile(list.map(r => (r.tFirstToolInput ?? r.tEnd) / 1000), 0.5))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.usage.output)), 0)} / ${f(quantile(list.map(r => r.usage.output), 0.5), 0)} / ${f(quantile(list.map(r => r.usage.output), 0.95), 0)} | ${f(mean(list.map(r => r.usage.input)), 0)} | ${f(mean(list.map(r => r.usage.cacheRead)), 0)} | ${f(mean(list.map(r => r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} / ${f(quantile(list.map(r => r.costUsd), 0.5), 4)} | ${f(list.reduce((s, r) => s + r.costUsd, 0), 2)} |`);
}
out.push('\n温かい呼び出し（キャッシュ読みが入力の大半、2 回目のもの）だけ:\n');
out.push('| 版 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 全体 p50 / p95 (s) | 費用 平均 ($) | 本番想定 1 判断 ($、尾の書き込み 800 トークン・1 時間書き込みで補正) |', '|---|---:|---|---|---:|---:|');
for (const variant of VARIANTS) {
  const list = rows.filter(row => row.variant === variant.id && row.ok && row.rep >= 2);
  const adjusted = mean(list.map(row => costOf(variant.model, { input: row.usage.input, output: row.usage.output, cacheWrite: 800, cacheRead: row.usage.cacheRead + row.usage.cacheWrite, cacheWrite1h: 800, cacheWrite5m: 0 })));
  out.push(`| ${variant.label} | ${list.length} | ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.5))} / ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.95))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(adjusted, 4)} |`);
}
// The production record: the journal's decision metrics of the same rows.
const journal = scenes.map(scene => decisionOf(runs, scene)).flatMap(decision => decision.metrics?.in ? [decision.metrics] : []);
out.push(`\n本番の記録（journal の fca_decision_metrics、場面の ${journal.length} 判断）: LLM 時間 p50 ${f(quantile(journal.map(m => m.llmMs / 1000), 0.5))} s / p95 ${f(quantile(journal.map(m => m.llmMs / 1000), 0.95))} s、出力 平均 ${f(mean(journal.map(m => m.out)), 0)} トークン、`
  + `新規入力 平均 ${f(mean(journal.map(m => m.in.new)), 0)}、キャッシュ読み 平均 ${f(mean(journal.map(m => m.in.read)), 0)}、書き 平均 ${f(mean(journal.map(m => m.in.write)), 0)}、`
  + `1 判断の費用 平均 $${f(mean(journal.map(m => costOf('claude-opus-5-5', { input: m.in.new, output: m.out, cacheWrite: m.in.write, cacheRead: m.in.read, cacheWrite1h: m.in.write, cacheWrite5m: 0 }))), 4)}（1 時間書き込み）。`);

out.push('\n## 4. 形・stopIf・why の札\n');
out.push('| 版 | 体に送れる形 | stopIf を頭が直す必要（本番ではコードが直す） | why が [節] / [急ぎ] で始まる |', '|---|---:|---:|---:|');
for (const id of variants) {
  const list = table.filter(item => item.variant === id);
  out.push(`| ${id} | ${list.filter(item => item.shape).length}/${list.length} | ${list.filter(item => item.flags.stopIfFixes.length).length}/${list.length} | ${list.filter(item => item.flags.whyTag).length}/${list.length} |`);
}

out.push('\n## 5. 場面ごと（左から 本番の記録 / v1 / v2 / v3、回ごとに ○△×、? は未採点）\n');
out.push('| 場面 | 種類 | 本番 | v1 | v2 | v3 |', '|---|---|---|---|---|---|');
for (const scene of scenes) {
  const cell = (id: string) => table.filter(item => item.scene.id === scene.id && item.variant === id).sort((a, b) => String(a.rep).localeCompare(String(b.rep))).map(item => item.final.verdict).join('');
  out.push(`| ${scene.id} | ${scene.category.join(',')} | ${cell('prod')} | ${cell('v1')} | ${cell('v2')} | ${cell('v3')} |`);
}

out.push('\n## 6. 対の比べ（場面ごとの平均点: ○=1 △=0.5 ×=0。同じ場面どうしの差の平均と、場面を引き直した 95% の幅）\n');
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const perScene = (id: string) => new Map(scenes.map(scene => {
  const list = table.filter(item => item.scene.id === scene.id && item.variant === id);
  return [scene.id, list.length ? mean(list.map(item => points[item.final.verdict]!)) : NaN] as const;
}));
let seed = 12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
out.push('| 比べ | 場面の数 | 差の平均 | 95% の幅 | 良くなった / 同じ / 悪くなった（差 0.25 以上） |', '|---|---:|---:|---|---|');
for (const [a, b] of [['v1', 'prod'], ['v2', 'v1'], ['v3', 'v1'], ['v3', 'v2']] as const) {
  const left = perScene(a), right = perScene(b);
  const diffs = scenes.flatMap(scene => Number.isFinite(left.get(scene.id)!) && Number.isFinite(right.get(scene.id)!) ? [left.get(scene.id)! - right.get(scene.id)!] : []);
  const boot = Array.from({ length: 2000 }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!))).sort((x, y) => x - y);
  out.push(`| ${a} − ${b} | ${diffs.length} | ${f(mean(diffs), 2)} | ${f(boot[50]!, 2)} 〜 ${f(boot[1949]!, 2)} | ${diffs.filter(d => d >= 0.25).length} / ${diffs.filter(d => Math.abs(d) < 0.25).length} / ${diffs.filter(d => d <= -0.25).length} |`);
}

out.push('\n## 7. 答えの形（道具・手の数）\n');
out.push('| 版 | mc.act | mc.view | mc.probe・find-blocks など読む道具 | plan.update | 手の数 平均（mc.act のみ） | 答えの JSON の長さ 平均（字） |', '|---|---:|---:|---:|---:|---:|---:|');
for (const variant of VARIANTS) {
  const list = rows.filter(row => row.variant === variant.id && row.ok);
  const tool = (name: string) => list.filter(row => row.answer.tool === name).length;
  const acts = list.filter(row => row.answer.tool === 'mc.act');
  const reads = list.filter(row => row.answer.tool && !['mc.act', 'mc.view', 'plan.update'].includes(row.answer.tool));
  out.push(`| ${variant.id} | ${acts.length} | ${tool('mc.view')} | ${reads.length}（${[...new Set(reads.map(row => row.answer.tool))].join(', ')}） | ${tool('plan.update')} | ${f(mean(acts.map(row => ((row.answer.input as { hands?: unknown[] }).hands ?? []).length)), 1)} | ${f(mean(list.map(row => JSON.stringify(row.answer.input).length)), 0)} |`);
}
const productionActs = scenes.map(scene => decisionOf(runs, scene)).flatMap(decision => decision.call?.name === 'mc_act' ? [decision.call.input.hands?.length ?? 0] : []);
out.push(`\n本番の記録: mc.act の手の数 平均 ${f(mean(productionActs), 1)}（${productionActs.length} 判断）。`);

out.push('\n## 8. 回数と費用\n');
const counts = (id: string) => { const per = new Map<string, number>(); for (const row of rows.filter(item => item.variant === id && item.ok)) per.set(row.scene, (per.get(row.scene) ?? 0) + 1); return per; };
out.push('| 版 | 場面 | 1 回だけの場面 | 2 回以上の場面 | 呼び出し | 費用 ($) |', '|---|---:|---:|---:|---:|---:|');
for (const variant of VARIANTS) {
  const per = counts(variant.id);
  out.push(`| ${variant.id} | ${per.size} | ${[...per.values()].filter(n => n === 1).length} | ${[...per.values()].filter(n => n >= 2).length} | ${rows.filter(row => row.variant === variant.id && row.ok).length} | ${f(rows.filter(row => row.variant === variant.id).reduce((sum, row) => sum + row.costUsd, 0), 2)} |`);
}

out.push('\n## 9. 検査が拾った誤り（回数。同じ答えが複数の検査に当たることがある）\n');
const kinds = new Map<string, Map<string, number>>();
for (const item of table) for (const reason of item.failed) {
  const kind = /^塞がったマスへ歩く/u.test(reason) ? '塞がった・床の無いマスへ歩く' : /^同じ止まり/u.test(reason) ? '止まった手のくり返し' : /^体に送れない/u.test(reason) ? '体に送れない形'
    : /^道具の呼び出し/u.test(reason) ? '道具の呼び出しが無い' : `場面の必須: ${reason.split(':')[0]}`;
  if (!kinds.has(kind)) kinds.set(kind, new Map());
  kinds.get(kind)!.set(item.variant, (kinds.get(kind)!.get(item.variant) ?? 0) + 1);
}
out.push(`| 誤りの種類 | ${variants.join(' | ')} |`, `|---|${variants.map(() => '---:').join('|')}|`);
for (const [kind, per] of [...kinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  out.push(`| ${kind} | ${variants.map(id => per.get(id) ?? 0).join(' | ')} |`);
}
out.push(`| （回数） | ${variants.map(id => table.filter(item => item.variant === id).length).join(' | ')} |`);

writeFileSync(p('report-tables.md'), `${out.join('\n')}\n`);
console.log(out.join('\n'));
