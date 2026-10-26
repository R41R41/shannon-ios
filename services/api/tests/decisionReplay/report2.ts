import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadAllRuns, dataFile } from './allRuns.js';
import { candidatesOf, loadJudged } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, loadScenes, type SceneFile } from './score.js';
import type { Row2 } from './run2.js';
import type { ResultRow } from './run.js';

/**
 * 10/23 の比べの表（markdown）。結果 = results.jsonl（v1〜v3）+ results2.jsonl（v4〜v7）、採点 = judge2.jsonl（2 回目 judge2b.jsonl で一致率）。
 *   node --import tsx tests/decisionReplay/report2.ts   （SHANNON_ANTHROPIC_API_KEY があれば答えの JSON のトークンを count_tokens（無料）で数える）
 */
const runs = loadAllRuns();
const read = <T>(name: string) => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T) : [];
const oldRows = read<ResultRow>('results.jsonl'), newRows = read<Row2>('results2.jsonl');
const rows: Row2[] = [...oldRows, ...newRows];
const judged = loadJudged(dataFile('judge2.jsonl')), judgedB = loadJudged(dataFile('judge2b.jsonl'));
const scenes = loadScenes();
const BASE_SCENES = new Set(scenes.filter(scene => Number(scene.id.slice(1, 3)) <= 35).map(scene => scene.id));
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const f = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const ORDER = ['prod', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7u', 'v7'];
const LABEL: Record<string, string> = {
  prod: '本番の記録（n=1、場面の時の版）', v1: 'v1 今の本番: Opus + 今の指示文', v2: 'v2 Opus + 専用の指示文 + 短い出力', v3: 'v3 Sonnet + 専用の指示文 + 短い出力',
  v4: 'v4 v2 + r10 の頭（補足・線上のマス・知識 1 行）', v5: 'v5 v4 + 送る前の守り（止めたら 1 回聞き直し）', v6: 'v6 v4 の effort high（thinking は切れない）',
  v7u: 'v7u Sonnet + r10（守りなし）', v7: 'v7 Sonnet + r10 + 守り',
};
const out: string[] = [];
type Final = { verdict: '○' | '△' | '×' | '?'; by: 'check' | 'judge' | 'pending'; reason: string };
interface Entry { scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; failed: string[]; shape: boolean; stopIf: string[]; whyTag: boolean }
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
    for (const item of candidatesOf(scene, decision, rows)) {
      list.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final: finalOf(scene, item, source), failed: item.score.failed, shape: !item.answer.shapeProblem,
        stopIf: item.score.stopIfFixes, whyTag: item.score.whyTag });
    }
  }
  return list;
}
const table = entries(judged), tableB = entries(judgedB);
const ids = ORDER.filter(id => table.some(item => item.variant === id));
const count = (list: Entry[], verdict: string) => list.filter(item => item.final.verdict === verdict).length;

out.push('## 1. 正しさ（場面 × 回数。基準の場面 32 と、足した場面 13 を分けて）\n');
for (const [title, filter] of [['全部（45 場面）', () => true], ['基準の場面（実走32〜34、32 場面）', (item: Entry) => BASE_SCENES.has(item.scene.id)], ['足した場面（実走27〜31、13 場面）', (item: Entry) => !BASE_SCENES.has(item.scene.id)]] as const) {
  out.push(`### ${title}\n`, '| 版 | 回数 | ○ | △ | × | 未採点 | ○の割合 | ×の割合 | 平均点（○=1 △=0.5） |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const id of ids) {
    const list = table.filter(item => item.variant === id && filter(item));
    if (!list.length) continue;
    const points = list.map(item => item.final.verdict === '○' ? 1 : item.final.verdict === '△' ? 0.5 : 0);
    out.push(`| ${LABEL[id]} | ${list.length} | ${count(list, '○')} | ${count(list, '△')} | ${count(list, '×')} | ${count(list, '?')} | ${f(100 * count(list, '○') / list.length, 0)}% | ${f(100 * count(list, '×') / list.length, 0)}% | ${f(mean(points), 2)} |`);
  }
  out.push('');
}

out.push('## 2. 種類ごとの ○ の割合（○ / 回数）\n');
const categories = ['stopped', 'urgent', 'death', 'progress', 'plan'];
out.push(`| 版 | ${categories.join(' | ')} |`, `|---|${categories.map(() => '---:').join('|')}|`);
for (const id of ids) {
  out.push(`| ${id} | ${categories.map(category => { const list = table.filter(item => item.variant === id && item.scene.category.includes(category)); return `${count(list, '○')}/${list.length}`; }).join(' | ')} |`);
}

