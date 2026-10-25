import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadAllRuns, dataFile } from './allRuns.js';
import { contextOf } from './checks.js';
import { loadJudged, type Candidate } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, scoreAnswer, type SceneFile } from './score.js';
import { candidatesOf5, latest } from './views5.js';
import { readRows10, scenes10, VIEWS10, type S2Meta } from './sonnet10.js';
import type { Row2 } from './run2.js';

/**
 * 10/26: Sonnet の比べの表。
 *   node --import tsx tests/decisionReplay/report10.ts [--judge=judge10.jsonl] [--out=sonnet-tables.md] [--only=s52,s42]
 * 場面 = O・S・N のそろった場面（S×2 は S の組から）。採点 = 決まった検査 + 後知恵つき Opus（judge10.ts）。差の幅は場面で引き直した 95%。
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const ids = ['O', 'S', 'N', 'S2'];
const all = latest(readRows10()) as Array<Row2 & { s2?: S2Meta; blockTypes?: string[]; thinkChars?: number; sent?: any }>;
const hasAll = (scene: string) => ['O', 'S', 'N'].every(id => all.some(row => row.variant === id && row.scene === scene));
const only = flag('only', '').split(',').filter(Boolean);
const scenes = scenes10(all).filter(scene => hasAll(scene.id) && (!only.length || only.includes(scene.id.split('-')[0]!)));
const sceneSet = new Set(scenes.map(scene => scene.id));
const rows = all.filter(row => sceneSet.has(row.scene));
const runs = loadAllRuns();
const judged = loadJudged(dataFile(flag('judge', 'judge10.jsonl')));
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const f = (value: number, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '-';

type Final = { verdict: '○' | '△' | '×' | '?'; by: 'check' | 'judge' | 'pending'; reason: string };
interface Entry { scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; failed: string[]; answer: Candidate['answer'] }
function finalOf(scene: SceneFile, item: Candidate): Final {
  if (item.score.verdict === '×') return { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
  if (item.score.verdict === '○' && scene.judge !== 'always') return { verdict: '○', by: 'check', reason: '検査' };
  const judge = judged.get(`${scene.id}|${item.key}`);
  if (judge) return { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason };
  return { verdict: item.score.verdict === '○' ? '○' : '?', by: item.score.verdict === '○' ? 'check' : 'pending', reason: '' };
}
const table: Entry[] = [];
for (const scene of scenes) {
  const decision = decisionOf(runs, scene);
  for (const item of await candidatesOf5(scene, decision, rows, VIEWS10)) table.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final: finalOf(scene, item), failed: item.score.failed, answer: item.answer });
}
writeFileSync(dataFile('sonnet-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, key: item.key, variant: item.variant, rep: item.rep, verdict: item.final.verdict, by: item.final.by, reason: item.final.reason, failed: item.failed }))));
const count = (list: Entry[], verdict: string) => list.filter(item => item.final.verdict === verdict).length;
const out: string[] = [];

// ---- 1. 正しさ
const sceneMean = (id: string, scene: string): number => {
  const mine = table.filter(item => item.scene.id === scene && item.variant === id && item.final.verdict !== '?');
  return mine.length ? mean(mine.map(item => points[item.final.verdict]!)) : NaN;
};
function bootstrap(id: string): { diff: number; low: number; high: number; n: number } {
  const pairs = scenes.map(scene => [sceneMean(id, scene.id), sceneMean('O', scene.id)] as const).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const diffs = pairs.map(([a, b]) => a - b);
  let state = 12345;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const samples: number[] = [];
  for (let b = 0; b < 10000; b += 1) { let sum = 0; for (let i = 0; i < diffs.length; i += 1) sum += diffs[Math.floor(next() * diffs.length)]!; samples.push(sum / diffs.length); }
  samples.sort((x, y) => x - y);
  return { diff: mean(diffs), low: samples[Math.floor(0.025 * samples.length)]!, high: samples[Math.floor(0.975 * samples.length)]!, n: diffs.length };
}
out.push(`## 1. 正しさ（${scenes.length} 場面。○=1 △=0.5 ×=0。未採点 ? は平均に入れない。差 = 場面ごとの平均の差の平均、幅 = 場面を引き直した 95%）\n`,
  '| 版 | 答えの数 | ○ | △ | × | 未採点 | 平均点（答えごと） | 平均点（場面ごと） | O との差 | 95% の幅 | 0 をまたぐか |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
for (const id of ['prod', ...ids]) {
  const list = table.filter(item => item.variant === id);
  if (!list.length) continue;
  const decided = list.filter(item => item.final.verdict !== '?');
  const perScene = scenes.map(scene => sceneMean(id, scene.id)).filter(Number.isFinite);
  const b = id === 'O' || id === 'prod' ? null : bootstrap(id);
  out.push(`| ${id === 'prod' ? '本番の記録（n=1）' : id} | ${list.length} | ${count(list, '○')} | ${count(list, '△')} | ${count(list, '×')} | ${count(list, '?')} | ${f(mean(decided.map(item => points[item.final.verdict]!)), 2)} | ${f(mean(perScene), 2)} | ${b ? `${b.diff >= 0 ? '+' : ''}${f(b.diff, 3)}` : '-'} | ${b ? `${f(b.low, 3)}〜${f(b.high, 3)}` : '-'} | ${b ? (b.low <= 0 && b.high >= 0 ? 'またぐ' : 'またがない') : '-'} |`);
}

// ---- 2. 種類ごと
out.push('\n## 2. 種類ごとの平均点（場面ごとの平均の平均）と場面の数\n');
const categories = ['progress', 'stopped', 'urgent', 'death', 'plan'];
out.push(`| 版 | ${categories.map(category => `${category}（${scenes.filter(scene => scene.category.includes(category)).length}）`).join(' | ')} |`, `|---|${categories.map(() => '---:').join('|')}|`);
for (const id of ids) out.push(`| ${id} | ${categories.map(category => f(mean(scenes.filter(scene => scene.category.includes(category)).map(scene => sceneMean(id, scene.id)).filter(Number.isFinite)), 2)).join(' | ')} |`);

// ---- 3. ×の中身
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
const cols = ['prod', ...ids];
out.push(`| ×の種類 | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---:').join('|')}|`);
for (const [kind, per] of [...kinds].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) out.push(`| ${kind} | ${cols.map(id => per.get(id) ?? 0).join(' | ')} |`);
out.push(`| （答えの数） | ${cols.map(id => table.filter(item => item.variant === id).length).join(' | ')} |`);

// ---- 4. 守り
out.push('\n## 4. 送る前の守りが止めた数（1 回目の答え。全部止め・一部止め・送れない形）\n');
out.push('| 版 | 答え | 守りが止めた | うち全部止め | うち一部止め | 送れない形（守りの前） | 止められなかった割合 |', '|---|---:|---:|---:|---:|---:|---:|');
for (const id of ['O', 'S', 'N']) {
  const list = rows.filter(row => row.variant === id);
  const guarded = list.filter(row => row.sent?.guard), all_ = guarded.filter(row => row.sent.guard.stopped), problem = list.filter(row => !row.sent?.guard && row.sent?.problem);
  out.push(`| ${id} | ${list.length} | ${guarded.length} | ${all_.length} | ${guarded.length - all_.length} | ${problem.length} | ${f(100 * (1 - (guarded.length + problem.length) / list.length), 0)}% |`);
}
{
  const list = rows.filter(row => row.variant === 'S2' && row.s2);
  const both = list.filter(row => row.s2!.bothPassed).length, held = list.filter(row => row.s2!.bothHeld).length;
  out.push(`| S2（組の数） | ${list.length} | 両方止められた ${held} | 両方通った ${both} | 片方だけ通った ${list.length - both - held} | - | ${f(100 * (1 - held / list.length), 0)}%（使えた組） |`);
}

// ---- 5. 時間・出力・費用
out.push('\n## 5. 時間・出力・費用（1 判断。自分の PC からストリームで測る。3 つの版を並べて走らせた。キャッシュは 5 分）\n');
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
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const modelOf = (id: string) => id === 'O' ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
/** 本番想定の 1 回の呼び出し: 履歴は毎判断キャッシュから読み、尾 800 トークンだけ 1 時間書き込みで書く。 */
const assumedOne = (model: string, u: Usage) => costOf(model, { input: u.input, output: u.output, cacheWrite: 800, cacheRead: Math.max(0, u.cacheRead + u.cacheWrite - 800), cacheWrite1h: 800, cacheWrite5m: 0 });
function assumedRow(row: Row2 & { s2?: S2Meta }, model: string): number {
  if (row.s2) {
    const [a, b] = row.s2.firstUsages as [Usage, Usage];
    return assumedOne(model, a) + assumedOne(model, b) + (row.s2.reaskUsage ? assumedOne(model, row.s2.reaskUsage as Usage) : 0);
  }
  const f1 = row.firstUsage;
  if (!f1 || row.usage.output === f1.output) return assumedOne(model, row.usage);
  return assumedOne(model, f1) + assumedOne(model, { input: row.usage.input - f1.input, output: row.usage.output - f1.output, cacheWrite: row.usage.cacheWrite - f1.cacheWrite, cacheRead: row.usage.cacheRead - f1.cacheRead });
}
out.push('| 版 | 判断 | 最初のブロックまで p50 / p95 (s) | 全体 p50 / p95 (s) | 出力 平均（トークン） | うち答え | 考え・前置き（残り） | 考えのブロックがあった割合 | 費用 平均（この台の実額） | 本番想定 1 判断 |', '|---|---:|---|---|---:|---:|---:|---:|---:|---:|');
for (const id of ids) {
  const list = rows.filter(row => row.variant === id) as Array<Row2 & { s2?: S2Meta; blockTypes?: string[] }>;
  const first = list.map(row => (row.s2 ? row.s2.tFirstBlock : row.tFirstBlock ?? 0) / 1000);
  const total = list.map(row => (row.s2 ? row.s2.tUsed : row.tEnd) / 1000);
  const acts = list.filter(row => row.answer.tool === 'mc.act');
  const answerTokens = (await Promise.all(acts.map(row => tokensOf((row as { rawFinal?: unknown }).rawFinal ?? (row as { rawFirst?: unknown }).rawFirst ?? row.answer.input)))).filter((v): v is number => v !== null);
  const outputs = list.map(row => row.s2 ? (row.s2.firstUsages as Usage[]).reduce((sum, u) => sum + u.output, 0) : row.usage.output);
  const thinkRate = list.filter(row => row.blockTypes?.includes('thinking')).length / (list.filter(row => row.blockTypes).length || 1);
  const real = list.map(row => row.s2 ? row.s2.costActual : row.costUsd);
  out.push(`| ${id} | ${list.length} | ${f(quantile(first, 0.5))} / ${f(quantile(first, 0.95))} | ${f(quantile(total, 0.5))} / ${f(quantile(total, 0.95))} | ${f(mean(outputs), 0)}${id === 'S2' ? '（2 つ分）' : ''} | ${f(mean(answerTokens), 0)} | ${f(mean(outputs) - mean(answerTokens) * (id === 'S2' ? 2 : 1), 0)} | ${f(100 * thinkRate, 0)}% | ${f(mean(real), 4)} | ${f(mean(list.map(row => assumedRow(row, modelOf(id)))), 4)} |`);
}
if (client) writeFileSync(tokenFile, JSON.stringify(tokenCache));

