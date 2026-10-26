import { replayClient } from './request.js';
import { appendJudged, judgeScene, loadJudged } from './judge.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { spent } from './ledger.js';
import { decisionOf, loadScenes } from './score.js';
import { candidatesOf5, latest, readRows, VIEWS } from './views5.js';

/**
 * 後知恵つきの採点（10/23 の 4 つ目の比べ）。場面ごとに、本番の記録 + 見え方（views5.ts）ごとの答えを全部まとめて 1 回（同じ答えは 1 つに）。
 *   node --import tsx tests/decisionReplay/judge5.ts --out=judge5.jsonl [--only=v1,v1t,cand,candt] [--scenes=s01,s36] [--force] [--dry]
 * 基準と候補は、同じ場面の同じ呼び出しで一緒に採点する（出どころは伏せて混ぜる）。2 回目は --out=judge5b.jsonl --force --scenes=…。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dry = args.includes('--dry');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey && !dry) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const only = (flag('only') ?? '').split(',').filter(Boolean);
const views = VIEWS.filter(view => !only.length || only.includes(view.id));
const rows = latest(readRows());
const file = dataFile(flag('out') ?? 'judge5.jsonl');
const done = args.includes('--force') ? new Map() : loadJudged(file);
const wanted = flag('scenes')?.split(',');
const client = dry ? null : replayClient(apiKey);
const runs = loadAllRuns();
let calls = 0;
for (const scene of loadScenes().filter(item => !wanted || wanted.includes(item.id.split('-')[0]!))) {
  const decision = decisionOf(runs, scene);
  const candidates = await candidatesOf5(scene, decision, rows, views);
  const need = candidates.filter(item => (item.score.verdict === '?' || (scene.judge === 'always' && item.score.verdict !== '×')) && !done.has(`${scene.id}|${item.key}`));
  if (!need.length) continue;
  calls += 1;
  if (dry) { console.log(scene.id, 'judge', need.length, '/', candidates.length); continue; }
  const graded = await judgeScene(client!, scene, decision, candidates);
  appendJudged(file, graded);
  console.log(scene.id, graded.map(item => `${item.variant}${item.rep === 'prod' ? '' : item.rep}:${item.verdict}`).join(' '), 'spent', spent().toFixed(3));
}
console.log(dry ? `dry: ${calls} judge calls` : `done ${calls} calls`);
