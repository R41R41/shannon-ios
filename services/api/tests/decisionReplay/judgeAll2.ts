import { existsSync, readFileSync } from 'node:fs';
import { replayClient } from './request.js';
import { appendJudged, candidatesOf, judgeScene, loadJudged } from './judge.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { spent } from './ledger.js';
import { decisionOf, loadScenes } from './score.js';
import type { ResultRow } from './run.js';

/**
 * 後知恵つきの採点（10/23 版）: 結果は results.jsonl（v1〜v3）と results2.jsonl（v4〜v7）、場面は実走27〜34。場面ごとに全部の答えをまとめて 1 回（同じ答えは 1 つに）。
 *   node --import tsx tests/decisionReplay/judgeAll2.ts [--out=judge2.jsonl] [--scenes=s01,s36] [--only=v2,v4,v5,v8a] [--force]
 * （v8 の採点は --out=judge3.jsonl --only=v2,v4,v5,v8a,v8b,v8c,v8d。本番の記録は いつも入る。）
 * 2 回目の採点（一致率を見る）は --out=judge2b.jsonl --force で、別のファイルに。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const runs = loadAllRuns();
const read = (name: string) => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow) : [];
const only = (flag('only') ?? '').split(',').filter(Boolean);
const rows = [...read('results.jsonl'), ...read('results2.jsonl'), ...read('results3.jsonl')].filter(row => !only.length || only.includes(row.variant));
const file = dataFile(flag('out') ?? 'judge2.jsonl');
const done = args.includes('--force') ? new Map() : loadJudged(file);
const wanted = flag('scenes')?.split(',');
const client = replayClient(apiKey);
for (const scene of loadScenes().filter(item => !wanted || wanted.includes(item.id.split('-')[0]!))) {
  const decision = decisionOf(runs, scene);
  const candidates = candidatesOf(scene, decision, rows);
  const need = candidates.filter(item => (item.score.verdict === '?' || (scene.judge === 'always' && item.score.verdict !== '×')) && !done.has(`${scene.id}|${item.key}`));
  if (!need.length) continue;
  const graded = await judgeScene(client, scene, decision, candidates);
  appendJudged(file, graded);
  console.log(scene.id, graded.map(item => `${item.variant}${item.rep === 'prod' ? '' : item.rep}:${item.verdict}`).join(' '), 'spent', spent().toFixed(3));
}
