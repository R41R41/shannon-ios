import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadAllRuns, dataFile } from './allRuns.js';
import { candidatesOf, loadJudged } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, loadScenes, type SceneFile } from './score.js';
import type { Row2 } from './run2.js';
import type { ResultRow } from './run.js';

/**
 * v8（絞った形）の比べの表。結果 = results.jsonl（v1〜v3）+ results2.jsonl（v4〜v7）+ results3.jsonl（v8a〜d）、採点 = judge3.jsonl。
 * v8 を回した場面（21）に絞って、v2・v4・v5 と並べる。
 *   node --import tsx tests/decisionReplay/report3.ts
 */
const runs = loadAllRuns();
const read = <T>(name: string) => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T) : [];
type Row3 = Row2 & { slim?: { stages?: string[]; rawInput?: unknown; notationError?: unknown } };
const rows: Row3[] = [...read<ResultRow>('results.jsonl'), ...read<Row3>('results2.jsonl'), ...read<Row3>('results3.jsonl')];
const judged = loadJudged(dataFile('judge3.jsonl'));
const v8Scenes = new Set(rows.filter(row => row.variant.startsWith('v8')).map(row => row.scene));
const scenes = loadScenes().filter(scene => v8Scenes.has(scene.id));
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const f = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const ORDER = ['prod', 'v2', 'v4', 'v5', 'v8a', 'v8b', 'v8c', 'v8d'];
const LABEL: Record<string, string> = { prod: '本番の記録', v2: 'v2 専用の指示文', v4: 'v4 + r10（比べの基準）', v5: 'v5 v4 + 守り', v8a: 'v8a v4 + 道具 6 つ', v8b: 'v8b + 知識の段', v8c: 'v8c + 履歴の要約', v8d: 'v8d + 短い書き方（全部入り）' };
const out: string[] = [];
type Final = { verdict: '○' | '△' | '×' | '?'; by: 'check' | 'judge' | 'pending'; reason: string };
interface Entry { scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; failed: string[]; tool: string | null }
const table: Entry[] = [];
for (const scene of scenes) {
  const decision = decisionOf(runs, scene);
  for (const item of candidatesOf(scene, decision, rows)) {
    let final: Final;
    if (item.score.verdict === '×') final = { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
    else if (item.score.verdict === '○' && scene.judge !== 'always') final = { verdict: '○', by: 'check', reason: '検査' };
    else { const judge = judged.get(`${scene.id}|${item.key}`); final = judge ? { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason } : { verdict: '?', by: 'pending', reason: '' }; }
    table.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final, failed: item.score.failed, tool: item.answer.tool });
  }
}
const ids = ORDER.filter(id => table.some(item => item.variant === id));
const count = (list: Entry[], verdict: string) => list.filter(item => item.final.verdict === verdict).length;
const okRows = (id: string) => rows.filter(row => row.variant === id && row.ok && v8Scenes.has(row.scene));

out.push(`## 1. 正しさ（v8 を回した ${scenes.length} 場面だけ。回数は版ごと）\n`);
out.push('| 版 | 回数 | ○ | △ | × | 未採点 | ○の割合 | ×の割合 | 平均点（○=1 △=0.5） |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const id of ids) {
  const list = table.filter(item => item.variant === id);
  const pts = list.map(item => item.final.verdict === '○' ? 1 : item.final.verdict === '△' ? 0.5 : 0);
  out.push(`| ${LABEL[id]} | ${list.length} | ${count(list, '○')} | ${count(list, '△')} | ${count(list, '×')} | ${count(list, '?')} | ${f(100 * count(list, '○') / list.length, 0)}% | ${f(100 * count(list, '×') / list.length, 0)}% | ${f(mean(pts), 2)} |`);
}

out.push('\n## 2. ×の中身（回数）\n');
const kinds = new Map<string, Map<string, number>>();
const bump = (kind: string, id: string) => { if (!kinds.has(kind)) kinds.set(kind, new Map()); kinds.get(kind)!.set(id, (kinds.get(kind)!.get(id) ?? 0) + 1); };
const kindOf = (reason: string) => /^塞がったマスへ歩く/u.test(reason) ? '塞がった・床の無いマスへ walk' : /^同じ止まり/u.test(reason) ? '止まった手のくり返し' : /^体に送れない/u.test(reason) ? '体に送れない形（書き方の誤りを含む）'
  : /^道具の呼び出し/u.test(reason) ? '道具の呼び出しが無い' : `場面の必須: ${reason.split(':')[0]}`;
