/* The loop-stall time budget (not a CI test: seconds move with the machine and with what runs beside it). From services/api:
   `node --import tsx tests/perf/loopStallBudget.ts` on a quiet machine; exit code 1 when a bound is missed. The counted budget that CI holds is
   `tests/fcaLoopStallBudget.test.ts`; the story of the run is in its comment. Bounds (origin/main 0c0ad93 measured 950-1,040 ms and 20-24% on
   the same machine; this branch 340-440 ms and 8-10%): no hold of the API's one thread longer than 650 ms, and under 17% of the time in holds of
   50 ms or more, over the task's first steps. `BUDGET_SCALE` loosens both (e.g. 2 on a slower machine). */
import { runLoopStall } from '../support/fcaLoopStallHarness.js';

const scale = Number(process.env.BUDGET_SCALE ?? 1);
const run = await runLoopStall({ steps: 3, legacyShape: true, seedProvenance: { rows: 100 }, walkLogMilliseconds: 50, skillMilliseconds: [300, 900], modelMilliseconds: 500 });
const failures: string[] = [];
const longestCheck = Math.max(0, ...run.walks.map(walk => walk.total));
if (run.decisions < 4) failures.push(`only ${run.decisions} decisions`);
if (longestCheck >= 300 * scale) failures.push(`the longest check of the source guard took ${longestCheck} ms (${run.walks.map(walk => `${walk.mode}/${walk.via} ${walk.total}ms`).join(', ')})`);
if (run.loop.maxMs >= 650 * scale) failures.push(`longest holds ${run.loop.longest.join(', ')} ms (bound ${650 * scale})`);
if (run.loop.blockedFraction >= 0.17 * scale) failures.push(`blocked ${Math.round(run.loop.blockedMs)} ms of ${Math.round(run.wallMs)} ms (${(100 * run.loop.blockedFraction).toFixed(1)}%, bound ${17 * scale}%)`);
if (run.watch.some(ms => ms >= 650 * scale)) failures.push(`the production watch would name: ${run.watch.filter(ms => ms >= 650 * scale).join(', ')} ms`);
console.log(`loop-stall budget: decisions=${run.decisions} max hold=${run.loop.maxMs.toFixed(0)}ms blocked=${(100 * run.loop.blockedFraction).toFixed(1)}% longest check=${longestCheck}ms`);
if (failures.length) console.log(`FAILED:\n  ${failures.join('\n  ')}`);
await run.close();
process.exit(failures.length ? 1 : 0);
