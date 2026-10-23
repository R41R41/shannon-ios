import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadAllRuns, dataFile } from './allRuns.js';
import { answerOf, contextOf } from './checks.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { llmcPrepare } from '../../src/surfaces/minecraft/minecraftLlmc.js';
import { checkedStopIf } from '../../src/surfaces/minecraft/minecraftLlmcStopIf.js';
import { heldOfFrame } from '../../src/surfaces/minecraft/minecraftLlmcPartial.js';
import { candFrame } from './candidateAdapter.js';
import { frames } from './sceneSet.js';
import { loadJudged, type Candidate } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, loadScenes, scoreAnswer, type SceneFile } from './score.js';
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

type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const assumedOne = (model: string, u: Usage) => costOf(model, { input: u.input, output: u.output, cacheWrite: 800, cacheRead: Math.max(0, u.cacheRead + u.cacheWrite - 800), cacheWrite1h: 800, cacheWrite5m: 0 });
/** 本番想定の 1 判断: 履歴は毎判断キャッシュから読み、尾 800 トークンだけ 1 時間書き込みで書く。守りで聞き直した行は、1 回目と聞き直しをそれぞれ本番想定にして足す。 */
function assumedRow(row: { usage: Usage; firstUsage?: Usage }, model: string): number {
  const f1 = row.firstUsage;
  if (!f1 || row.usage.output === f1.output) return assumedOne(model, row.usage);
  return assumedOne(model, f1) + assumedOne(model, { input: row.usage.input - f1.input, output: row.usage.output - f1.output, cacheWrite: row.usage.cacheWrite - f1.cacheWrite, cacheRead: row.usage.cacheRead - f1.cacheRead });
}
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
  const answerTokens = (await Promise.all(acts.map(row => tokensOf((row as { rawFinal?: unknown }).rawFinal ?? (row as { rawFirst?: unknown }).rawFirst ?? row.answer.input)))).filter((v): v is number => v !== null);
  // 本番想定: 履歴は毎判断キャッシュから読み、尾 800 トークンだけ 1 時間書き込みで書く。
  const model = variant === 'v3' ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
  const assumed = mean(list.map(row => assumedRow(row, model)));
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