for (const item of table) {
  for (const reason of item.failed) bump(kindOf(reason), item.variant);
  if (item.final.by === 'judge' && item.final.verdict === '×') bump('採点者が×（検査は通った）', item.variant);
}
out.push(`| ×の種類 | ${ids.join(' | ')} |`, `|---|${ids.map(() => '---:').join('|')}|`);
for (const [kind, per] of [...kinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) out.push(`| ${kind} | ${ids.map(id => per.get(id) ?? 0).join(' | ')} |`);
out.push(`| （回数） | ${ids.map(id => table.filter(item => item.variant === id).length).join(' | ')} |`);

out.push('\n## 3. 道具を外した影響（基準の版が使った、v8 の 6 つに無い道具）\n');
const KEEP = new Set(['mc.act', 'mc.probe', 'mc.view', 'plan.update', 'fca_wait', 'fca_complete']);
const outside = table.filter(item => ['prod', 'v1', 'v2', 'v4'].includes(item.variant) && item.tool && !KEEP.has(item.tool));
out.push(`- 基準の版（本番の記録・v2・v4）の答えで 6 つの外の道具を呼んだ物: ${outside.length} 個（${[...new Set(outside.map(item => item.tool))].join('、') || '-'}）。`);
for (const item of outside) {
  const v8d = table.filter(other => other.scene.id === item.scene.id && other.variant === 'v8a').map(other => `${other.tool}:${other.final.verdict}`).join(' ');
  out.push(`  - ${item.scene.id} ${item.variant}${item.rep === 'prod' ? '' : item.rep}: ${item.tool}（${item.final.verdict}）→ v8a は ${v8d || '-'}`);
}
for (const id of ['v8a', 'v8b', 'v8c', 'v8d']) {
  const list = table.filter(item => item.variant === id);
  const tools = new Map<string, number>();
  for (const item of list) tools.set(item.tool ?? '-', (tools.get(item.tool ?? '-') ?? 0) + 1);
  out.push(`- ${id} の答えの道具: ${[...tools].map(([name, n]) => `${name} ${n}`).join('、')}`);
}

out.push('\n## 4. 時間（1 判断、ストリーム。v8c・v8d は履歴が毎回変わるので、この台では毎回キャッシュが無い）\n');
const warmBase = rows.filter(row => ['v2', 'v4'].includes(row.variant) && row.ok);
// 最初のブロックまでの時間 ≈ a + b × (キャッシュから読めなかった入力トークン): v2・v4 の呼び出しから当てはめる。
const xs = warmBase.map(row => (row.usage.input + row.usage.cacheWrite) / 1000), ys = warmBase.map(row => row.tFirstBlock! / 1000);
const mx = mean(xs), my = mean(ys);
const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
out.push(`- 最初のブロックまでの時間は、キャッシュから読めなかった入力 1,000 トークンあたり ${f(slope, 2)} 秒（v2・v4 の ${warmBase.length} 回から当てはめ）。`);
out.push('| 版 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 同じ、温かいキャッシュに直した p50 (s) | 全体 p50 / p95 (s) | 全体 平均 (s) |', '|---|---:|---|---:|---|---:|');
for (const id of ids.filter(item => item !== 'prod')) {
  const list = okRows(id);
  const warm = list.map(row => (row.tFirstBlock! / 1000) - slope * Math.max(0, (row.usage.cacheWrite + row.usage.input - 4400) / 1000));
  out.push(`| ${id} | ${list.length} | ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.5))} / ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.95))} | ${f(quantile(warm, 0.5))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.tEnd / 1000)))} |`);
}

out.push('\n## 5. 入力・出力・費用（1 判断）\n');
const client = process.env.SHANNON_ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.SHANNON_ANTHROPIC_API_KEY }) : null;
const tokenCache = existsSync(dataFile('answer-tokens.json')) ? JSON.parse(readFileSync(dataFile('answer-tokens.json'), 'utf8')) as Record<string, number> : {};
let empty = tokenCache['__empty'];
if (client && empty === undefined) { empty = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: '.' }] })).input_tokens; tokenCache['__empty'] = empty; }
async function tokensOf(value: unknown): Promise<number | null> {
  const text = JSON.stringify(value);
  const key = `${text.length}:${text.slice(0, 60)}:${text.slice(-60)}`;
  if (tokenCache[key] !== undefined) return tokenCache[key]!;
  if (!client) return null;
  const tokens = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: text }] })).input_tokens - empty! + 12;
  tokenCache[key] = tokens;
  return tokens;
}
out.push('| 版 | 呼び出し | 入力の合計（新規＋読み＋書き）平均 | 新規 | キャッシュ読み | キャッシュ書き | 出力 平均 | うち答え | 見えない考え | 費用 平均 ($、この台の実額) | 本番想定 1 判断 ($) |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const id of ids.filter(item => item !== 'prod')) {
  const list = okRows(id).filter(row => !row.firstUsage || id === 'v5');
  const acts = list.filter(row => row.answer.tool === 'mc.act');
  const answerTokens = (await Promise.all(acts.map(row => tokensOf(id === 'v8d' && (row as Row3).slim?.rawInput ? (row as Row3).slim!.rawInput : row.answer.input)))).filter((v): v is number => v !== null);
  const outputs = acts.map(row => (row.firstUsage ?? row.usage).output);
  const model = 'claude-opus-5-5';
  // 本番想定: 履歴は毎判断キャッシュから読む（尾 800 トークンだけ書く、1 時間書き込み）。履歴を要約する版は 6 判断ごとに先頭から書き直す。
  const rebuild = id === 'v8c' || id === 'v8d' ? 1 / 6 : 0;
  const assumed = mean(list.map(row => { const prefix = row.usage.cacheRead + row.usage.cacheWrite; const write = 800 + prefix * rebuild;
    return costOf(model, { input: row.usage.input, output: row.usage.output, cacheWrite: write, cacheRead: Math.max(0, prefix - write), cacheWrite1h: write, cacheWrite5m: 0 }); }));
  out.push(`| ${id} | ${list.length} | ${f(mean(list.map(r => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.usage.input)), 0)} | ${f(mean(list.map(r => r.usage.cacheRead)), 0)} | ${f(mean(list.map(r => r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.usage.output)), 0)} | ${f(mean(answerTokens), 0)} | ${f(mean(outputs) - mean(answerTokens), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(assumed, 4)} |`);
}
if (client) writeFileSync(dataFile('answer-tokens.json'), JSON.stringify(tokenCache));
out.push('\n（v5 は 1 回目 + 聞き直しの合計。v8 の費用の実額は、v8c・v8d が毎回キャッシュ無しで書く分を含む。本番想定は、履歴の先頭が同じ間は読み、v8c・v8d は 6 判断ごとに書き直すとした見積もり。）');