out.push('\n## 3. ×の中身（回数。検査が拾った物と、採点者が×にした物。1 つの答えが複数に当たることがある）\n');
const kindOf = (reason: string) => /^塞がったマスへ歩く/u.test(reason) ? '塞がった・床の無いマスへ walk' : /^同じ止まり/u.test(reason) ? '止まった手のくり返し' : /^体に送れない/u.test(reason) ? '体に送れない形'
  : /^道具の呼び出し/u.test(reason) ? '道具の呼び出しが無い' : `場面の必須: ${reason.split(':')[0]}`;
const kinds = new Map<string, Map<string, number>>();
const bump = (kind: string, id: string) => { if (!kinds.has(kind)) kinds.set(kind, new Map()); kinds.get(kind)!.set(id, (kinds.get(kind)!.get(id) ?? 0) + 1); };
for (const item of table) {
  for (const reason of item.failed) bump(kindOf(reason), item.variant);
  if (item.final.by === 'judge' && item.final.verdict === '×') bump('採点者が×（検査は通った）', item.variant);
}
out.push(`| ×の種類 | ${ids.join(' | ')} |`, `|---|${ids.map(() => '---:').join('|')}|`);
for (const [kind, per] of [...kinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  out.push(`| ${kind} | ${ids.map(id => per.get(id) ?? 0).join(' | ')} |`);
}
out.push(`| （回数） | ${ids.map(id => table.filter(item => item.variant === id).length).join(' | ')} |`);

out.push('\n## 4. 送る前の守り（v5 = v4 の答えにかけた、v7 = v7u の答えにかけた）\n');
out.push('| 版 | 答え | mc.act でない答え | 守りが止めた | 止めた答えの 1 回目の採点（○/△/×） | 誤って止めた（1 回目が ○ か △） | 聞き直しの結果（○/△/×） | 聞き直しで ○ になった | 聞き直しが失敗（エラー） |', '|---|---:|---:|---:|---|---:|---|---:|---:|');
const find = (list: Entry[], variant: string, scene: string, rep: number | 'prod') => list.find(item => item.variant === variant && item.scene.id === scene && item.rep === rep);
const guardLines: string[] = [];
for (const [guardedId, rawId] of [['v5', 'v4'], ['v7', 'v7u']] as const) {
  const mine = rows.filter(row => row.variant === guardedId && row.ok);
  const held = mine.filter(row => row.guard?.stopped);
  const rawGrades = held.map(row => find(table, rawId, row.scene, row.rep)?.final.verdict ?? '?');
  const finalGrades = held.map(row => find(table, guardedId, row.scene, row.rep)?.final.verdict ?? '?');
  const wrongly = rawGrades.filter(grade => grade === '○' || grade === '△').length;
  const tally = (list: string[]) => `${list.filter(g => g === '○').length}/${list.filter(g => g === '△').length}/${list.filter(g => g === '×').length}`;
  const improved = held.filter((_, index) => finalGrades[index] === '○' && rawGrades[index] !== '○').length;
  out.push(`| ${guardedId} | ${mine.length} | ${mine.filter(row => row.answer.tool !== 'mc.act').length} | ${held.length} | ${tally(rawGrades)} | ${wrongly} | ${tally(finalGrades)} | ${improved} | ${held.filter(row => row.guard?.reask && !row.guard.reask.ok).length} |`);
  held.forEach((row, index) => guardLines.push(`| ${guardedId} | ${row.scene} r${row.rep} | 手${row.guard!.hand} ${row.guard!.code} | ${rawGrades[index]} | ${finalGrades[index]} | ${((row.guard!.reask?.tEnd ?? 0) / 1000).toFixed(1)}s $${(row.guard!.reask?.costUsd ?? 0).toFixed(3)} |`));
}
out.push('\n守りが止めた物の一覧:\n', '| 版 | 場面 | 止めた手 | 1 回目 | 聞き直し後 | 聞き直しの時間・費用 |', '|---|---|---|---|---|---|', ...guardLines);

out.push('\n## 5. 時間（1 判断。ストリームで自分の PC から測る。守った版は聞き直しを含む）\n');
out.push('| 版 | 呼び出し | 最初のブロックまで p50 / p95 (s) | 全体 p50 / p95 (s) | 全体 平均 (s) |', '|---|---:|---|---|---:|');
const okRows = (id: string) => rows.filter(row => row.variant === id && row.ok);
for (const id of ids.filter(item => item !== 'prod')) {
  const list = okRows(id);
  out.push(`| ${id} | ${list.length} | ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.5))} / ${f(quantile(list.map(r => r.tFirstBlock! / 1000), 0.95))} | ${f(quantile(list.map(r => r.tEnd / 1000), 0.5))} / ${f(quantile(list.map(r => r.tEnd / 1000), 0.95))} | ${f(mean(list.map(r => r.tEnd / 1000)))} |`);
}

out.push('\n## 6. 出力・入力・費用（1 判断あたり。守った版は 1 回目 + 聞き直し）\n');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY;
const tokenCache = existsSync(dataFile('answer-tokens.json')) ? JSON.parse(readFileSync(dataFile('answer-tokens.json'), 'utf8')) as Record<string, number> : {};
const client = apiKey ? new Anthropic({ apiKey }) : null;
let empty = tokenCache['__empty'];
if (client && empty === undefined) { empty = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: '.' }] })).input_tokens; tokenCache['__empty'] = empty; }
async function answerTokens(row: Row2): Promise<number | null> {
  const text = JSON.stringify(row.answer.input);
  const key = `${text.length}:${text.slice(0, 60)}:${text.slice(-60)}`;
  if (tokenCache[key] !== undefined) return tokenCache[key]!;
  if (!client) return null;
  const tokens = (await client.messages.countTokens({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: text }] })).input_tokens - empty! + 12;
  tokenCache[key] = tokens;
  return tokens;
}
out.push('| 版 | 呼び出し | 出力トークン 平均（考え + 答え） | うち答えの JSON | 見えない考え | 新規入力 平均 | キャッシュ読み 平均 | キャッシュ書き 平均 | 費用 平均 / p50 ($) | 合計 ($) |', '|---|---:|---:|---:|---:|---:|---:|---:|---|---:|');
for (const id of ids.filter(item => item !== 'prod')) {
  const list = okRows(id);
  const firsts = list.map(row => row.firstUsage ?? row.usage);
  const jsonTokens = (await Promise.all(list.filter(row => row.answer.tool === 'mc.act').map(row => answerTokens(row)))).filter((value): value is number => value !== null);
  const outputs = list.filter(row => row.answer.tool === 'mc.act').map(row => (row.firstUsage ?? row.usage).output);
  out.push(`| ${id} | ${list.length} | ${f(mean(firsts.map(u => u.output)), 0)} | ${f(mean(jsonTokens), 0)} | ${f(mean(outputs) - mean(jsonTokens), 0)} | ${f(mean(list.map(r => r.usage.input)), 0)} | ${f(mean(list.map(r => r.usage.cacheRead)), 0)} | ${f(mean(list.map(r => r.usage.cacheWrite)), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} / ${f(quantile(list.map(r => r.costUsd), 0.5), 4)} | ${f(list.reduce((sum, r) => sum + r.costUsd, 0), 2)} |`);
}
out.push('\n（出力トークンの平均は 1 回目の呼び出しの分。守った版の入力・費用は 1 回目と聞き直しの合計。v5 の 1 回目は v4 と同じ呼び出し。）');
if (client) writeFileSync(dataFile('answer-tokens.json'), JSON.stringify(tokenCache));

