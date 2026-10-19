/* The loop-stall bench (not a test): `node --import tsx tests/perf/loopStallBench.ts` from services/api. See `fcaLoopStallHarness.ts`. */
import { runLoopStall } from '../support/fcaLoopStallHarness.js';
import { printProfile, startCpuProfile } from '../support/perfMeasure.js';

const steps = Number(process.env.STEPS ?? 30), variant = (process.env.VARIANT ?? 'current') as 'current' | 'run14';
const profiling = process.env.PROFILE ? await startCpuProfile() : null;
const result = await runLoopStall({ steps, variant, ...(process.env.WALK_LOG ? { walkLogMilliseconds: Number(process.env.WALK_LOG) } : {}), log: line => console.log(line), ...(process.env.OBSERVER === '0' ? { observer: false } : {}),
  ...(process.env.SEED_ROWS ? { seedProvenance: { rows: Number(process.env.SEED_ROWS), pool: Number(process.env.POOL ?? 190) } } : {}),
  ...(process.env.SKILL_MS ? { skillMilliseconds: [Number(process.env.SKILL_MS), Number(process.env.SKILL_MS) * 2] as [number, number] } : {}),
  ...(process.env.MODEL_MS ? { modelMilliseconds: Number(process.env.MODEL_MS) } : {}) });
const profile = profiling ? await profiling() : null;
const { loop } = result;
console.log(`variant=${variant} decisions=${result.decisions} summaries=${result.summaries} wall=${(result.wallMs / 1000).toFixed(1)}s cpu=${(result.cpuMs / 1000).toFixed(2)}s (${(100 * result.cpuMs / result.wallMs).toFixed(1)}%)`);
console.log(`loop: max=${loop.maxMs.toFixed(0)}ms p99=${loop.p99Ms.toFixed(1)}ms mean=${loop.meanMs.toFixed(2)}ms blocked(>=50ms)=${loop.blockedMs.toFixed(0)}ms (${(100 * loop.blockedFraction).toFixed(2)}%) stalls=${loop.stalls} longest=${loop.longest.join(',')}`);
console.log(`watch (>=500ms): n=${result.watch.length} sum=${result.watch.reduce((a, b) => a + b, 0)}ms [${result.watch.slice(0, 20).join(',')}]`);
console.log(`observer sidecar writes: n=${result.observerWrites.length} total=${result.observerWrites.reduce((a, b) => a + b, 0).toFixed(0)}ms longest=${[...result.observerWrites].sort((a, b) => b - a).slice(0, 6).map(v => v.toFixed(0)).join(',')}`);
const walks = result.walks;
{
  const by: Record<string, typeof walks> = {};
  for (const w of walks) (by[`${w.mode}/${w.via}`] ??= []).push(w);
  const sum = (list: typeof walks, key: 'total' | 'epoch' | 'provenance' | 'reads' | 'walk') => list.reduce((a, w) => a + w[key], 0);
  console.log(`source-guard checks logged: n=${walks.length} total=${sum(walks, 'total')}ms`);
  for (const [key, list] of Object.entries(by).sort((a, b) => sum(b[1], 'total') - sum(a[1], 'total'))) console.log(`  ${key.padEnd(20)} n=${String(list.length).padStart(4)} total=${String(sum(list, 'total')).padStart(6)}ms epoch=${sum(list, 'epoch')} provenance=${sum(list, 'provenance')} reads=${sum(list, 'reads')} walk=${sum(list, 'walk')}`);
}
console.log(`request chars first/last: ${result.requestCharacters[0]}/${result.requestCharacters.at(-1)}; blocked ms per decision: ${result.blockedByDecision.map(value => Math.round(value)).join(',')}`);
if (process.env.TIMELINE) {
  const rows = [...loop.events.map(e => ({ at: e.at, text: `STALL ${e.late.toFixed(0)}ms` })), ...walks.map(w => ({ at: w.at, text: `  walk ${w.total}ms ${w.mode}/${w.via}` })), ...result.decisionAt.map((at, i) => ({ at, text: `-- decision ${i + 1}` }))].sort((a, b) => a.at - b.at);
  for (const row of rows) console.log(`  ${((row.at - result.startedAt) / 1000).toFixed(1).padStart(6)}s ${row.text}`);
}
const slow = result.warnings.filter(line => /slow|capped|failed|held|unknown/u.test(line)).slice(0, 12);
if (slow.length) console.log('warnings:', slow.join('\n  '));
if (profile) printProfile('bench', profile, 35);
await result.close();
process.exit(0);
