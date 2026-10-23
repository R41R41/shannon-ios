import { loadAllRuns } from './allRuns.js';
import { bootstraps, BOOTSTRAP_TAG, bootstrapFile } from './bootstrap.js';
import { spent } from './ledger.js';

/**
 * B の直しの比べの bootstrap（要約）。DECISION_REPLAY_BOOTSTRAP_TAG=base|fix を付けて、その木（base は 73244fc、fix は 8607283）の要約器で実走36・37 の epoch を作り直す。
 *   DECISION_REPLAY_BOOTSTRAP_TAG=fix DECISION_REPLAY_BOOTSTRAP_REAL=off node --import tsx tests/decisionReplay/makeBootstrapsB.ts r37 r36
 * REAL=off は、本番が残した本物の bootstrap（実走36 の epoch 4）も使わず作り直す（要約の指示文の差を見るため）。
 */
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
if (!BOOTSTRAP_TAG) throw new Error('DECISION_REPLAY_BOOTSTRAP_TAG');
const runs = loadAllRuns();
for (const key of process.argv.slice(2).filter(arg => !arg.startsWith('--'))) {
  const made = await bootstraps(runs.get(key)!, apiKey, process.argv.includes('--force'));
  console.log(key, BOOTSTRAP_TAG, bootstrapFile(runs.get(key)!), Object.entries(made).map(([epoch, text]) => `e${epoch}:${text.length}`).join(' '), 'spent', spent().toFixed(4));
}
