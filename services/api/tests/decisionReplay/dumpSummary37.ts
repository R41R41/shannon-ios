import { loadAllRuns } from './allRuns.js';
const run = loadAllRuns().get(process.argv[2] ?? 'r37')!;
const j = JSON.parse(run.summary!.bootstrap);
for (const [k, v] of Object.entries(j.summary)) console.log(k, JSON.stringify(v));
