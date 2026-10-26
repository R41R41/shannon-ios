/** v9b・v9c を v2 と場面ごとに比べ、平均点が 0.25 以上良くなった・悪くなった場面を出す。先に report4.ts を回す。 */
import { readFileSync } from 'node:fs';
import { dataFile } from './allRuns.js';
const e = JSON.parse(readFileSync(dataFile('report4-entries.json'), 'utf8')) as Array<{ scene: string; variant: string; rep: number | string; verdict: string }>;
const pt: Record<string, number> = { '○': 1, '△': 0.5, '×': 0, '?': 0 };
const scenes = [...new Set(e.map(x => x.scene))];
const mean = (v: string, s: string) => { const l = e.filter(x => x.scene === s && x.variant === v); return l.length ? l.reduce((a, x) => a + pt[x.verdict]!, 0) / l.length : NaN; };
const show = (v: string, base: string) => {
  const up: string[] = [], down: string[] = [];
  for (const s of scenes) { const a = mean(v, s), b = mean(base, s); if (!Number.isFinite(a) || !Number.isFinite(b)) continue; const d = a - b; const cell = (x: string) => e.filter(y => y.scene === s && y.variant === x).map(y => y.verdict).join(''); if (d >= 0.25) up.push(`${s.slice(0, 3)}(${cell(base)}→${cell(v)})`); if (d <= -0.25) down.push(`${s.slice(0, 3)}(${cell(base)}→${cell(v)})`); }
  console.log(`${v} − ${base}  良くなった ${up.length}: ${up.join(' ')}\n   悪くなった ${down.length}: ${down.join(' ')}`);
};
show('v9b', 'v2'); show('v9c', 'v2');
