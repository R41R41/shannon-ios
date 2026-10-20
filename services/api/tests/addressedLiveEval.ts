import { configuredJevChooser } from '../src/wiring/skillRoutingWiring.js';
import { AddressedJudge, type AddressedInput, type AddressedVerdict } from '../src/mind/perception/addressed.js';
import { ADDRESSED_CASES } from './support/addressedCases.js';

/**
 * 「話しかけられたか」 (owner 2026-10-21) against the real Jev: every case of `support/addressedCases.ts` once through the judge as the
 * server composes it (the gate, then Jev at 400 ms, the local rules when it does not answer). Billable (one Jev call per question asked):
 * run on purpose with `TYPESAFE_API_KEY` (`pnpm --filter @shannon/api test:llm-addressed`). `SHANNON_ADDRESSED_TIMEOUT_MS` changes the
 * 400 ms; `SHANNON_ADDRESSED_EVAL_ROUNDS` (default 1) repeats the set to see Jev's drift. Prints the accuracy, by group, the misses
 * and how often Jev answered in time, and the latency of the judgement (p50 / p95) over the questions asked.
 */
const chooser = configuredJevChooser(process.env, { trace: null });
if (!chooser) throw new Error('TYPESAFE_API_KEY is required for the live addressed evaluation');
const timeout = Number(process.env.SHANNON_ADDRESSED_TIMEOUT_MS);
const rounds = Math.max(1, Math.min(5, Number(process.env.SHANNON_ADDRESSED_EVAL_ROUNDS) || 1));
// A fresh cache for every round: the same question twice within a minute would be answered from memory.
const judgeFor = () => new AddressedJudge({ chooser: configuredJevChooser(process.env, { trace: null })!, ...(Number.isFinite(timeout) && timeout >= 100 ? { timeoutMilliseconds: timeout } : {}) });

const inputOf = (item: (typeof ADDRESSED_CASES)[number]): AddressedInput => ({
  scopeKey: 'live-eval', transcript: item.transcript, speaker: { id: item.speaker ?? 'owner', name: item.speaker ?? 'ライ氏' }, humans: item.humans,
  recent: (item.recent ?? []).map(line => ({ who: line.who, text: line.text, secondsAgo: line.secondsAgo, ...(line.shannon ? { shannon: true as const } : {}) })),
  ...(item.spoke ? { shannon: { spokeAgoMs: item.spoke.secondsAgo * 1000, toSpeaker: item.spoke.toSpeaker, ...(item.spoke.line ? { line: item.spoke.line } : {}) } } : {}),
});

const rows: Array<{ id: string; group: string; to: boolean; verdict: AddressedVerdict }> = [];
for (let round = 0; round < rounds; round += 1) {
  const judge = judgeFor();
  for (const item of ADDRESSED_CASES) rows.push({ id: item.id, group: item.group, to: item.to, verdict: await judge.judge(inputOf(item)) });
}
const right = rows.filter(row => row.verdict.addressed === row.to);
const asked = rows.filter(row => row.verdict.asked);
const answered = asked.filter(row => row.verdict.source === 'jev');
const latencies = asked.map(row => row.verdict.ms).sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? null;
const byGroup: Record<string, string> = {};
for (const group of [...new Set(rows.map(row => row.group))]) {
  const inGroup = rows.filter(row => row.group === group);
  byGroup[group] = `${inGroup.filter(row => row.verdict.addressed === row.to).length}/${inGroup.length}`;
}
console.log(JSON.stringify({
  cases: ADDRESSED_CASES.length, rounds, accuracy: Math.round((right.length / rows.length) * 1000) / 10, byGroup,
  asked: asked.length, jevAnsweredInTime: answered.length, fellBack: asked.length - answered.length,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null },
  misses: rows.filter(row => row.verdict.addressed !== row.to).map(row => `${row.id} (to her: ${row.to}; got ${row.verdict.addressed} by ${row.verdict.source})`),
}, null, 2));
