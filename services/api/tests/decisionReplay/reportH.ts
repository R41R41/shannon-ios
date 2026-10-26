import { writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { contextOf } from './checks.js';
import { loadJudged, type Candidate } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, type SceneFile } from './score.js';
import { candidatesOf5, latest } from './views5.js';
import { isNew, readRowsH, scenesH, short, themeOf, VIEWS_H } from './sonnetH.js';
import { actExpectedMilliseconds } from '../../src/contracts/minecraftActTime.js';
import type { Row2 } from './run2.js';

/**
 * 10/27 mc-run39-fixes の表。 node --import tsx tests/decisionReplay/reportH.ts [--judge=judgeH.jsonl] [--out=th-tables.md]
 * 1. 正しさ（P と H の対、本番の記録は参考） 2. 場面ごと 3. 新しい手の使い方 4. 1 判断あたりで体を動かす見込みの秒 5. 守り・形 6. 時間・費用。
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const all = latest(readRowsH()) as Array<Row2 & { sent?: any; rawFirst?: unknown; rawFinal?: unknown; requestChars?: number }>;
const scenes = scenesH(all);
const both = scenes.filter(scene => ['P', 'H'].every(id => all.some(row => row.scene === scene.id && row.variant === id)));
const ids = new Set(both.map(scene => scene.id));
const rows = all.filter(row => ids.has(row.scene));
const runs = loadAllRuns();
const judged = loadJudged(dataFile(flag('judge', 'judgeH.jsonl')));
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
const feet = new Map<string, any>();
for (const scene of both) {
  const decision = decisionOf(runs, scene);
  feet.set(scene.id, contextOf(decision).self);
  for (const item of await candidatesOf5(scene, decision, rows, VIEWS_H)) table.push({ scene, variant: item.variant, rep: item.rep, final: finalOf(scene, item), failed: item.score.failed });
}
writeFileSync(dataFile('th-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, variant: item.variant, rep: item.rep, verdict: item.final.verdict, by: item.final.by, reason: item.final.reason, failed: item.failed }))));
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
const old = both.filter(s => !isNew(s.id)), fresh = both.filter(s => isNew(s.id));
const groups: Array<[string, SceneFile[]]> = [[`全 ${both.length} 場面`, both], [`dragon26 の ${old.length} 場面`, old], [`実走 39 の ${fresh.length} 場面`, fresh],
  ...['move', 'obsidian', 'table', 'descend', 'pillar'].map(theme => [`実走 39: ${({ move: '移動の止まり', obsidian: '黒曜石づくり', table: '作業台が無い', descend: '準備を飛ばして地下へ', pillar: '柱で上がる' } as any)[theme]}`, fresh.filter(s => themeOf(s.id) === theme)] as [string, SceneFile[]]),
  ['dragon26: 成功の後', old.filter(s => /steady/u.test(s.id))], ['dragon26: 止まりの後', old.filter(s => /after-stop/u.test(s.id))], ['dragon26: 急ぎ', old.filter(s => /urgent/u.test(s.id))]];
const out: string[] = [];
out.push('## 1. 正しさ（場面ごとの平均の平均。○=1 △=0.5 ×=0。差の幅は場面を引き直した 95%）\n');
out.push('| 場面の集合 | 場面 | 本番の記録（参考） | 基準 P | 候補 H | H−P | 95% の幅 | 0 をまたぐか |', '|---|---:|---:|---:|---:|---:|---|---|');
for (const [name, list] of groups) {
  if (!list.length) continue;
  const b = boot('H', 'P', list);
  out.push(`| ${name} | ${list.length} | ${f(mean(list.map(s => sceneMean('prod', s.id)).filter(Number.isFinite)))} | ${f(mean(list.map(s => sceneMean('P', s.id)).filter(Number.isFinite)))} | ${f(mean(list.map(s => sceneMean('H', s.id)).filter(Number.isFinite)))} | ${signed(b.diff, 3)} | ${f(b.low, 3)}〜${f(b.high, 3)} | ${b.low <= 0 && b.high >= 0 ? 'またぐ' : 'またがない'} |`);
}
out.push('\n答えごと:\n', '| 版 | 答え | ○ | △ | × | 未採点 | 平均 |', '|---|---:|---:|---:|---:|---:|---:|');
for (const id of ['prod', 'P', 'H']) {
  const list = table.filter(item => item.variant === id), decided = list.filter(item => item.final.verdict !== '?');
  out.push(`| ${id === 'prod' ? '本番の記録' : id} | ${list.length} | ${list.filter(i => i.final.verdict === '○').length} | ${list.filter(i => i.final.verdict === '△').length} | ${list.filter(i => i.final.verdict === '×').length} | ${list.filter(i => i.final.verdict === '?').length} | ${f(mean(decided.map(i => points[i.final.verdict]!)))} |`);
}
out.push('\n## 2. 場面ごと\n', '| 場面 | 種類 | 本番の記録 | P | H | H−P |', '|---|---|---:|---:|---:|---:|');
for (const scene of both) {
  const [p, b, q] = [sceneMean('prod', scene.id), sceneMean('P', scene.id), sceneMean('H', scene.id)];
  out.push(`| ${short(scene.id)} ${scene.title.slice(0, 24)}${isNew(scene.id) ? `（実走39: ${themeOf(scene.id)}）` : ''} | ${scene.category.join('+')} | ${f(p)} | ${f(b)} | ${f(q)} | ${signed(q - b)} |`);
}

// ---- 3. 新しい手の使い方（H）
const NEW_HANDS = ['go', 'obsidian', 'fight', 'mine', 'make', 'portal', 'smelt'];
const hRows = rows.filter(row => row.variant === 'H') as any[], pRows = rows.filter(row => row.variant === 'P') as any[];
const isAct = (row: any) => (row.sent?.guard ? 'mc.act' : row.answer?.tool) === 'mc.act' || row.sent?.tool === 'mc.act';
const hActs = hRows.filter(isAct), pActs = pRows.filter(isAct);
/** モデルの 1 回目の答えの手の行（短い書き方）から、手の種類。 */
const firstLines = (row: any): string[] => Array.isArray(row.rawFirst?.hands) ? row.rawFirst.hands.map((h: unknown) => String(typeof h === 'string' ? h : JSON.stringify(h))) : [];
const kindOfLine = (line: string): string => /^json /u.test(line) ? (/"do":"(\w+)"/u.exec(line)?.[1] ?? 'json') : line.split(/\s+/u)[0]!;
const usesKind = (row: any, kind: string): boolean => firstLines(row).some(line => kindOfLine(line) === kind);
const problemOf = (row: any): string | null => typeof row.sent?.problem === 'string' ? row.sent.problem : null;
out.push('\n## 3. 新しい手の使い方（H の 1 回目の答え = モデルの書いた物）\n');
out.push('| 手 | 使った答え | mc.act の答えに対する割合 | 引数の誤りで断られた | 守りが止めた（送る前） | 採点（○/△/×） |', '|---|---:|---:|---:|---:|---|');
const verdictOf = (row: any) => table.find(item => item.scene.id === row.scene && item.variant === 'H' && item.rep === row.rep)?.final.verdict ?? '-';
for (const kind of NEW_HANDS) {
  const used = hActs.filter(row => usesKind(row, kind));
  const bad = used.filter(row => problemOf(row)), held = used.filter(row => row.sent?.guard);
  const v = (x: string) => used.filter(row => verdictOf(row) === x).length;
  out.push(`| ${kind} | ${used.length} | ${f(100 * used.length / Math.max(1, hActs.length), 0)}% | ${bad.length} | ${held.length} | ${v('○')}/${v('△')}/${v('×')} |`);
}
const anyNew = hActs.filter(row => NEW_HANDS.some(kind => usesKind(row, kind)));
out.push(`\nmc.act の答え ${hActs.length}（全 ${hRows.length} 答え）。新しい手を 1 つでも使った答え ${anyNew.length}（${f(100 * anyNew.length / Math.max(1, hActs.length), 0)}%）、うち引数の誤りで断られた ${anyNew.filter(row => problemOf(row)).length}。`
  + ` 実走 39 の場面だけ: ${hActs.filter(row => isNew(row.scene) && NEW_HANDS.some(kind => usesKind(row, kind))).length}/${hActs.filter(row => isNew(row.scene)).length}、dragon26 の場面: ${hActs.filter(row => !isNew(row.scene) && NEW_HANDS.some(kind => usesKind(row, kind))).length}/${hActs.filter(row => !isNew(row.scene)).length}。`);
