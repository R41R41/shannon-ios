import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
const run = loadAllRuns().get(process.argv[2] ?? 'r37')!;
const ds = decisions(run);
console.log('first seq', run.rows[0]!.seq, 'last seq', run.rows.at(-1)!.seq, 'summary', run.summary!.from, run.summary!.through, run.summary!.reset);
for (const d of ds) if (d.index === 0 || d.epochStart === d.index) console.log('epoch', d.epoch, 'idx', d.index, 'd=', d.index + 1, 'seq', d.row.seq);
const bs = JSON.parse(run.summary!.bootstrap); console.log('bootstrap rounds', bs.rounds.map((r: any) => r.sequence).join(','));
