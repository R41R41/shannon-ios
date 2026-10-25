import { writeFileSync } from 'node:fs';
import { loadAllRuns, dataFile } from './allRuns.js';
import { candFrame, candidateAct } from './candidateAdapter.js';
import { loadJudged, type Candidate } from './judge.js';
import { costOf } from './ledger.js';
import { decisionOf, type SceneFile } from './score.js';
import { frames } from './sceneSet.js';
import { candidatesOf5, latest } from './views5.js';
import { EXTRA, readRows26, scenes26, short, VIEWS26 } from './sonnet26.js';
import { isUrgentLive } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { heldOfFrame } from '../../src/surfaces/minecraft/minecraftLlmcPartial.js';
import type { Row2 } from './run2.js';

/**
 * 10/26 mc-sonnet-guards の表。 node --import tsx tests/decisionReplay/report26.ts [--judge=judge26.jsonl] [--out=g26-tables.md]
 * 採点 = 決まった検査 + 後知恵つき Opus（judge26.ts）。差の幅は場面で引き直した 95%。
 */
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const all = latest(readRows26()) as Array<Row2 & { sent?: any; rawFirst?: unknown; rawFinal?: unknown }>;
const scenes = scenes26(all);
const sceneIds = new Set(scenes.map(scene => scene.id));
const rows = all.filter(row => sceneIds.has(row.scene));
const runs = loadAllRuns();
const judged = loadJudged(dataFile(flag('judge', 'judge26.jsonl')));
const points: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const quantile = (values: number[], q: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!; };
const f = (value: number, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '-';
const signed = (value: number, digits = 2) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}` : '-';

type Final = { verdict: '○' | '△' | '×' | '?'; by: string; reason: string };
interface Entry { scene: SceneFile; key: string; variant: string; rep: number | 'prod'; final: Final; failed: string[]; adjusted: '○' | '△' | '×' | '?'; ownCell: boolean }
function finalOf(scene: SceneFile, item: Candidate): Final {
  if (item.score.verdict === '×') return { verdict: '×', by: 'check', reason: item.score.failed.join(' / ') };
  if (item.score.verdict === '○' && scene.judge !== 'always') return { verdict: '○', by: 'check', reason: '検査' };
  const judge = judged.get(`${scene.id}|${item.key}`);
  if (judge) return { verdict: judge.verdict as Final['verdict'], by: 'judge', reason: judge.reason };
  return { verdict: item.score.verdict === '○' ? '○' : '?', by: item.score.verdict === '○' ? 'check' : 'pending', reason: '' };
}
// 最終の答えに、足・頭のマスへの place（onFail continue でない）が残っているか: 今の守りの判定そのまま（heldOfFrame の code が own_cell）。
function hasOwnCell(sent: any, frame: any, urgent: boolean, taskId: string): boolean {
  if (!sent || sent.tool !== 'mc.act' || !sent.input) return false;
  const held = heldOfFrame(sent.input, frame, taskId, urgent);
  return held?.code === 'own_cell';
}
const table: Entry[] = [];
for (const scene of scenes) {
  const decision = decisionOf(runs, scene);
  const frame = candFrame(decision, frames(runs, decision.run.key));
  const urgent = isUrgentLive(decision.live);
  for (const item of await candidatesOf5(scene, decision, rows, VIEWS26)) {
    const final = finalOf(scene, item);
    const row = item.variant === 'prod' ? null : rows.find(r => r.scene === scene.id && r.variant === item.variant && r.rep === item.rep) as any;
    const own = row ? hasOwnCell(row.sent, frame, urgent, `own-${scene.id}-${item.rep}`) : false;
    table.push({ scene, key: item.key, variant: item.variant, rep: item.rep, final, failed: item.score.failed, ownCell: own, adjusted: own ? '×' : final.verdict });
  }
}
writeFileSync(dataFile('g26-entries.json'), JSON.stringify(table.map(item => ({ scene: item.scene.id, variant: item.variant, rep: item.rep, verdict: item.final.verdict, adjusted: item.adjusted, by: item.final.by, reason: item.final.reason, failed: item.failed, ownCell: item.ownCell }))));

const ids = ['O', 'S', 'B2', 'C'];
const original = scenes.filter(scene => !EXTRA.includes(short(scene.id)));
const extras = scenes.filter(scene => EXTRA.includes(short(scene.id)));
const sceneMean = (variant: string, scene: string, adjusted = false): number => {
  const mine = table.filter(item => item.scene.id === scene && item.variant === variant && item.final.verdict !== '?');
  return mine.length ? mean(mine.map(item => points[adjusted ? item.adjusted : item.final.verdict]!)) : NaN;
};
function boot(a: string, b: string, list: SceneFile[], adjusted = false) {
  const diffs = list.map(scene => sceneMean(a, scene.id, adjusted) - sceneMean(b, scene.id, adjusted)).filter(Number.isFinite);
  let state = 12345;
  const next = () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const samples: number[] = [];
  for (let k = 0; k < 10000; k += 1) { let sum = 0; for (let i = 0; i < diffs.length; i += 1) sum += diffs[Math.floor(next() * diffs.length)]!; samples.push(sum / Math.max(1, diffs.length)); }
  samples.sort((x, y) => x - y);
  return { diff: mean(diffs), low: samples[Math.floor(0.025 * samples.length)]!, high: samples[Math.floor(0.975 * samples.length)]!, n: diffs.length };
}
const out: string[] = [];
const have = (variant: string, list: SceneFile[]) => list.filter(scene => Number.isFinite(sceneMean(variant, scene.id)));
const scenesMean = (variant: string, list: SceneFile[], adjusted = false) => mean(have(variant, list).map(scene => sceneMean(variant, scene.id, adjusted)));
const sets: Array<[string, SceneFile[]]> = [['前回の 23 場面', original], ['追加の 5 場面（s16 s18 s23 s35 s67）', extras], ['全 28 場面', scenes]];
out.push('## 1. 正しさ（場面ごとの平均の平均。○=1 △=0.5 ×=0。S との差と、場面を引き直した 95% の幅）\n');
out.push('| 場面の集合 | O（参考） | S（基準） | B2（基準+禁止の決まり） | C（直した） | C−S | 95% の幅 | 0 をまたぐか | O−S |', '|---|---:|---:|---:|---:|---:|---|---|---:|');
for (const [name, list] of sets) {
  const b = boot('C', 'S', list);
  const oList = have('O', list);
  out.push(`| ${name}（${list.length}） | ${f(scenesMean('O', oList))} | ${f(scenesMean('S', list))} | ${f(scenesMean('B2', list))} | ${f(scenesMean('C', list))} | ${signed(b.diff, 3)} | ${f(b.low, 3)}〜${f(b.high, 3)} | ${b.low <= 0 && b.high >= 0 ? 'またぐ' : 'またがない'} | ${signed(scenesMean('O', oList) - scenesMean('S', oList))} |`);
}
out.push('\n### 1.1 足・頭のマスへの place を ×にする検査を全版に足した採点（最終の答えの手に own_cell の守りが当たる物を ×。台の元の検査はこれを見ない）\n');
out.push('| 場面の集合 | O | S | B2 | C | C−S | 95% の幅 |', '|---|---:|---:|---:|---:|---:|---|');
for (const [name, list] of sets) {
  const b = boot('C', 'S', list, true);
  out.push(`| ${name} | ${f(scenesMean('O', list, true))} | ${f(scenesMean('S', list, true))} | ${f(scenesMean('B2', list, true))} | ${f(scenesMean('C', list, true))} | ${signed(b.diff, 3)} | ${f(b.low, 3)}〜${f(b.high, 3)} |`);
}
out.push('\n### 1.2 答えごとの内訳（全 28 場面）\n');
out.push('| 版 | 答え | ○ | △ | × | 未採点 | 平均（答えごと） | 最終の答えに足・頭の place が残った数 |', '|---|---:|---:|---:|---:|---:|---:|---:|');
for (const id of ['prod', ...ids]) {
  const list = table.filter(item => item.variant === id);
  if (!list.length) continue;
  const decided = list.filter(item => item.final.verdict !== '?');
  out.push(`| ${id === 'prod' ? '本番の記録' : id} | ${list.length} | ${list.filter(i => i.final.verdict === '○').length} | ${list.filter(i => i.final.verdict === '△').length} | ${list.filter(i => i.final.verdict === '×').length} | ${list.filter(i => i.final.verdict === '?').length} | ${f(mean(decided.map(i => points[i.final.verdict]!)))} | ${list.filter(i => i.ownCell).length} |`);
}
out.push('\n## 2. 場面ごとの平均点\n');
out.push('| 場面 | 種類 | O | S | B2 | C | C−S | C−S（足・頭の place を×） |', '|---|---|---:|---:|---:|---:|---:|---:|');
for (const scene of scenes) {
  const [o, s, b2, c] = ids.map(id => sceneMean(id, scene.id));
  const ds = signed(c - s), da = signed(sceneMean('C', scene.id, true) - sceneMean('S', scene.id, true));
  out.push(`| ${short(scene.id)} ${scene.title.slice(0, 22)}${EXTRA.includes(short(scene.id)) ? '（追加）' : ''} | ${scene.category.join('+')} | ${f(o)} | ${f(s)} | ${f(b2)} | ${f(c)} | ${ds} | ${da} |`);
}

// ---- 3. 守り
out.push('\n## 3. 送る前の守りが止めた数（1 回目の答え。C は今の src の守り、S は前回の守り）\n');
const fix = (variant: string) => rows.filter(row => row.variant === variant && sceneIds.has(row.scene)) as any[];
out.push('| 版 | 答え | 守りが止めた | 全部止め | 一部止め | 止めた割合 |', '|---|---:|---:|---:|---:|---:|');
for (const id of ['S', 'C']) {
  const list = fix(id), held = list.filter(r => r.sent?.guard), whole = held.filter(r => r.sent.guard.stopped);
  out.push(`| ${id} | ${list.length} | ${held.length} | ${whole.length} | ${held.length - whole.length} | ${f(100 * held.length / list.length, 0)}% |`);
}
out.push('\n止めた手の種類（守りの文の「手 k 種類 語」。1 回目の答えごと）:\n');
const kindOfText = (row: any): string => {
  const text = String(row.sent?.guard?.text ?? '');
  const m = /手 \d+ (\w+) ([^:]+):/u.exec(text);
  if (m) return `${m[1]} ${m[2]}`;
  return /見られる/u.test(text) ? 'dig 見られる' : /急ぎの判断は/u.test(text) ? '急ぎの手の数' : '他';
};
const kinds = new Map<string, Record<string, number>>();
for (const id of ['S', 'C']) {
  for (const row of fix(id).filter(r => r.sent?.guard)) {
    const k = kindOfText(row), old = kinds.get(k) ?? {};
    kinds.set(k, { ...old, [id]: (old[id] ?? 0) + 1 });
  }
}
out.push('| 止めた手 | S | C |', '|---|---:|---:|');
for (const [k, v] of [...kinds].sort()) out.push(`| ${k} | ${v.S ?? 0} | ${v.C ?? 0} |`);
out.push('\n聞き直しの答え（台は 1 回だけ聞き直す。本番ならこの答えも守りにかかる）を今の守りにかけ直した結果:\n');
out.push('| 版 | 聞き直した答え | 守りがまた止めた | 内訳（種類） |', '|---|---:|---:|---|');
for (const id of ['S', 'C']) {
  let asked = 0, again = 0;
  const by = new Map<string, number>();
  for (const row of fix(id)) {
    if (!row.sent?.guard || row.rawFinal === undefined) continue;
    const scene = scenes.find(s => s.id === row.scene)!, decision = decisionOf(runs, scene), frame = candFrame(decision, frames(runs, decision.run.key));
    asked += 1;
    const act = candidateAct(row.rawFinal, frame, `again-${row.scene}-${row.rep}`, { urgent: isUrgentLive(decision.live) });
    if (act.guard) { again += 1; const k = kindOfText({ sent: { guard: act.guard } }); by.set(k, (by.get(k) ?? 0) + 1); }
  }
  out.push(`| ${id} | ${asked} | ${again} | ${[...by].map(([k, v]) => `${k} ${v}`).join('・') || '-'} |`);
}
out.push('\n新しい守り（足・頭のマス・溶岩の隣）に当たった 1 回目の答え（C）。誤停止かどうかは 1 つずつ読む:\n');
const newOnes: string[] = [];
for (const row of fix('C')) {
  const text = String(row.sent?.guard?.text ?? '');
  if (/今立っている|溶岩が流れ込む|溶岩が隣り合う/u.test(text)) newOnes.push(`${short(row.scene)} r${row.rep} ${row.sent.guard.stopped ? '全' : '部'}${row.sent.guard.hand}: ${text.replace(/^.*?手 \d+ /u, '').slice(0, 220)}`);
}
out.push(...(newOnes.length ? newOnes.map(line => `- ${line}`) : ['- なし']));

// ---- 4. 時間・費用
out.push('\n## 4. 時間・費用（1 判断。聞き直しを含む。自分の PC からストリーム。複数を並列に走らせたので時間は互いに邪魔する）\n');
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const assumedOne = (u: Usage) => costOf('claude-sonnet-5-5', { input: u.input, output: u.output, cacheWrite: 800, cacheRead: Math.max(0, u.cacheRead + u.cacheWrite - 800), cacheWrite1h: 800, cacheWrite5m: 0 });
function assumed(row: any): number {
  const f1 = row.firstUsage;
  if (!f1 || row.usage.output === f1.output) return assumedOne(row.usage);
  return assumedOne(f1) + assumedOne({ input: row.usage.input - f1.input, output: row.usage.output - f1.output, cacheWrite: row.usage.cacheWrite - f1.cacheWrite, cacheRead: row.usage.cacheRead - f1.cacheRead });
}
out.push('| 版 | 判断 | 全体 p50 / p95 (s) | 出力 平均 tok | 費用 平均（この台の実額） | 本番想定 1 判断 | 聞き直しのあった割合 |', '|---|---:|---|---:|---:|---:|---:|');
for (const id of ['S', 'C']) {
  const list = fix(id);
  const t = list.map(r => r.tEnd / 1000);
  out.push(`| ${id} | ${list.length} | ${f(quantile(t, 0.5), 1)} / ${f(quantile(t, 0.95), 1)} | ${f(mean(list.map(r => r.usage.output)), 0)} | ${f(mean(list.map(r => r.costUsd)), 4)} | ${f(mean(list.map(assumed)), 4)} | ${f(100 * list.filter(r => r.sent?.guard).length / list.length, 0)}% |`);
}
out.push(`\n要求の文字数（1 回目の要求の JSON）の平均: S ${f(mean(fix('S').map(r => r.requestChars)), 0)}、C ${f(mean(fix('C').map(r => r.requestChars)), 0)}。`);
writeFileSync(dataFile(flag('out', 'g26-tables.md')), out.join('\n'));
console.log(out.join('\n'));
