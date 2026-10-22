import { loadAllRuns } from './allRuns.js';
import { bootstraps } from './bootstrap.js';

/** 実走27〜31 の場面が使う epoch の bootstrap（最後の epoch は本物、それ以外は Haiku で作り直し）。 node --import tsx tests/decisionReplay/makeBootstraps2.ts r28 r30 */
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const runs = loadAllRuns();
for (const key of process.argv.slice(2)) {
  const made = await bootstraps(runs.get(key)!, apiKey);
  console.log(key, Object.entries(made).map(([epoch, text]) => `e${epoch}:${text.length}`).join(' '));
}