out.push('\n## 6. 短い書き方（v8d）の答え\n');
const shortRows = okRows('v8d') as Row3[];
const errors = shortRows.filter(row => row.slim?.notationError);
out.push(`- 答え ${shortRows.length} 個、書き方の誤り（読めない行）${errors.length} 個${errors.length ? `: ${errors.map(row => `${row.scene}「${String(row.slim!.notationError).slice(0, 60)}」`).join('、')}` : ''}。`);
const jsonRows = okRows('v8c').filter(row => row.answer.tool === 'mc.act');
const shortActs = shortRows.filter(row => row.answer.tool === 'mc.act');
const shortTokens = (await Promise.all(shortActs.map(row => tokensOf((row as Row3).slim?.rawInput)))).filter((v): v is number => v !== null);
const jsonTokens = (await Promise.all(jsonRows.map(row => tokensOf(row.answer.input)))).filter((v): v is number => v !== null);
out.push(`- 答えのトークン（mc.act）: JSON ${f(mean(jsonTokens), 0)}（v8c）→ 短い書き方 ${f(mean(shortTokens), 0)}（v8d）。手の数 平均 JSON ${f(mean(jsonRows.map(r => ((r.answer.input as { hands?: unknown[] }).hands ?? []).length)), 1)}、短い ${f(mean(shortActs.map(r => ((r.answer.input as { hands?: unknown[] }).hands ?? []).length)), 1)}。`);
if (client) writeFileSync(dataFile('answer-tokens.json'), JSON.stringify(tokenCache));

out.push('\n## 7. 対の比べ（場面ごとの平均点。同じ場面どうしの差の平均と、場面を引き直した 95% の幅）\n');
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const perScene = (id: string) => new Map(scenes.map(scene => { const mine = table.filter(item => item.scene.id === scene.id && item.variant === id); return [scene.id, mine.length ? mean(mine.map(item => points[item.final.verdict]!)) : NaN] as const; }));
let seed = 4321;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
out.push('| 比べ | 場面の数 | 差の平均 | 95% の幅 | 良くなった / 同じ / 悪くなった（差 0.25 以上） |', '|---|---:|---:|---|---|');
for (const [a, b] of [['v8a', 'v4'], ['v8b', 'v8a'], ['v8c', 'v8b'], ['v8d', 'v8c'], ['v8d', 'v4'], ['v8c', 'v4'], ['v8b', 'v4'], ['v8d', 'v2'], ['v8d', 'v5'], ['v4', 'v2']] as const) {
  if (!ids.includes(a) || !ids.includes(b)) continue;
  const left = perScene(a), right = perScene(b);
  const diffs = scenes.flatMap(scene => Number.isFinite(left.get(scene.id)!) && Number.isFinite(right.get(scene.id)!) ? [left.get(scene.id)! - right.get(scene.id)!] : []);
  if (!diffs.length) continue;
  const boot = Array.from({ length: 2000 }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!))).sort((x, y) => x - y);
  out.push(`| ${a} − ${b} | ${diffs.length} | ${f(mean(diffs), 2)} | ${f(boot[50]!, 2)} 〜 ${f(boot[1949]!, 2)} | ${diffs.filter(d => d >= 0.25).length} / ${diffs.filter(d => Math.abs(d) < 0.25).length} / ${diffs.filter(d => d <= -0.25).length} |`);
}

out.push('\n## 8. 場面ごと\n');
out.push(`| 場面 | 種類 | ${ids.join(' | ')} |`, `|---|---|${ids.map(() => '---').join('|')}|`);
for (const scene of scenes) {
  const cell = (id: string) => table.filter(item => item.scene.id === scene.id && item.variant === id).sort((a, b) => String(a.rep).localeCompare(String(b.rep))).map(item => item.final.verdict).join('');
  out.push(`| ${scene.id} | ${scene.category.join(',')} | ${ids.map(cell).join(' | ')} |`);
}
writeFileSync(dataFile('report3-tables.md'), `${out.join('\n')}\n`);
console.log(out.join('\n'));