if (candidate) {
  type Guard = { stopped: boolean; sentHands?: number; hand?: number; code?: string; reask?: string; stoppedAgain?: boolean };
  const candVariant = views.find(view => view.id === candidate)!.variant;
  const candRows = rows.filter(row => row.variant === candVariant) as Array<(typeof rows)[number] & { sent?: { guard?: Guard }; rawFirst?: unknown }>;
  out.push('\n## 10. 候補の守り（部分送り・規則の守り）\n');
  const guarded = candRows.filter(row => row.sent?.guard);
  const whole = guarded.filter(row => row.sent!.guard!.stopped), part = guarded.filter(row => !row.sent!.guard!.stopped);
  const reasks = [...new Set(guarded.map(row => row.sent!.guard!.reask ?? '-'))].map(kind => `${kind} ${guarded.filter(row => (row.sent!.guard!.reask ?? '-') === kind).length}`).join('、');
  out.push(`- 候補の答え ${candRows.length} 個のうち、守りが止めた答え ${guarded.length}（全部止め ${whole.length}、部分送り ${part.length}）。聞き直しの答えの道具: ${reasks}。聞き直しの答えがまた止まった: ${guarded.filter(row => row.sent!.guard!.stoppedAgain).length}。`);
  // 誤って止めたか: 止められた 1 回目の答え（全部の手）を検査にかけ、塞がったマスへ歩く・くり返し・場面の必須で × にならないなら、検査の目では「止める必要が無かった」（疑い）。
  const sceneById = new Map(scenes.map(scene => [scene.id, scene]));
  const unneeded: string[] = [];
  const codes = new Map<string, number>();
  const lines: string[] = [];
  let sure = 0;
  for (const row of guarded) {
    const scene = sceneById.get(row.scene)!, decision = decisionOf(runs, scene), context = contextOf(decision);
    const frame = candFrame(decision, frames(runs, decision.run.key));
    const prepared = llmcPrepare('mc.act', candidateInput('mc.act', row.rawFirst));
    const held = prepared.problem ? null : heldOfFrame(checkedStopIf(prepared.input, frame).input, frame, `replay-${row.scene}-${row.rep}`);
    const code = held?.code ?? (row.sent!.guard!.sentHands === 3 && !row.sent!.guard!.stopped ? 'urgent_limit' : '?');
    codes.set(code, (codes.get(code) ?? 0) + 1);
    const raw = answerOf([{ type: 'tool_use', name: 'mc_act', input: candidateInput('mc.act', row.rawFirst) }] as never);
    const score = scoreAnswer(scene, context, raw);
    const hit = score.failed.some(reason => /^(塞がったマスへ歩く|同じ止まり)/u.test(reason) || /^[a-z][a-z0-9-]+:/u.test(reason));
    if (hit) sure += 1; else unneeded.push(`${row.scene.slice(0, 3)} r${row.rep}`);
    lines.push(`| ${row.scene.slice(0, 3)} r${row.rep} | ${row.sent!.guard!.stopped ? '全部止め' : `部分送り（手 1〜${row.sent!.guard!.sentHands}）`} | 手 ${held?.hand ?? (code === 'urgent_limit' ? 4 : '?')} ${code} | ${hit ? '検査でも ×（確かな止め）' : '検査では × にならない（疑い）'} | ${(held?.line ?? '').slice(0, 110)} |`);
  }
  out.push(`- 止めた手の種類（code）: ${[...codes].map(([code, n]) => `${code} ${n}`).join('、')}。`);
  out.push(`- 止められた 1 回目の答え ${guarded.length} 個を検査にかけると、塞がったマスへ歩く・くり返し・場面の必須で × になった物 ${sure}。検査では × にならなかった止め（誤って止めた疑い。中身は人が読む）: ${unneeded.length}${unneeded.length ? `（${unneeded.join('、')}）` : ''}。`);
  out.push('', '| 場面・回 | 止め方 | 止めた手 | 検査の目 | 返した事実（先頭） |', '|---|---|---|---|---|', ...lines, '');
  // 合格の線
  const sel = (id: string) => table.filter(item => item.variant === id);
  const decidedOf = (list: Entry[]) => list.filter(item => item.final.verdict !== '?');
  const meanOf = (list: Entry[]) => mean(decidedOf(list).map(item => points[item.final.verdict]!));
  const walkErrors = (list: Entry[]) => list.reduce((n, item) => n + item.failed.filter(reason => /^塞がったマスへ歩く/u.test(reason)).length, 0);
  const ruleErrors = (list: Entry[]) => list.reduce((n, item) => n + item.failed.filter(reason => /^[a-z][a-z0-9-]+:/u.test(reason)).length, 0);
  const per90 = (n: number, list: Entry[]) => n * 90 / Math.max(1, list.length);
  const b = sel(baseline);
  const columns = [...(flag('previous', '') ? flag('previous', '').split(',') : []), candidate].filter(id => ids.includes(id));
  const boots = new Map<string, { diff: number; lo: number; hi: number }>();
  for (const id of columns) {
    const left = perScene(id, table), right = perScene(baseline, table);
    const diffs = scenes.flatMap(scene => Number.isFinite(left.get(scene.id)!) && Number.isFinite(right.get(scene.id)!) ? [left.get(scene.id)! - right.get(scene.id)!] : []);
    const boot = Array.from({ length: 4000 }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(random() * diffs.length)]!))).sort((x, y) => x - y);
    boots.set(id, { diff: mean(diffs), lo: boot[100]!, hi: boot[3899]! });
  }
  const statOf = (id: string) => rows.filter(row => row.variant === views.find(view => view.id === id)!.variant);
  const baseStat = rows.filter(row => row.variant === 'v1');
  const p50 = (list: typeof rows) => quantile(list.map(row => row.tEnd / 1000), 0.5);
  const verdict = (ok: boolean) => ok ? '通った' : '通らなかった';
  out.push(`\n## 11. 改修案の「合格の線」との照らし合わせ（基準 = ${baseline}、候補 = ${columns.join('・')}）\n`, `| 物差し | 基準 ${baseline} | ${columns.map(id => `${id}`).join(' | ')} | 合格の線 | 判定（${columns.join(' / ')}） |`, `|---|---:|${columns.map(() => '---:').join('|')}|---|---|`);
  const meanRow = columns.map(id => { const c = sel(id), bt = boots.get(id)!; return `${f(meanOf(c), 2)}（差 ${f(bt.diff, 3)}、幅 ${f(bt.lo, 3)} 〜 ${f(bt.hi, 3)}）`; });
  out.push(`| 平均点（○1・△0.5・×0） | ${f(meanOf(b), 2)} | ${meanRow.join(' | ')} | 0.70 以上、差の幅が 0 を含まない | ${columns.map(id => verdict(meanOf(sel(id)) >= 0.7 && boots.get(id)!.lo > 0)).join(' / ')} |`);
  out.push(`| 塞がった・床の無いマスへの walk の誤り（90 答えあたり） | ${f(per90(walkErrors(b), b), 1)}（${walkErrors(b)}/${b.length}） | ${columns.map(id => { const c = sel(id); return `${f(per90(walkErrors(c), c), 1)}（${walkErrors(c)}/${c.length}）`; }).join(' | ')} | 2 以下 | ${columns.map(id => verdict(per90(walkErrors(sel(id)), sel(id)) <= 2)).join(' / ')} |`);
  out.push(`| 規則の誤り（場面の必須の検査の ×。90 答えあたり） | ${f(per90(ruleErrors(b), b), 1)}（${ruleErrors(b)}/${b.length}） | ${columns.map(id => { const c = sel(id); return `${f(per90(ruleErrors(c), c), 1)}（${ruleErrors(c)}/${c.length}）`; }).join(' | ')} | 基準の半分以下（仕分けの数は別の表） | ${columns.map(id => verdict(per90(ruleErrors(sel(id)), sel(id)) <= per90(ruleErrors(b), b) / 2)).join(' / ')} |`);
  out.push(`| 1 判断の中央値（聞き直しを含む） | ${f(p50(baseStat), 1)} 秒 | ${columns.map(id => `${f(p50(statOf(id)), 1)} 秒（p95 ${f(quantile(statOf(id).map(row => row.tEnd / 1000), 0.95), 1)}）`).join(' | ')} | 6.0 秒以下 | ${columns.map(id => verdict(p50(statOf(id)) <= 6)).join(' / ')} |`);
  const cost = (list: typeof rows) => mean(list.map(row => assumedRow(row, 'claude-opus-5-5')));
  out.push(`| 1 判断の費用（本番想定） | $${f(cost(baseStat), 4)} | ${columns.map(id => `$${f(cost(statOf(id)), 4)}`).join(' | ')} | $0.045 以下 | ${columns.map(id => verdict(cost(statOf(id)) <= 0.045)).join(' / ')} |`);
  out.push('\n（改修案の「今の本番」の列は 0.54 / 15 / 8 前後 / 7.0 秒 / $0.053 で、これは専用の指示文版 v2 の値だった。この表の基準は v1（本番 3008876 の指示文と live）+ 本番の頭の変換。）');
}
writeFileSync(dataFile(flag('out', 'report5-tables.md')), `${out.join('\n')}\n`);
writeFileSync(dataFile('report5-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, key: item.key, variant: item.variant, rep: item.rep, verdict: item.final.verdict, by: item.final.by, reason: item.final.reason, failed: item.failed })), null, 1));
console.log(out.join('\n'));
