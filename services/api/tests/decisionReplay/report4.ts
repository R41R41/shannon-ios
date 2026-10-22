import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { candidatesOf, loadJudged } from './judge.js';
import { decisionOf, loadScenes, type SceneFile } from './score.js';
import type { Row2 } from './run2.js';

/**
 * 10/23 の 3 つ目の比べの表（書き直した live）。結果 = results.jsonl・results2.jsonl（v2 の前の分）+ results4.jsonl（v2 の足し・v9b・v9c）、
 * 採点 = judge4.jsonl（2 回目 judge4b.jsonl）。
 *   node --import tsx tests/decisionReplay/report4.ts [--variants=v2,v9b,v9c]
 */
const args = process.argv.slice(2);
const only = (args.find(arg => arg.startsWith('--variants='))?.slice(11) ?? 'v2,v9b,v9c').split(',');
const runs = loadAllRuns();
const read = (name: string): Row2[] => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : [];
const rows = [...read('results.jsonl'), ...read('results2.jsonl'), ...read('results4.jsonl')].filter(row => only.includes(row.variant));
const judged = loadJudged(dataFile('judge4.jsonl')), judgedB = loadJudged(dataFile('judge4b.jsonl'));
const scenes = loadScenes();
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const f = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const LABEL: Record<string, string> = { prod: '本番の記録（n=1、場面の時の版）', v2: 'vA = v2 今の live', v9b: 'vB = v9b 書き直した live', v9c: 'vC = v9c 書き直した live + 手の短い書き方' };
const ids = ['prod', ...only];
type Final = { verdict: '○' | '△' | '×' | '?'; by: 'check' | 'judge' | 'pending'; reason: string };
interface Entry { scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; failed: string[]; shape: boolean }
function finalOf(scene: SceneFile, item: ReturnType<typeof candidatesOf>[number], source: typeof judged): Final {
  if (item.score.verdict === '×') return { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
  if (item.score.verdict === '○' && scene.judge !== 'always') return { verdict: '○', by: 'check', reason: '検査' };
  const judge = source.get(`${scene.id}|${item.key}`);
  if (judge) return { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason };
  return { verdict: item.score.verdict === '○' ? '○' : '?', by: item.score.verdict === '○' ? 'check' : 'pending', reason: '' };
}
function entries(source: typeof judged): Entry[] {
  const list: Entry[] = [];
  for (const scene of scenes) {
    const decision = decisionOf(runs, scene);
    for (const item of candidatesOf(scene, decision, rows)) list.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final: finalOf(scene, item, source), failed: item.score.failed, shape: !item.answer.shapeProblem });
  }
  return list;
}
const table = entries(judged), tableB = entries(judgedB);
const count = (list: Entry[], verdict: string) => list.filter(item => item.final.verdict === verdict).length;
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const out: string[] = [];