out.push('\n新しい手を使った答え（H。モデルの書いた手の行、断られた理由、採点つき）:\n', '| 場面 | 回 | 新しい手の行 | 断られた理由 | 守り | 採点 |', '|---|---:|---|---|---|---|');
for (const row of anyNew) {
  const lines = firstLines(row).filter(line => NEW_HANDS.includes(kindOfLine(line))).map(line => line.slice(0, 110)).join(' ; ');
  out.push(`| ${short(row.scene)}${isNew(row.scene) ? `（${themeOf(row.scene)}）` : ''} | ${row.rep} | ${lines} | ${(problemOf(row) ?? '-').slice(0, 90)} | ${row.sent?.guard ? String(row.sent.guard.text).replace(/^.*?手 \d+ /u, '').slice(0, 70) : '-'} | ${verdictOf(row)} |`);
}
// 引数の統計（go）
const goHands: any[] = [];
for (const row of hActs) for (const hand of (row.sent?.input?.hands ?? row.answer?.input?.hands ?? []) as any[]) if (hand?.do === 'go') goHands.push(hand);
const share = (key: string) => goHands.filter(hand => hand[key] !== undefined && !(Array.isArray(hand[key]) && !hand[key].length)).length;
out.push(`\n**go の引数**（送った go の手 ${goHands.length} 個）: canDig を付けた ${share('canDig')}・canPlace ${share('canPlace')}・seconds ${share('seconds')}・maxDig ${share('maxDig')}・maxDrop ${share('maxDrop')}・goals（候補 2〜8）${share('goals')}・range ${share('range')}・rel ${goHands.filter(hand => hand.rel).length}。`
  + ` seconds の値: ${goHands.filter(hand => typeof hand.seconds === 'number').map(hand => hand.seconds).join('、') || '-'}。canDig の中身: ${[...new Set(goHands.flatMap(hand => hand.canDig ?? []))].join('・') || '-'}。canPlace の中身: ${[...new Set(goHands.flatMap(hand => hand.canPlace ?? []))].join('・') || '-'}。`);
