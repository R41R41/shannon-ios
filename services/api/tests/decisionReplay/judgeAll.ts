import { readFileSync } from 'node:fs';
import { replayClient } from './request.js';
import { appendJudged, candidatesOf, judgeScene, loadJudged } from './judge.js';
import { loadRuns } from './load.js';
import { spent } from './ledger.js';
import { decisionOf, loadScenes } from './score.js';
import type { ResultRow } from './run.js';

/** 場面ごとに 1 回、検査で決まらなかった答えを Opus に採点させる。すでに採点した答えは飛ばす（--force で全部やり直し）。 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow);
const file = p('judge.jsonl');
const done = process.argv.includes('--force') ? new Map() : loadJudged(file);
const client = replayClient(apiKey);
for (const scene of loadScenes()) {
  const decision = decisionOf(runs, scene);
  const candidates = candidatesOf(scene, decision, rows);
  const need = candidates.filter(item => (item.score.verdict === '?' || (scene.judge === 'always' && item.score.verdict !== '×')) && !done.has(`${scene.id}|${item.key}`));
  if (!need.length) continue;
  // The whole scene is judged again together, so that the labels and the comparison are the same for every answer of it.
  const graded = await judgeScene(client, scene, decision, candidates);
  appendJudged(file, graded);
  console.log(scene.id, graded.map(item => `${item.variant}${item.rep === 'prod' ? '' : item.rep}:${item.verdict}`).join(' '), 'spent', spent().toFixed(3));
}
