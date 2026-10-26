import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { callDecision } from './call.js';
import { bootstraps } from './bootstrap.js';
import { CAP, guard, spent } from './ledger.js';
import { loadRuns } from './load.js';
import { buildRequest, replayClient, VARIANTS, type Variant } from './request.js';
import { decisionOf, loadScenes, type SceneFile } from './score.js';
import { projectedCost } from './plan.js';

/**
 * 判断の再現: 場面 × 版 × 回数。版ごとに 1 本の流れ（同じ版の中は場面を順に、1 場面は続けて 2 回）で、版は並べて走らせる。
 *   node --import tsx tests/decisionReplay/run.ts [--variants=v1,v2,v3] [--scenes=s01,s02] [--reps=2] [--out=results.jsonl]
 * 結果は data/results.jsonl に 1 回ごと 1 行。すでに ok の（版・場面・回）は飛ばす（途中から再開できる）。費用は ledger.jsonl が数え、上限 CAP を超える前に止まる。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const RESULTS = p(flag('out') ?? 'results.jsonl');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const wantedVariants = (flag('variants') ?? 'v1,v2,v3').split(',');
const wantedScenes = flag('scenes')?.split(',');
const reps = Number(flag('reps') ?? 2);

export interface ResultRow {
  variant: string; scene: string; rep: number; ok: boolean; error?: string; status?: number;
  answer: { tool: string | null; input: unknown; why?: string; shapeProblem: string | null };
  stopReason: string | null; usage: { input: number; output: number; cacheWrite: number; cacheRead: number };
  costUsd: number; tMessageStart: number | null; tFirstBlock: number | null; tFirstToolInput: number | null; tEnd: number;
  transformations: number; requestChars: number; at: string;
}
const done = new Set<string>();
if (existsSync(RESULTS)) for (const line of readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(line) as ResultRow;
  if (row.ok) done.add(`${row.variant}|${row.scene}|${row.rep}`);
}

const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const fixed = new Map<string, Record<number, string>>();
for (const run of runs.values()) fixed.set(run.key, await bootstraps(run, apiKey));
const client = replayClient(apiKey);
const scenes = loadScenes().filter(scene => !wantedScenes || wantedScenes.includes(scene.id.split('-')[0]!))
  .map(scene => ({ scene, decision: decisionOf(runs, scene) }))
  .sort((a, b) => a.scene.run.localeCompare(b.scene.run) || a.decision.epoch - b.decision.epoch || a.decision.index - b.decision.index);

/** An upper guess of one call's cost, before it is made (the ledger refuses a call that would pass the cap). */
const GUESS: Record<string, number> = { v1: 0.14, v2: 0.12, v3: 0.07 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function chain(variant: Variant): Promise<void> {
  let previous: (typeof scenes)[number] | undefined;
  for (const item of scenes) {
    const { scene, decision } = item;
    const run = runs.get(scene.run)!;
    const text = decision.epoch > 0 ? fixed.get(scene.run)![decision.epoch] ?? null : null;
    const request = await buildRequest(variant, decision, run.core, text, '5m', false, previous?.decision);
    previous = item;
    // Rep 2 only while the rest of the plan (both reps) still fits the cap: coverage of every scene comes first.
    const remaining = scenes.slice(scenes.indexOf(item)).map(entry => entry.scene.id);
    const budgetLeft = CAP - spent();
    const twice = projectedCost(variant.id, remaining, 2) <= budgetLeft - Number(flag('reserve') ?? 0.7);
    for (let rep = 1; rep <= (twice ? reps : 1); rep += 1) {
      if (done.has(`${variant.id}|${scene.id}|${rep}`)) continue;
      guard(GUESS[variant.id] ?? 0.15);
      let result = await callDecision(client, request.body, request.headers, variant.model, `replay-${variant.id}`, scene.id);
      if (!result.ok && (result.status === undefined || result.status === 429 || result.status >= 500 || result.error?.includes('overloaded'))) {
        console.log(`${variant.id} ${scene.id} r${rep} retry after: ${result.error}`);
        await sleep(8_000);
        result = await callDecision(client, request.body, request.headers, variant.model, `replay-${variant.id}`, scene.id);
      }
      const answer = answerOf(result.content);
      const row: ResultRow = { variant: variant.id, scene: scene.id, rep, ok: result.ok, ...(result.error ? { error: result.error } : {}),
        ...(result.status ? { status: result.status } : {}), answer: { tool: answer.tool, input: answer.input, why: answer.why, shapeProblem: answer.shapeProblem },
        stopReason: result.stopReason, usage: { input: result.usage.input, output: result.usage.output, cacheWrite: result.usage.cacheWrite, cacheRead: result.usage.cacheRead },
        costUsd: result.costUsd, tMessageStart: result.tMessageStart, tFirstBlock: result.tFirstBlock, tFirstToolInput: result.tFirstToolInput, tEnd: result.tEnd,
        transformations: result.inputTransformations.length, requestChars: JSON.stringify(request.body).length, at: new Date().toISOString() };
      appendFileSync(RESULTS, `${JSON.stringify(row)}\n`);
      console.log(`${variant.id} ${scene.id} r${rep} ${result.ok ? 'ok' : `NG ${result.error}`} ${answer.tool} hands=${answer.hands.length} ${(result.tEnd / 1000).toFixed(1)}s out=${result.usage.output} `
        + `in=${result.usage.input}/w${result.usage.cacheWrite}/r${result.usage.cacheRead} $${result.costUsd.toFixed(4)} total $${spent().toFixed(3)}`);
    }
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('run.ts')) {
  await Promise.all(VARIANTS.filter(variant => wantedVariants.includes(variant.id)).map(variant => chain(variant)));
  console.log('done; spent $', spent().toFixed(3));
}
export type { SceneFile };