const refused = hRows.filter(row => problemOf(row));
out.push(`\n体に送れない形（頭の検査が断った 1 回目の答え）: H ${refused.length}、P ${pRows.filter(row => problemOf(row)).length}。${refused.map(row => `${short(row.scene)}: ${String(problemOf(row)).slice(0, 90)}`).join(' / ') || ''}`);

// ---- 4. 1 判断あたりで体を動かす見込みの秒
out.push('\n## 4. 1 判断あたりで体を動かす見込みの秒（送る手の見積もり: 頭の `actExpectedMilliseconds`。repeat は最大まで数える。基準も候補も同じ式）\n');
const secondsOf = (row: any): number => { try { return actExpectedMilliseconds(row.sent.input, feet.get(row.scene)) / 1000; } catch { return NaN; } };
const handsN = (row: any): number => ((row.sent?.input?.hands ?? []) as unknown[]).length;
out.push('| 版 | mc.act の答え | 見込みの秒 平均 | 中央 | p90 | 手の数 平均 | 5 秒未満の答え |', '|---|---:|---:|---:|---:|---:|---:|');
for (const [id, list] of [['P', pActs], ['H', hActs]] as const) {
  const s = list.map(secondsOf).filter(Number.isFinite);
  out.push(`| ${id} | ${list.length} | ${f(mean(s), 1)} | ${f(quantile(s, 0.5), 1)} | ${f(quantile(s, 0.9), 1)} | ${f(mean(list.map(handsN)), 1)} | ${s.filter(x => x < 5).length} |`);
}
for (const [name, pick] of [['dragon26 の 30', (r: any) => !isNew(r.scene)], ['実走 39 の 10', (r: any) => isNew(r.scene)]] as const) {
  const sp = pActs.filter(pick).map(secondsOf).filter(Number.isFinite), sh = hActs.filter(pick).map(secondsOf).filter(Number.isFinite);
  out.push(`\n${name}: P 平均 ${f(mean(sp), 1)} 秒（${sp.length}）、H 平均 ${f(mean(sh), 1)} 秒（${sh.length}）。`);
}
const sec5 = hActs.filter(row => secondsOf(row) < 5).length / Math.max(1, hActs.length), secP = pActs.filter(row => secondsOf(row) < 5).length / Math.max(1, pActs.length);
out.push(`\n実走 39 の報告では、act の長さは中央 3.4 秒（5 秒未満が 121/192）で、頭を呼ぶ T（中央 4.4 秒）より短い act が多かった。この表の 5 秒未満の割合: P ${f(100 * secP, 0)}%、H ${f(100 * sec5, 0)}%。`);