// ---- 6. 場面ごと
out.push('\n## 6. 場面ごとの平均点（O・S・N・S×2）と、Sonnet が O より低かった場面\n');
out.push('| 場面 | 種類 | O | S | N | S×2 | S−O | N−O | S×2−O |', '|---|---|---:|---:|---:|---:|---:|---:|---:|');
const worse: string[] = [];
for (const scene of scenes) {
  const [o, s, n, s2] = ids.map(id => sceneMean(id, scene.id)) as [number, number, number, number];
  const d = (a: number) => Number.isFinite(a) && Number.isFinite(o) ? `${a - o >= 0 ? '+' : ''}${(a - o).toFixed(2)}` : '-';
  out.push(`| ${scene.id.split('-')[0]} ${scene.title.slice(0, 22)} | ${scene.category.join('+')} | ${f(o, 2)} | ${f(s, 2)} | ${f(n, 2)} | ${f(s2, 2)} | ${d(s)} | ${d(n)} | ${d(s2)} |`);
  if (s < o - 0.001 || n < o - 0.001) worse.push(scene.id.split('-')[0]!);
}
out.push(`\nSonnet（S か N）が O より低かった場面: ${worse.join(' ')}（${worse.length}）`);
writeFileSync(dataFile(flag('out', 'sonnet-tables.md')), out.join('\n'));
console.log(out.join('\n'));