out.push('\n## 7. 対の比べ（場面ごとの平均点: ○=1 △=0.5 ×=0。同じ場面どうしの差の平均と、場面を引き直した 95% の幅）\n');
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const perScene = (id: string, list: Entry[]) => new Map(scenes.map(scene => {
  const mine = list.filter(item => item.scene.id === scene.id && item.variant === id);
  return [scene.id, mine.length ? mean(mine.map(item => points[item.final.verdict]!)) : NaN] as const;
}));
let seed = 12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
out.push('| 比べ | 場面の数 | 差の平均 | 95% の幅 | 良くなった / 同じ / 悪くなった（差 0.25 以上） |', '|---|---:|---:|---|---|');
for (const [a, b] of [['v2', 'v1'], ['v4', 'v2'], ['v5', 'v4'], ['v5', 'v2'], ['v5', 'v1'], ['v6', 'v4'], ['v7u', 'v3'], ['v7', 'v7u'], ['v7', 'v5'], ['v7', 'v2']] as const) {
  if (!ids.includes(a) || !ids.includes(b)) continue;
  const left = perScene(a, table), right = perScene(b, table);
  const diffs = scenes.flatMap(scene => Number.isFinite(left.get(scene.id)!) && Number.isFinite(right.get(scene.id)!) ? [left.get(scene.id)! - right.get(scene.id)!] : []);
  if (!diffs.length) continue;
  const boot = Array.from({ length: 2000 }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!))).sort((x, y) => x - y);
  out.push(`| ${a} − ${b} | ${diffs.length} | ${f(mean(diffs), 2)} | ${f(boot[50]!, 2)} 〜 ${f(boot[1949]!, 2)} | ${diffs.filter(d => d >= 0.25).length} / ${diffs.filter(d => Math.abs(d) < 0.25).length} / ${diffs.filter(d => d <= -0.25).length} |`);
}

