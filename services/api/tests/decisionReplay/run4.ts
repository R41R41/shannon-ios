import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { callDecision, type CallResult } from './call.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { bootstrapFile } from './bootstrap.js';
import { CAP, guard, spent } from './ledger.js';
import { frames as _unused, scenesFor } from './sceneSet.js';
import { buildRequest, replayClient, VARIANTS, type SceneRewrite } from './request.js';
import { expandAnswer, shortenEntries } from './slim.js';
import { rewriteLive } from './rewriteLive.js';
import type { Row2 } from './run2.js';

/**
 * 10/23 の 3 つ目の比べ（書き直した live）。v2 = 今の live（基準。前の結果 results.jsonl・results2.jsonl があれば使い、足りない回数だけ回す）、
 * v9b = 書き直した live（rewriteLive.ts、決まりは rewriteRules.md）、v9c = v9b + 手の短い書き方。どれも専用の指示文 + 短い出力（v2 と同じ）で、守りは付けない。
 *   node --import tsx tests/decisionReplay/run4.ts --variants=v2,v9b,v9c [--reps=2] [--scenes=s01,s36] [--out=results4.jsonl] [--dry]
 * 呼び出しは DECISION_REPLAY_LEDGER（ledger4.jsonl）に数え、上限 DECISION_REPLAY_CAP を超える前に止まる。
 */
void _unused;
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dry = args.includes('--dry');
export const RESULTS4 = dataFile(flag('out') ?? 'results4.jsonl');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey && !dry) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const wanted = (flag('variants') ?? 'v2,v9b,v9c').split(',');
const reps = Number(flag('reps') ?? 2);
const read = (name: string): Row2[] => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row2) : [];
const loaded = [...read('results.jsonl'), ...read('results2.jsonl'), ...read('results4.jsonl'), ...(RESULTS4.endsWith('results4.jsonl') ? [] : read(flag('out')!))];
const have = (variant: string, scene: string) => loaded.filter(row => row.variant === variant && row.scene === scene && row.ok);

const runs = loadAllRuns();
const client = dry ? null : replayClient(apiKey);
const scenes = scenesFor(runs, flag('scenes')?.split(','));
const bootstrapOf = (key: string, epoch: number): string | null => {
  if (epoch === 0) return null;
  const file = bootstrapFile(runs.get(key)!);
  if (!existsSync(file)) throw new Error(`DECISION_REPLAY_NO_BOOTSTRAP ${key} e${epoch}`);
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>)[epoch] ?? null;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const GUESS = 0.09;

async function chain(id: string): Promise<void> {
  const variant = VARIANTS.find(item => item.id === id)!;
  let previous: (typeof scenes)[number] | undefined;
  for (const item of scenes) {
    const { scene, decision } = item;
    const rewrite: SceneRewrite = {};
    let notes: unknown;
    if (variant.legend) {
      const { live, notes: made } = rewriteLive(decision.live);
      notes = made;
      rewrite.turn = decision.turn.map(entry => entry.role === 'system' ? { ...entry, content: JSON.stringify(live) } : entry);
    }
    if (variant.slim?.short) rewrite.rows = decision.run.rows.slice(decision.epochStart, decision.index).map(row => shortenEntries(row.entries));
    const request = await buildRequest(variant, decision, decision.run.core, bootstrapOf(decision.run.key, decision.epoch), '5m', false, previous?.decision, rewrite);
    previous = item;
    const existing = have(id, scene.id);
    const doneReps = new Set(existing.map(row => row.rep));
    const chars = JSON.stringify(request.body).length;
    if (dry) {
      const old = existing.find(row => row.requestChars);
      console.log(id, scene.id.slice(0, 3), 'chars', chars, old ? `前の記録 ${old.requestChars}${old.requestChars === chars ? ' 一致' : ' 違う'}` : '', 'need', Math.max(0, reps - existing.length));
      continue;
    }
    let missing = Math.max(0, reps - existing.length);
    for (let rep = 1; missing > 0; rep += 1) {
      if (doneReps.has(rep)) continue;
      missing -= 1;
      guard(GUESS);
      let result: CallResult = await callDecision(client!, request.body, request.headers, variant.model, `replay-${id}`, `${scene.id} r${rep}`);
      if (!result.ok && (result.status === undefined || result.status === 429 || result.status >= 500 || result.error?.includes('overloaded'))) {
        console.log(`${id} ${scene.id} r${rep} retry after: ${result.error}`);
        await sleep(8_000);
        result = await callDecision(client!, request.body, request.headers, variant.model, `replay-${id}`, `${scene.id} r${rep}`);
      }
      const raw = result.content;
      const content = variant.slim?.short ? expandAnswer(raw) : raw;
      const answer = answerOf(content);
      const rawUse = raw.find(block => block.type === 'tool_use');
      const row: Row2 & { rewrite?: unknown; slim?: Record<string, unknown> } = { variant: id, scene: scene.id, rep, ok: result.ok, ...(result.error ? { error: result.error } : {}),
        ...(result.status ? { status: result.status } : {}), answer: { tool: answer.tool, input: answer.input, why: answer.why, shapeProblem: answer.shapeProblem },
        stopReason: result.stopReason, usage: { input: result.usage.input, output: result.usage.output, cacheWrite: result.usage.cacheWrite, cacheRead: result.usage.cacheRead },
        costUsd: result.costUsd, tMessageStart: result.tMessageStart, tFirstBlock: result.tFirstBlock, tFirstToolInput: result.tFirstToolInput, tEnd: result.tEnd,
        transformations: result.inputTransformations.length, requestChars: chars, at: new Date().toISOString(), ...(notes ? { rewrite: notes } : {}),
        ...(variant.slim?.short ? { slim: { rawInput: rawUse?.input, notationError: (answer.input as Record<string, unknown>)?.['書き方の誤り'] } } : {}) };
      appendFileSync(RESULTS4, `${JSON.stringify(row)}\n`);
      if (row.ok) doneReps.add(rep);
      console.log(`${id} ${scene.id} r${rep} ${row.ok ? 'ok' : `NG ${row.error}`} ${row.answer.tool} ${(row.tEnd / 1000).toFixed(1)}s out=${row.usage.output} in=${row.usage.input}/w${row.usage.cacheWrite}/r${row.usage.cacheRead} $${row.costUsd.toFixed(4)} total $${spent().toFixed(3)}`);
    }
  }
}
if (process.argv[1]?.endsWith('run4.ts')) {
  console.log(`run4 start variants=${wanted.join(',')} reps=${reps} scenes=${scenes.length} spent $${spent().toFixed(3)} cap $${CAP}${dry ? ' DRY' : ''}`);
  await Promise.all(wanted.map(id => chain(id)));
  console.log('done; spent $', spent().toFixed(3));
}
