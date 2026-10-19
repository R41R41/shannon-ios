/* The decision-gap bench (not a test): `node --import tsx tests/perf/decisionGapBench.ts` from services/api. See `fcaLoopStallHarness.ts`. */
import { runLoopStall } from '../support/fcaLoopStallHarness.js';
import { printProfile, startCpuProfile } from '../support/perfMeasure.js';

/**
 * Where a body decision's time goes besides the model and the body (2026-10-19, owner: "旧に届かないところ（判断ごとの固定の空き）も直して").
 * Production run 15: 25.2 s a decision, 7.7 s of it named by no part (about 5.2 s of stalls), and 1.9 s from one decision's commit to the
 * next one's start; L104 spent about 3 s a decision beside the model and the body. The task runs as production wires it (transient, the
 * body recall, the next turn at once; `LEGACY=1` as before), the model answering in `MODEL_MS` (3,500) and a body skill taking `SKILL_MS`
 * (6,000), and each `fca_decision_metrics` line is read: the parts it names, what is left (`rest`), and the gap before the decision.
 */
const steps = Number(process.env.STEPS ?? 20), modelMs = Number(process.env.MODEL_MS ?? 3_500), skillMs = Number(process.env.SKILL_MS ?? 6_000);
const lines: Array<Record<string, unknown>> = [];
const profiling = process.env.PROFILE ? await startCpuProfile() : null;
const result = await runLoopStall({ steps, modelMilliseconds: modelMs, skillMilliseconds: [skillMs, skillMs], legacyShape: process.env.LEGACY === '1',
  selectorMilliseconds: Number(process.env.SELECTOR_MS ?? 400), resultCharacters: [50, 400], failureEvery: Number(process.env.FAIL_EVERY ?? 8), log: line => console.log(line),
  ...(process.env.SEED_ROWS ? { seedProvenance: { rows: Number(process.env.SEED_ROWS), pool: Number(process.env.POOL ?? 190) } } : {}),
  metrics: line => { try { lines.push(JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>); } catch { /* not a line */ } } });
const profile = profiling ? await profiling() : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const decided = lines.filter(line => Array.isArray(line.tools) && (line.tools as unknown[]).length);
const parts = ['llmMs', 'toolMs', 'summaryMs', 'recallMs', 'recallStartMs', 'selectorMs', 'evidenceMs'] as const;
const others = ['startMs', 'permitMs', 'guardMs', 'contextMs', 'verifyMs', 'closeMs', 'commitMs'] as const;
const mean = (pick: (line: Record<string, unknown>) => number) => decided.reduce((sum, line) => sum + pick(line), 0) / Math.max(1, decided.length);
const named = (line: Record<string, unknown>) => parts.reduce((sum, key) => sum + (key === 'recallStartMs' ? 0 : number(line[key])), 0)
  + others.reduce((sum, key) => sum + number((line.other as Record<string, unknown> | undefined)?.[key]), 0);
const gap = (key: string) => mean(line => number((line.gap as Record<string, unknown> | null)?.[key]));
console.log(`shape=${process.env.LEGACY === '1' ? 'legacy' : 'production'} decisions=${decided.length}/${result.decisions} summaries=${result.summaries} model=${modelMs}ms skill=${skillMs}ms`);
console.log(`step=${mean(line => number(line.stepMs)).toFixed(0)}ms ${parts.map(key => `${key}=${mean(line => number(line[key])).toFixed(0)}`).join(' ')}`);
console.log(`other: ${others.map(key => `${key}=${mean(line => number((line.other as Record<string, unknown> | undefined)?.[key])).toFixed(0)}`).join(' ')}`);
console.log(`rest (step - named parts)=${mean(line => number(line.stepMs) - named(line)).toFixed(0)}ms loopBlocked=${mean(line => number(line.loopBlockedMs)).toFixed(0)}ms`);
console.log(`gap: sinceCommit=${gap('sinceCommitMs').toFixed(0)}ms after=${gap('afterMs').toFixed(0)} wait=${gap('waitMs').toFixed(0)} admit=${gap('admitMs').toFixed(0)} start=${gap('startMs').toFixed(0)}`);
const fixed = mean(line => number(line.stepMs) - number(line.llmMs) - number(line.toolMs)) + gap('sinceCommitMs');
console.log(`fixed beside model and body: ${fixed.toFixed(0)}ms a decision (step - llm - tool + gap)`);
console.log(`loop: max=${result.loop.maxMs.toFixed(0)}ms blocked(>=50ms)=${result.loop.blockedMs.toFixed(0)}ms stalls=${result.loop.stalls} cpu=${(result.cpuMs / 1000).toFixed(1)}s wall=${(result.wallMs / 1000).toFixed(0)}s`);
if (process.env.LINES) for (const line of decided) console.log(JSON.stringify(line));
if (profile) printProfile('decision gap', profile, Number(process.env.TOP ?? 40));
await result.close();
process.exit(0);
