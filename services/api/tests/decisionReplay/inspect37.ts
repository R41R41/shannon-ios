import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
const runs = loadAllRuns();
const run = runs.get('r37')!;
console.log('rows', run.rows.length, 'summary', run.summary ? { rev: run.summary.rev, from: run.summary.from, through: run.summary.through, len: run.summary.bootstrap.length } : null, 'core', run.core.length);
const ds = decisions(run);
const starts = ds.filter((d, i) => i === 0 || d.epochStart === d.index);
console.log('epoch starts', starts.map(d => `${d.epoch}:idx${d.index}`).join(' '));
for (const d of ds) {
  const l = d.live as any;
  console.log(d.index + 1, 'e' + d.epoch, d.call?.name, JSON.stringify(d.call?.input ?? {}).slice(0, 110), '|', String(d.resultText).slice(0, 70).replace(/\n/g, ' '));
}
