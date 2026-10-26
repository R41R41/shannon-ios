import { loadAllRuns } from './allRuns.js';
import { contextOf } from './checks.js';
import { decisionOf } from './score.js';
import { latest } from './views5.js';
import { readRows10, scenes10 } from './sonnet10.js';

/** 10/26: place が自分の足・頭のマスを指した答えの数（版ごと）。台の自動検査には無い項目なので、数だけ別に出す。 */
const rows = latest(readRows10(['sn-O.jsonl', 'sn-S.jsonl', 'sn-N.jsonl'])) as any[];
const runs = loadAllRuns();
const total: Record<string, number> = {}, hit: Record<string, string[]> = {};
for (const scene of scenes10(rows)) {
  if (!['O', 'S', 'N'].every(id => rows.some(row => row.variant === id && row.scene === scene.id))) continue;
  const self = contextOf(decisionOf(runs, scene)).self;
  for (const row of rows.filter(item => item.scene === scene.id)) {
    total[row.variant] = (total[row.variant] ?? 0) + 1;
    const hands = (row.sent?.input?.hands ?? []) as any[];
    const bad = hands.filter(hand => hand?.do === 'place' && (Array.isArray(hand.at) ? hand.at : hand.at ? [hand.at] : []).some((cell: any) => cell.x === self.x && cell.z === self.z && (cell.y === self.y || cell.y === self.y + 1)));
    if (bad.length) (hit[row.variant] ??= []).push(`${scene.id.slice(0, 3)}r${row.rep}`);
  }
}
for (const id of ['O', 'S', 'N']) console.log(id, `${hit[id]?.length ?? 0}/${total[id]}`, (hit[id] ?? []).join(' '));
