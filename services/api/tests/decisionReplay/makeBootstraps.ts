import { loadRuns } from './load.js';
import { bootstraps } from './bootstrap.js';
import { spent } from './ledger.js';
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
for (const run of runs.values()) {
  const set = await bootstraps(run, apiKey, process.argv.includes('--force'));
  console.log(run.key, Object.entries(set).map(([epoch, text]) => `e${epoch}:${text.length}`).join(' '), 'spent so far', spent().toFixed(4));
}