// ---- 5. 守り
out.push('\n## 5. 送る前の守りが止めた数（1 回目の答え）\n', '| 版 | 答え | 止めた | 全部止め | 一部止め | 割合 |', '|---|---:|---:|---:|---:|---:|');
for (const [id, list] of [['P', pRows], ['H', hRows]] as const) {
  const held = list.filter(row => row.sent?.guard), whole = held.filter(row => row.sent.guard.stopped);
  out.push(`| ${id} | ${list.length} | ${held.length} | ${whole.length} | ${held.length - whole.length} | ${f(100 * held.length / Math.max(1, list.length), 0)}% |`);
}
const kindText = (row: any) => { const m = /手 \d+ (\w+) ([^:]+):/u.exec(String(row.sent?.guard?.text ?? '')); return m ? `${m[1]} ${m[2]}` : '他'; };
const kinds = new Map<string, Record<string, number>>();
for (const [id, list] of [['P', pRows], ['H', hRows]] as const) for (const row of list.filter(r => r.sent?.guard)) { const k = kindText(row), o = kinds.get(k) ?? {}; kinds.set(k, { ...o, [id]: (o[id] ?? 0) + 1 }); }
out.push('\n止めた手: ' + [...kinds].map(([k, v]) => `${k} P${v.P ?? 0}/H${v.H ?? 0}`).join('・'));

// ---- 6. 時間・費用
out.push('\n## 6. 時間・費用（1 判断。聞き直しを含む）\n');
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const assumedOne = (u: Usage) => costOf('claude-sonnet-5-5', { input: u.input, output: u.output, cacheWrite: 800, cacheRead: Math.max(0, u.cacheRead + u.cacheWrite - 800), cacheWrite1h: 800, cacheWrite5m: 0 });
function assumed(row: any, firstOnly = false): number {
  const f1 = row.firstUsage;
  if (!f1 || row.usage.output === f1.output) return assumedOne(row.usage);
  if (firstOnly) return assumedOne(f1);
  return assumedOne(f1) + assumedOne({ input: row.usage.input - f1.input, output: row.usage.output - f1.output, cacheWrite: row.usage.cacheWrite - f1.cacheWrite, cacheRead: row.usage.cacheRead - f1.cacheRead });
}
out.push('| 版 | 判断 | 最初のブロックまで p50 | 全体 p50 / p95 (s) | 出力 平均 tok | 費用 平均（この台の実額） | 本番想定 1 判断 | 1 回目の呼び出しだけ | 要求の文字数 |', '|---|---:|---:|---|---:|---:|---:|---:|---:|');
for (const [id, list] of [['P', pRows], ['H', hRows]] as const) {
  const t = list.map(r => r.tEnd / 1000), first = list.map(r => (r.tFirstBlock ?? 0) / 1000);
  out.push(`| ${id} | ${list.length} | ${f(quantile(first, 0.5), 1)} | ${f(quantile(t, 0.5), 1)} / ${f(quantile(t, 0.95), 1)} | ${f(mean(list.map(r => r.usage.output)), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(mean(list.map(r => assumed(r))), 4)} | ${f(mean(list.map(r => assumed(r, true))), 4)} | ${f(mean(list.map(r => r.requestChars ?? NaN)), 0)} |`);
}
out.push(`\n本番想定の 1 判断の費用は H が P より ${signed(100 * (mean(hRows.map(r => assumed(r))) / mean(pRows.map(r => assumed(r))) - 1), 1)}%、1 回目の呼び出しだけなら ${signed(100 * (mean(hRows.map(r => assumed(r, true))) / mean(pRows.map(r => assumed(r, true))) - 1), 1)}%。`);
writeFileSync(dataFile(flag('out', 'th-tables.md')), out.join('\n'));
console.log(out.join('\n'));
