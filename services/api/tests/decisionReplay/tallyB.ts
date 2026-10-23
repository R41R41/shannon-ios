import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';

/**
 * B の直しの比べの集計: results-b.jsonl（新しい場面）と、採点の 2 回（judge-b2.jsonl・judge-b3.jsonl）から、場面ごとの ○△× と全体の数を出す。
 *   node --import tsx tests/decisionReplay/tallyB.ts [out.md]
 */
interface Row { variant: string; scene: string; rep: number; tEnd: number; costUsd: number; usage: { output: number; input: number; cacheRead: number; cacheWrite: number }; sent: { guard?: { stopped: boolean; reask?: string }; problem: string | null; tool: string | null } }
interface Judge { scene: string; key: string; verdict: string; reason: string }
const readJsonl = <T>(name: string): T[] => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T) : [];
const rows = new Map<string, Row>();
for (const row of readJsonl<Row & { ok: boolean }>('results-b.jsonl')) if (row.ok) rows.set(`${row.variant}|${row.scene}|${row.rep}`, row);
const judges = ['judge-b2.jsonl', 'judge-b3.jsonl'].map(name => { const map = new Map<string, Judge>(); for (const row of readJsonl<Judge>(name)) map.set(`${row.scene}|${row.key}`, row); return map; });
const scenes = [...new Set([...rows.values()].map(row => row.scene))].sort();
const verdictOf = (pass: number, scene: string, variant: string, rep: number): string => {
  const row = rows.get(`${variant}|${scene}|${rep}`)!;
  // 検査の × は採点に出ない（judge の対象外）: 体に送れない形などは ×。
  const j = judges[pass]!.get(`${scene}|${variant}|${rep}`);
  if (j) return j.verdict;
  return row.sent.problem ? '×' : '？';
};
const out: string[] = ['| 場面 | 版 | 採点 1 回目 | 採点 2 回目 | ○（1 回目 / 2 回目） | × |', '|---|---|---|---|---|---|'];
const total: Record<string, { n: number; ok: number[]; half: number[]; bad: number[]; seconds: number[]; cost: number[]; output: number[]; fresh: number[] }> = {};
for (const scene of scenes) for (const variant of ['candB', 'candF']) {
  const reps = [...rows.values()].filter(row => row.scene === scene && row.variant === variant).map(row => row.rep).sort((a, b) => a - b);
  const strings = [0, 1].map(pass => reps.map(rep => verdictOf(pass, scene, variant, rep)).join(''));
  const count = (text: string, char: string) => [...text].filter(c => c === char).length;
  out.push(`| ${scene.split('-').slice(0, 3).join('-')} | ${variant === 'candB' ? '基準' : '修正'} | ${strings[0]} | ${strings[1]} | ${count(strings[0]!, '○')} / ${count(strings[1]!, '○')} / ${reps.length} | ${count(strings[0]!, '×')} / ${count(strings[1]!, '×')} |`);
  const t = (total[variant] ??= { n: 0, ok: [0, 0], half: [0, 0], bad: [0, 0], seconds: [], cost: [], output: [], fresh: [] });
  for (const pass of [0, 1]) { t.ok[pass]! += count(strings[pass]!, '○'); t.half[pass]! += count(strings[pass]!, '△'); t.bad[pass]! += count(strings[pass]!, '×'); }
  for (const rep of reps) { const row = rows.get(`${variant}|${scene}|${rep}`)!; t.n += 1; t.seconds.push(row.tEnd / 1000); t.cost.push(row.costUsd); t.output.push(row.usage.output); t.fresh.push(row.usage.input + row.usage.cacheWrite); }
}
const median = (list: number[]) => { const s = [...list].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : 0; };
const p95 = (list: number[]) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * 0.95))] ?? 0;
const sum = ['', '| 版 | 答え数 | ○ 1 回目 / 2 回目 | △ | × | 平均点（1 回目 / 2 回目） | 中央値の秒 | p95 の秒 | 平均の出力 tok | 費用（呼び出し合計） |', '|---|---:|---|---|---|---|---:|---:|---:|---:|'];
for (const variant of ['candB', 'candF']) {
  const t = total[variant]!;
  const score = (pass: number) => ((t.ok[pass]! + 0.5 * t.half[pass]!) / t.n).toFixed(2);
  sum.push(`| ${variant === 'candB' ? '基準 73244fc' : '修正 8607283'} | ${t.n} | ${t.ok[0]} / ${t.ok[1]} | ${t.half[0]} / ${t.half[1]} | ${t.bad[0]} / ${t.bad[1]} | ${score(0)} / ${score(1)} | ${median(t.seconds).toFixed(1)} | ${p95(t.seconds).toFixed(1)} | ${(t.output.reduce((a, b) => a + b, 0) / t.n).toFixed(0)} | $${t.cost.reduce((a, b) => a + b, 0).toFixed(3)} |`);
}
let same = 0, bothKnown = 0, xSame = 0;
for (const [key] of judges[0]!) { const a = judges[0]!.get(key), b = judges[1]!.get(key); if (!a || !b || key.includes('|prod')) continue; bothKnown += 1; if (a.verdict === b.verdict) same += 1; if ((a.verdict === '×') === (b.verdict === '×')) xSame += 1; }
sum.push('', `採点 2 回の一致（本番の記録を除く ${bothKnown} 答え）: ○△× が同じ ${same}（${(same / bothKnown * 100).toFixed(0)}%）、× かどうかが同じ ${xSame}（${(xSame / bothKnown * 100).toFixed(0)}%）。`);
const guards = [...rows.values()].filter(row => row.sent.guard);
sum.push(`守りが止めて聞き直した答え: 基準 ${guards.filter(row => row.variant === 'candB').length}、修正 ${guards.filter(row => row.variant === 'candF').length}`);
writeFileSync(dataFile(process.argv[2] ?? 'b-tally.md'), [...out, ...sum].join('\n'));
console.log([...out, ...sum].join('\n'));
