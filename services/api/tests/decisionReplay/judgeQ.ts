import { replayClient } from './request.js';
import { appendJudged, judgeScene, loadJudged } from './judge.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { spent } from './ledger.js';
import { decisionOf } from './score.js';
import { candidatesOf5, latest } from './views5.js';
import { readRowsQ, scenesQ, VIEWS_Q } from './sonnetQ.js';

/** 場面ごとに、本番の記録 + O・S・B2・C の答えを全部まとめて 1 回（同じ答えは 1 つに。出どころは伏せて混ぜる）。--out=judgeQ.jsonl [--force] [--dry] [--scenes=s01,..] */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dry = args.includes('--dry');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey && !dry) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const rows = latest(readRowsQ());
const file = dataFile(flag('out') ?? 'judgeQ.jsonl');
const done = args.includes('--force') ? new Map() : loadJudged(file);
const wanted = flag('scenes')?.split(',');
const client = dry ? null : replayClient(apiKey);
const runs = loadAllRuns();
let calls = 0;
for (const scene of scenesQ(rows).filter(item => !wanted || wanted.includes(item.id.split('-')[0]!))) {
  const decision = decisionOf(runs, scene);
  const candidates = await candidatesOf5(scene, decision, rows, VIEWS_Q);
  const need = candidates.filter(item => (item.score.verdict === '?' || (scene.judge === 'always' && item.score.verdict !== '×')) && !done.has(`${scene.id}|${item.key}`));
  if (!need.length) continue;
  calls += 1;
  if (dry) { console.log(scene.id, 'judge', need.length, '/', candidates.length); continue; }
  const graded = await judgeScene(client!, scene, decision, candidates);
  appendJudged(file, graded);
  console.log(scene.id, graded.map(item => `${item.variant}${item.rep === 'prod' ? '' : item.rep}:${item.verdict}`).join(' '), 'spent', spent().toFixed(3));
}
console.log(dry ? `dry: ${calls} judge calls` : `done ${calls} calls`);