out.push('## 1. 正しさ（45 場面 × 回数。○=1 △=0.5 ×=0）\n', '| 版 | 回数 | ○ | △ | × | 未採点 | 平均点 | 場面ごとの平均の平均 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
const perScene = (id: string, list: Entry[]) => new Map(scenes.map(scene => {
  const mine = list.filter(item => item.scene.id === scene.id && item.variant === id);
  return [scene.id, mine.length ? mean(mine.map(item => points[item.final.verdict]!)) : NaN] as const;
}));
for (const id of ids) {
  const list = table.filter(item => item.variant === id);
  if (!list.length) continue;
  out.push(`| ${LABEL[id]} | ${list.length} | ${count(list, '○')} | ${count(list, '△')} | ${count(list, '×')} | ${count(list, '?')} | ${f(mean(list.map(item => points[item.final.verdict]!)), 2)} | ${f(mean([...perScene(id, table).values()].filter(Number.isFinite)), 2)} |`);
}

out.push('\n## 2. 種類ごとの ○ / 回数\n');
const categories = ['stopped', 'urgent', 'death', 'progress', 'plan'];
out.push(`| 版 | ${categories.join(' | ')} |`, `|---|${categories.map(() => '---:').join('|')}|`);
for (const id of ids) out.push(`| ${id} | ${categories.map(category => { const list = table.filter(item => item.variant === id && item.scene.category.includes(category)); return `${count(list, '○')}/${list.length}`; }).join(' | ')} |`);

out.push('\n## 3. ×の中身（回数。1 つの答えが複数に当たることがある）\n');
const kindOf = (reason: string) => /^塞がったマスへ歩く/u.test(reason) ? '塞がった・床の無いマスへ walk' : /^同じ止まり/u.test(reason) ? '止まった手のくり返し' : /^体に送れない/u.test(reason) ? '体に送れない形'
  : /^道具の呼び出し/u.test(reason) ? '道具の呼び出しが無い' : `場面の必須: ${reason.split(':')[0]}`;
const kinds = new Map<string, Map<string, number>>();
const bump = (kind: string, id: string) => { if (!kinds.has(kind)) kinds.set(kind, new Map()); kinds.get(kind)!.set(id, (kinds.get(kind)!.get(id) ?? 0) + 1); };
for (const item of table) {
  for (const reason of item.failed) bump(kindOf(reason), item.variant);
  if (item.final.by === 'judge' && item.final.verdict === '×') bump('採点者が×（検査は通った）', item.variant);
}
out.push(`| ×の種類 | ${ids.join(' | ')} |`, `|---|${ids.map(() => '---:').join('|')}|`);
for (const [kind, per] of [...kinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) out.push(`| ${kind} | ${ids.map(id => per.get(id) ?? 0).join(' | ')} |`);
out.push(`| （回数） | ${ids.map(id => table.filter(item => item.variant === id).length).join(' | ')} |`);

out.push('\n## 4. 時間・トークン・費用（1 判断。自分の PC からストリームで測る。キャッシュは 5 分、場面の間は連続でないので本番より書き込みが多い）\n');
out.push('| 版 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 全体 p50 / p95 (s) | 入力の合計（新規 + 読み + 書き） | うち新規 | 出力トークン（考え + 答え） | 費用 平均 ($) | 費用 合計 ($) |', '|---|---:|---|---|---:|---:|---:|---:|---:|');
const okRows = (id: string) => rows.filter(row => row.variant === id && row.ok);
for (const id of only) {
  const list = okRows(id);
  if (!list.length) continue;
  out.push(`| ${LABEL[id]} | ${list.length} | ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.5))} / ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.95))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.usage.input)), 0)} | ${f(mean(list.map(r => r.usage.output)), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(list.reduce((sum, r) => sum + r.costUsd, 0), 2)} |`);
}

out.push('\n## 5. 対の比べ（場面ごとの平均点の差の平均と、場面を引き直した 95% の幅）\n');
let seed = 20261023;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
out.push('| 比べ | 場面の数 | 差の平均 | 95% の幅 | 良くなった / 同じ / 悪くなった（差 0.25 以上） |', '|---|---:|---:|---|---|');
for (const [a, b] of [['v9b', 'v2'], ['v9c', 'v2'], ['v9c', 'v9b']] as const) {
  if (!only.includes(a) || !only.includes(b)) continue;
  const left = perScene(a, table), right = perScene(b, table);
  const diffs = scenes.flatMap(scene => Number.isFinite(left.get(scene.id)!) && Number.isFinite(right.get(scene.id)!) ? [left.get(scene.id)! - right.get(scene.id)!] : []);
  if (!diffs.length) continue;
  const boot = Array.from({ length: 4000 }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!))).sort((x, y) => x - y);
  out.push(`| ${a} − ${b} | ${diffs.length} | ${f(mean(diffs), 2)} | ${f(boot[100]!, 2)} 〜 ${f(boot[3899]!, 2)} | ${diffs.filter(d => d >= 0.25).length} / ${diffs.filter(d => Math.abs(d) < 0.25).length} / ${diffs.filter(d => d <= -0.25).length} |`);
}

