import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadAllRuns, dataFile } from './allRuns.js';
import { contextOf } from './checks.js';
import { loadJudged, type Candidate } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, loadScenes, type SceneFile } from './score.js';
import { candidatesOf5, latest, readRows, VIEWS } from './views5.js';

/**
 * 10/23 の 4 つ目の比べ（基準 v1 と候補の版）の表。
 *   node --import tsx tests/decisionReplay/report5.ts [--views=v1,v1t] [--judge=judge5.jsonl] [--judge2=judge5b.jsonl] [--out=report5-tables.md] [--candidate=candt --baseline=v1t]
 * 採点 = 決まった検査 + 後知恵つき Opus（judge5.ts）。結果の行 = results.jsonl（前の v1）+ results5.jsonl（足した v1）+ 候補の行（results6.jsonl）。
 * 答えのトークンの数は count_tokens（無料）で数える（鍵が環境に無ければ飛ばす）。
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const viewIds = flag('views', 'v1,v1t').split(',');
const baseline = flag('baseline', 'v1t'), candidate = flag('candidate', '');
const views = VIEWS.filter(view => viewIds.includes(view.id));
const variantsOf = [...new Set(views.map(view => view.variant))];
const rows = latest(readRows()).filter(row => variantsOf.includes(row.variant));
const runs = loadAllRuns();
const judged = loadJudged(dataFile(flag('judge', 'judge5.jsonl'))), judgedB = loadJudged(dataFile(flag('judge2', 'judge5b.jsonl')));
const scenes = loadScenes();
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const f = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const LABEL: Record<string, string> = { prod: '本番の記録（n=1、場面の時の版）', ...Object.fromEntries(views.map(view => [view.id, `${view.id} ${view.label}`])) };
const ids = ['prod', ...views.map(view => view.id)];
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };

type Final = { verdict: '○' | '△' | '×' | '?'; by: 'check' | 'judge' | 'pending'; reason: string };
interface Entry { scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; failed: string[]; shape: boolean; fixes: number }
function finalOf(scene: SceneFile, item: Candidate, source: typeof judged): Final {
  if (item.score.verdict === '×') return { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
  if (item.score.verdict === '○' && scene.judge !== 'always') return { verdict: '○', by: 'check', reason: '検査' };
  const judge = source.get(`${scene.id}|${item.key}`);
  if (judge) return { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason };
  return { verdict: item.score.verdict === '○' ? '○' : '?', by: item.score.verdict === '○' ? 'check' : 'pending', reason: '' };
}
const cache = new Map<string, Candidate[]>();
async function entries(source: typeof judged): Promise<Entry[]> {
  const list: Entry[] = [];
  for (const scene of scenes) {
    const decision = decisionOf(runs, scene);
    if (!cache.has(scene.id)) cache.set(scene.id, await candidatesOf5(scene, decision, rows, views));
    for (const item of cache.get(scene.id)!) list.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final: finalOf(scene, item, source), failed: item.score.failed,
      shape: !item.answer.shapeProblem, fixes: item.score.stopIfFixes.length });
  }
  return list;
}
const table = await entries(judged), tableB = await entries(judgedB);
const count = (list: Entry[], verdict: string) => list.filter(item => item.final.verdict === verdict).length;
const out: string[] = [];

out.push(`## 1. 正しさ（${scenes.length} 場面 × 回数。○=1 △=0.5 ×=0。未採点 = 採点者がまだ付けていない ○△ の候補で、平均点には入れない）\n`, '| 見え方 | 回数 | ○ | △ | × | 未採点 | 平均点（未採点を除く） | 場面ごとの平均の平均 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
const perScene = (id: string, list: Entry[]) => new Map(scenes.map(scene => {
  const mine = list.filter(item => item.scene.id === scene.id && item.variant === id && item.final.verdict !== '?');
  return [scene.id, mine.length ? mean(mine.map(item => points[item.final.verdict]!)) : NaN] as const;
}));
for (const id of ids) {
  const list = table.filter(item => item.variant === id);
  if (!list.length) continue;
  const decided = list.filter(item => item.final.verdict !== '?');
  out.push(`| ${LABEL[id]} | ${list.length} | ${count(list, '○')} | ${count(list, '△')} | ${count(list, '×')} | ${count(list, '?')} | ${f(mean(decided.map(item => points[item.final.verdict]!)), 2)} | ${f(mean([...perScene(id, table).values()].filter(Number.isFinite)), 2)} |`);
}

out.push('\n## 2. 種類ごとの ○ / 回数\n');
const categories = ['stopped', 'urgent', 'death', 'progress', 'plan'];
out.push(`| 見え方 | ${categories.join(' | ')} |`, `|---|${categories.map(() => '---:').join('|')}|`);
for (const id of ids) out.push(`| ${id} | ${categories.map(category => { const list = table.filter(item => item.variant === id && item.scene.category.includes(category)); return `${count(list, '○')}/${list.length}`; }).join(' | ')} |`);

out.push('\n## 3. ×の中身（回数。1 つの答えが複数に当たることがある）\n');
const feet = new Map<string, { x: number; y: number; z: number }>();
for (const scene of scenes) feet.set(scene.id, contextOf(decisionOf(runs, scene)).self);
const kindOf = (item: Entry, reason: string): string => {
  if (/^塞がったマスへ歩く/u.test(reason)) {
    const m = /^塞がったマスへ歩く: 手\d+ walk \((-?\d+),(-?\d+),(-?\d+)\)/.exec(reason), p = feet.get(item.scene.id)!;
    const d = m ? Math.max(Math.abs(+m[1]! - p.x), Math.abs(+m[3]! - p.z), Math.abs(+m[2]! - p.y)) : 99;
    return d <= 2 ? '塞がった・床の無いマスへ walk（足から 2 マス以内）' : '塞がった・床の無いマスへ walk（足から 3 マス以上先）';
  }
  return /^同じ止まり/u.test(reason) ? '止まった手のくり返し' : /^体に送れない/u.test(reason) ? '体に送れない形' : /^道具の呼び出し/u.test(reason) ? '道具の呼び出しが無い' : `規則・場面の必須: ${reason.split(':')[0]}`;
};
const kinds = new Map<string, Map<string, number>>();
const bump = (kind: string, id: string) => { if (!kinds.has(kind)) kinds.set(kind, new Map()); kinds.get(kind)!.set(id, (kinds.get(kind)!.get(id) ?? 0) + 1); };
for (const item of table) {
  for (const reason of item.failed) bump(kindOf(item, reason), item.variant);
  if (item.final.by === 'judge' && item.final.verdict === '×') bump('採点者が×（検査は通った）', item.variant);
}
out.push(`| ×の種類 | ${ids.join(' | ')} |`, `|---|${ids.map(() => '---:').join('|')}|`);
for (const [kind, per] of [...kinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) out.push(`| ${kind} | ${ids.map(id => per.get(id) ?? 0).join(' | ')} |`);
out.push(`| （答えの数） | ${ids.map(id => table.filter(item => item.variant === id).length).join(' | ')} |`);

out.push('\n## 4. 時間・トークン・費用（1 判断。自分の PC からストリームで測る。キャッシュは 5 分、場面の間は連続でないので本番より書き込みが多い）\n');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
const client = apiKey ? new Anthropic({ apiKey, maxRetries: 2 }) : null;
const tokenFile = dataFile('answer-tokens.json');
const tokenCache: Record<string, number> = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')) as Record<string, number> : {};
let empty: number | null = null;
async function tokensOf(value: unknown): Promise<number | null> {
  const text = JSON.stringify(value);
  const key = `${text.length}:${text.slice(0, 60)}:${text.slice(-60)}`;
  if (tokenCache[key] !== undefined) return tokenCache[key]!;
  if (!client) return null;
  empty ??= (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: '.' }] })).input_tokens;
  const tokens = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: text }] })).input_tokens - empty + 1;
  tokenCache[key] = tokens;
  return tokens;
}
out.push('| 変種 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 全体 p50 / p95 (s) | 入力の合計 平均 | うち新規 | キャッシュ読み | キャッシュ書き | 出力 平均 | うち答え | 見えない考え | 費用 平均（この台の実額） | 本番想定 1 判断 | 合計 |', '|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const variant of variantsOf) {
  const list = rows.filter(row => row.variant === variant);
  const acts = list.filter(row => row.answer.tool === 'mc.act');
  const answerTokens = (await Promise.all(acts.map(row => tokensOf(row.answer.input)))).filter((v): v is number => v !== null);
  // 本番想定: 履歴は毎判断キャッシュから読み、尾 800 トークンだけ 1 時間書き込みで書く。
  const model = variant === 'v3' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
  const assumed = mean(list.map(row => costOf(model, { input: row.usage.input, output: row.usage.output, cacheWrite: 800, cacheRead: Math.max(0, row.usage.cacheRead + row.usage.cacheWrite - 800), cacheWrite1h: 800, cacheWrite5m: 0 })));
  const first = list.map(row => row.tFirstBlock! / 1000);
  out.push(`| ${variant} | ${list.length} | ${f(quantile(first, 0.5))} / ${f(quantile(first, 0.95))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.usage.input)), 0)} | ${f(mean(list.map(r => r.usage.cacheRead)), 0)} | ${f(mean(list.map(r => r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.usage.output)), 0)} | ${f(mean(answerTokens), 0)} | ${f(mean(list.map(r => r.usage.output)) - mean(answerTokens), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(assumed, 4)} | ${f(list.reduce((sum, r) => sum + r.costUsd, 0), 2)} |`);
}
if (client) writeFileSync(tokenFile, JSON.stringify(tokenCache));
out.push('\n温かい呼び出し（2・3 回目）だけ:\n', '| 変種 | 呼び出し | 最初のブロックまで p50 (s) | 全体 p50 / p95 (s) | 費用 平均 |', '|---|---:|---:|---|---:|');
for (const variant of variantsOf) {
  const list = rows.filter(row => row.variant === variant && row.rep >= 2);
  out.push(`| ${variant} | ${list.length} | ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.5))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.costUsd)), 4)} |`);
}

out.push('\n## 5. 対の比べ（場面ごとの平均点の差の平均と、場面を引き直した 95% の幅）\n');
let seed = 20261023;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
out.push('| 比べ | 場面の数 | 差の平均 | 95% の幅 | 良くなった / 同じ / 悪くなった（差 0.25 以上） |', '|---|---:|---:|---|---|');
const pairs: Array<[string, string]> = [['v1t', 'v1']];
if (candidate) pairs.push([candidate, baseline]);
for (const [a, b] of pairs) {
  if (!ids.includes(a) || !ids.includes(b)) continue;
  const left = perScene(a, table), right = perScene(b, table);
  const diffs = scenes.flatMap(scene => Number.isFinite(left.get(scene.id)!) && Number.isFinite(right.get(scene.id)!) ? [left.get(scene.id)! - right.get(scene.id)!] : []);
  if (!diffs.length) continue;
  const boot = Array.from({ length: 4000 }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!))).sort((x, y) => x - y);
  out.push(`| ${a} − ${b} | ${diffs.length} | ${f(mean(diffs), 3)} | ${f(boot[100]!, 3)} 〜 ${f(boot[3899]!, 3)} | ${diffs.filter(d => d >= 0.25).length} / ${diffs.filter(d => Math.abs(d) < 0.25).length} / ${diffs.filter(d => d <= -0.25).length} |`);
}

out.push('\n## 6. 頭の変換を通す前と後（v1 → v1t）\n');
{
  const acts = rows.filter(row => row.variant === 'v1');
  const a = table.filter(item => item.variant === 'v1'), b = table.filter(item => item.variant === 'v1t');
  const changed = b.filter(item => { const other = a.find(x => x.scene.id === item.scene.id && x.rep === item.rep); return other && (other.final.verdict !== item.final.verdict || other.failed.join() !== item.failed.join()); });
  out.push(`- v1 の答え ${acts.length} 個（mc.act ${acts.filter(row => row.answer.tool === 'mc.act').length}）。stopIf の点検が直す必要があった答え（hpBelow が今の体力以上、または待つ手に hostileWithin 無し）: ${a.filter(item => item.fixes > 0).length}。`);
  out.push(`- 変換の前後で検査の結果か採点が変わった答え: ${changed.length}。`);
  for (const item of changed) {
    const other = a.find(x => x.scene.id === item.scene.id && x.rep === item.rep)!;
    out.push(`  - ${item.scene.id} 回${item.rep}: ${other.final.verdict}${other.failed.length ? `（${other.failed.join(' / ').slice(0, 80)}）` : ''} → ${item.final.verdict}`);
  }
  out.push(`- 平均点: 変換なし ${f(mean(a.filter(x => x.final.verdict !== '?').map(item => points[item.final.verdict]!)), 3)} → 変換あり ${f(mean(b.filter(x => x.final.verdict !== '?').map(item => points[item.final.verdict]!)), 3)}（未採点: ${count(a, '?')} → ${count(b, '?')}）。`);
  const hostile = (list: Entry[]) => list.filter(item => item.failed.some(reason => /hostileWithin/u.test(reason))).length;
  out.push(`- 「待つ act に hostileWithin が無い」で × になった答え: 変換なし ${hostile(a)} → 変換あり ${hostile(b)}。`);
}

out.push('\n## 7. 採点者の一致（同じ答えを Opus で 2 回採点）\n');
const both = table.flatMap(item => { const other = tableB.find(x => x.scene.id === item.scene.id && x.key === item.key); return other && item.final.by === 'judge' && other.final.by === 'judge' ? [[item, other] as const] : []; });
if (both.length) {
  const same = both.filter(([a, b]) => a.final.verdict === b.final.verdict).length;
  const near = both.filter(([a, b]) => (a.final.verdict === '×') === (b.final.verdict === '×')).length;
  out.push(`- 両方の回で採点者が決めた答え ${both.length} 個: ○△× が一致 ${same}（${f(100 * same / both.length, 0)}%）、「× かどうか」が一致 ${near}（${f(100 * near / both.length, 0)}%）。`);
  const matrix = ['○', '△', '×'].map(a => ['○', '△', '×'].map(b => both.filter(([x, y]) => x.final.verdict === a && y.final.verdict === b).length));
  out.push('', '| 1 回目＼2 回目 | ○ | △ | × |', '|---|---:|---:|---:|', ...['○', '△', '×'].map((a, i) => `| ${a} | ${matrix[i]!.join(' | ')} |`));
  const scenesB = new Set(tableB.filter(item => item.final.by === 'judge').map(item => item.scene.id));
  out.push('', `2 回目を付けた ${scenesB.size} 場面だけで、1 回目と 2 回目の平均点:`, '', '| 見え方 | 1 回目の採点 | 2 回目の採点 |', '|---|---:|---:|');
  for (const id of ids) {
    const a = table.filter(item => item.variant === id && scenesB.has(item.scene.id) && item.final.verdict !== '?'), b = tableB.filter(item => item.variant === id && scenesB.has(item.scene.id) && item.final.verdict !== '?');
    out.push(`| ${id} | ${f(mean(a.map(item => points[item.final.verdict]!)), 2)} | ${f(mean(b.map(item => points[item.final.verdict]!)), 2)} |`);
  }
} else out.push('- 2 回目の採点は無い。');

out.push('\n## 8. 場面ごと（回ごとに ○△×、? は未採点）\n');
out.push(`| 場面 | 種類 | ${ids.join(' | ')} |`, `|---|---|${ids.map(() => '---').join('|')}|`);
for (const scene of scenes) {
  const cell = (id: string) => table.filter(item => item.scene.id === scene.id && item.variant === id).sort((a, b) => String(a.rep).localeCompare(String(b.rep))).map(item => item.final.verdict).join('');
  out.push(`| ${scene.id} | ${scene.category.join(',')} | ${ids.map(cell).join(' | ')} |`);
}

out.push('\n## 9. 回数と場面の種類\n', '| 変種 | 場面 | 1 回 | 2 回 | 3 回以上 | 呼び出し |', '|---|---:|---:|---:|---:|---:|');
for (const variant of variantsOf) {
  const per = new Map<string, number>();
  for (const row of rows.filter(r => r.variant === variant)) per.set(row.scene, (per.get(row.scene) ?? 0) + 1);
  out.push(`| ${variant} | ${per.size} | ${[...per.values()].filter(n => n === 1).length} | ${[...per.values()].filter(n => n === 2).length} | ${[...per.values()].filter(n => n >= 3).length} | ${rows.filter(r => r.variant === variant).length} |`);
}
const cats = new Map<string, number>();
for (const scene of scenes) cats.set(scene.category.join('+'), (cats.get(scene.category.join('+')) ?? 0) + 1);
out.push('', `場面 ${scenes.length}: ${[...cats].map(([k, n]) => `${k} ${n}`).join('、')}。`);

writeFileSync(dataFile(flag('out', 'report5-tables.md')), `${out.join('\n')}\n`);
writeFileSync(dataFile('report5-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, key: item.key, variant: item.variant, rep: item.rep, verdict: item.final.verdict, by: item.final.by, reason: item.final.reason, failed: item.failed })), null, 1));
console.log(out.join('\n'));