out.push('\n## 8. 採点者の一致（同じ答えを Opus で 2 回採点）\n');
const both = table.flatMap(item => { const other = tableB.find(x => x.scene.id === item.scene.id && x.key === item.key); return other && item.final.by === 'judge' && other.final.by === 'judge' ? [[item, other] as const] : []; });
if (both.length) {
  const same = both.filter(([a, b]) => a.final.verdict === b.final.verdict).length;
  const near = both.filter(([a, b]) => (a.final.verdict === '×') === (b.final.verdict === '×')).length;
  out.push(`- 両方の回で採点者が決めた答え ${both.length} 個: ○△× が一致 ${same}（${f(100 * same / both.length, 0)}%）、「× かどうか」が一致 ${near}（${f(100 * near / both.length, 0)}%）。`);
  const matrix = ['○', '△', '×'].map(a => ['○', '△', '×'].map(b => both.filter(([x, y]) => x.final.verdict === a && y.final.verdict === b).length));
  out.push('', '| 1 回目＼2 回目 | ○ | △ | × |', '|---|---:|---:|---:|', ...['○', '△', '×'].map((a, i) => `| ${a} | ${matrix[i]!.join(' | ')} |`));
} else out.push('- 2 回目の採点は無い。');

out.push('\n## 9. 場面ごと（回ごとに ○△×、? は未採点）\n');
out.push(`| 場面 | 種類 | ${ids.join(' | ')} |`, `|---|---|${ids.map(() => '---').join('|')}|`);
for (const scene of scenes) {
  const cell = (id: string) => table.filter(item => item.scene.id === scene.id && item.variant === id).sort((a, b) => String(a.rep).localeCompare(String(b.rep))).map(item => item.final.verdict).join('');
  out.push(`| ${scene.id} | ${scene.category.join(',')} | ${ids.map(cell).join(' | ')} |`);
}

out.push('\n## 10. 形・stopIf・why の札\n');
out.push('| 版 | 体に送れる形 | stopIf を頭が直す必要 | why が [節] / [急ぎ] で始まる |', '|---|---:|---:|---:|');
for (const id of ids.filter(item => item !== 'prod')) {
  const list = table.filter(item => item.variant === id);
  out.push(`| ${id} | ${list.filter(item => item.shape).length}/${list.length} | ${list.filter(item => item.stopIf.length).length}/${list.length} | ${list.filter(item => item.whyTag).length}/${list.length} |`);
}

out.push('\n## 11. 回数と費用\n');
out.push('| 版 | 場面 | 1 回だけの場面 | 2 回以上の場面 | 呼び出し（行） | 費用 ($、守った版は 1 回目を含む) |', '|---|---:|---:|---:|---:|---:|');
for (const id of ids.filter(item => item !== 'prod')) {
  const per = new Map<string, number>();
  for (const row of okRows(id)) per.set(row.scene, (per.get(row.scene) ?? 0) + 1);
  out.push(`| ${id} | ${per.size} | ${[...per.values()].filter(n => n === 1).length} | ${[...per.values()].filter(n => n >= 2).length} | ${okRows(id).length} | ${f(rows.filter(row => row.variant === id).reduce((sum, row) => sum + row.costUsd, 0), 2)} |`);
}
void costOf;
writeFileSync(dataFile('report2-tables.md'), `${out.join('\n')}\n`);
console.log(out.join('\n'));