out.push('\n## 6. 採点者の一致（同じ答えを Opus で 2 回採点）\n');
const both = table.flatMap(item => { const other = tableB.find(x => x.scene.id === item.scene.id && x.key === item.key); return other && item.final.by === 'judge' && other.final.by === 'judge' ? [[item, other] as const] : []; });
if (both.length) {
  const same = both.filter(([a, b]) => a.final.verdict === b.final.verdict).length;
  const near = both.filter(([a, b]) => (a.final.verdict === '×') === (b.final.verdict === '×')).length;
  out.push(`- 両方の回で採点者が決めた答え ${both.length} 個: ○△× が一致 ${same}（${f(100 * same / both.length, 0)}%）、「× かどうか」が一致 ${near}（${f(100 * near / both.length, 0)}%）。`);
  const matrix = ['○', '△', '×'].map(a => ['○', '△', '×'].map(b => both.filter(([x, y]) => x.final.verdict === a && y.final.verdict === b).length));
  out.push('', '| 1 回目＼2 回目 | ○ | △ | × |', '|---|---:|---:|---:|', ...['○', '△', '×'].map((a, i) => `| ${a} | ${matrix[i]!.join(' | ')} |`));
  // 2 回目の採点で版ごとの平均点を出すと、結論が採点の揺れに左右されないかを見られる（2 回目を付けた場面だけ）。
  const scenesB = new Set(tableB.filter(item => item.final.by === 'judge').map(item => item.scene.id));
  out.push('', `2 回目を付けた ${scenesB.size} 場面だけで、1 回目と 2 回目の平均点（○=1 △=0.5）:`, '', '| 版 | 1 回目の採点 | 2 回目の採点 |', '|---|---:|---:|');
  for (const id of only) {
    const a = table.filter(item => item.variant === id && scenesB.has(item.scene.id)), b = tableB.filter(item => item.variant === id && scenesB.has(item.scene.id));
    out.push(`| ${id} | ${f(mean(a.map(item => points[item.final.verdict]!)), 2)} | ${f(mean(b.map(item => points[item.final.verdict]!)), 2)} |`);
  }
} else out.push('- 2 回目の採点は無い。');

out.push('\n## 7. 場面ごと（回ごとに ○△×、? は未採点）\n');
out.push(`| 場面 | 種類 | ${ids.join(' | ')} |`, `|---|---|${ids.map(() => '---').join('|')}|`);
for (const scene of scenes) {
  const cell = (id: string) => table.filter(item => item.scene.id === scene.id && item.variant === id).sort((a, b) => String(a.rep).localeCompare(String(b.rep))).map(item => item.final.verdict).join('');
  out.push(`| ${scene.id} | ${scene.category.join(',')} | ${ids.map(cell).join(' | ')} |`);
}

out.push('\n## 8. 形・書き方の誤り\n', '| 版 | 体に送れる形 | 書き方の誤り（v9c） |', '|---|---:|---:|');
for (const id of only) {
  const list = table.filter(item => item.variant === id);
  const notation = rows.filter(row => row.variant === id && (row as { slim?: { notationError?: unknown } }).slim?.notationError).length;
  out.push(`| ${id} | ${list.filter(item => item.shape).length}/${list.length} | ${notation} |`);
}

out.push('\n## 9. 回数\n', '| 版 | 場面 | 1 回だけの場面 | 2 回以上の場面 | 呼び出し |', '|---|---:|---:|---:|---:|');
for (const id of only) {
  const per = new Map<string, number>();
  for (const row of okRows(id)) per.set(row.scene, (per.get(row.scene) ?? 0) + 1);
  out.push(`| ${id} | ${per.size} | ${[...per.values()].filter(n => n === 1).length} | ${[...per.values()].filter(n => n >= 2).length} | ${okRows(id).length} |`);
}
writeFileSync(dataFile('report4-tables.md'), `${out.join('\n')}\n`);
writeFileSync(dataFile('report4-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, key: item.key, variant: item.variant, rep: item.rep, verdict: item.final.verdict, by: item.final.by, reason: item.final.reason, failed: item.failed })), null, 1));
console.log(out.join('\n'));
