import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { callDecision, type CallResult } from './call.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { bootstrapFile } from './bootstrap.js';
import { CAP, guard, spent } from './ledger.js';
import { frames, scenesFor } from './sceneSet.js';
import { r10Input } from './r10Live.js';
import { buildRequest, replayClient, VARIANTS, type SceneRewrite } from './request.js';
import { compactHistory, expandAnswer, knowledgeEntry, shortenEntries, splitKnowledge, stagesFor } from './slim.js';
import type { Row2 } from './run2.js';

/**
 * v8（絞った形）の比べ（10/23 の 2 つ目の依頼）。v8a = 道具を 6 つに、v8b = + 知識の段をコードで選んで live の前に、v8c = + 履歴を要約 + 直近 3〜8 回に、
 * v8d = + 手を短い書き方に。どれも v4 の上（専用の指示文 + r10 の live）。守りは付けない。
 *   node --import tsx tests/decisionReplay/run3.ts --variants=v8a,v8d [--reps=1] [--scenes=s01,s36] [--out=results3.jsonl]
 * 呼び出しは DECISION_REPLAY_LEDGER（ledger3.jsonl）に数え、上限 DECISION_REPLAY_CAP を超える前に止まる。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
export const RESULTS3 = dataFile(flag('out') ?? 'results3.jsonl');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const wanted = (flag('variants') ?? 'v8d').split(',');
const reps = Number(flag('reps') ?? 1);
const done = new Set<string>();
if (existsSync(RESULTS3)) for (const line of readFileSync(RESULTS3, 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(line) as Row2;
  if (row.ok) done.add(`${row.variant}|${row.scene}|${row.rep}`);
}
const runs = loadAllRuns();
const client = replayClient(apiKey);
const split = splitKnowledge();
const scenes = scenesFor(runs, flag('scenes')?.split(','));
const bootstrapOf = (key: string, epoch: number): string | null => {
  if (epoch === 0) return null;
  const file = bootstrapFile(runs.get(key)!);
  if (!existsSync(file)) throw new Error(`DECISION_REPLAY_NO_BOOTSTRAP ${key} e${epoch}`);
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>)[epoch] ?? null;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const GUESS = 0.13;

async function chain(id: string): Promise<void> {
  const variant = VARIANTS.find(item => item.id === id)!;
  const slim = variant.slim!;
  let previous: (typeof scenes)[number] | undefined;
  for (const item of scenes) {
    const { scene, decision } = item;
    const info = frames(runs, decision.run.key);
    const r10 = r10Input(decision, info);
    const rewrite: SceneRewrite = { rows: r10.rows, turn: r10.turn };
    const live = r10.turn.find(entry => entry.role === 'system')!;
    // 場面の知識は live の直前（system が 2 つ続くのは配列の終わりだけ許される）。
    if (slim.knowledge) rewrite.turn = r10.turn.flatMap(entry => entry === live ? [knowledgeEntry(JSON.parse(String(live.content)) as Record<string, any>, split, live), entry] : [entry]);
    if (slim.history) rewrite.history = (slim.short ? shortenEntries : (entries: never) => entries)(compactHistory(decision, 3, 6, r10.rows) as never);
    else if (slim.short) rewrite.rows = r10.rows.map(shortenEntries);
    const request = await buildRequest(variant, decision, decision.run.core, bootstrapOf(decision.run.key, decision.epoch), '5m', false, previous?.decision, rewrite);
    previous = item;
    for (let rep = 1; rep <= reps; rep += 1) {
      if (done.has(`${id}|${scene.id}|${rep}`)) continue;
      guard(GUESS);
      let result: CallResult = await callDecision(client, request.body, request.headers, variant.model, `replay-${id}`, `${scene.id} r${rep}`);
      if (!result.ok && (result.status === undefined || result.status === 429 || result.status >= 500 || result.error?.includes('overloaded'))) {
        console.log(`${id} ${scene.id} r${rep} retry after: ${result.error}`);
        await sleep(8_000);
        result = await callDecision(client, request.body, request.headers, variant.model, `replay-${id}`, `${scene.id} r${rep}`);
      }
      const raw = result.content;
      const content = slim.short ? expandAnswer(raw) : raw;
      const answer = answerOf(content);
      const rawUse = raw.find(block => block.type === 'tool_use');
      const row: Row2 & { slim?: Record<string, unknown> } = { variant: id, scene: scene.id, rep, ok: result.ok, ...(result.error ? { error: result.error } : {}),
        ...(result.status ? { status: result.status } : {}), answer: { tool: answer.tool, input: answer.input, why: answer.why, shapeProblem: answer.shapeProblem },
        stopReason: result.stopReason, usage: { input: result.usage.input, output: result.usage.output, cacheWrite: result.usage.cacheWrite, cacheRead: result.usage.cacheRead },
        costUsd: result.costUsd, tMessageStart: result.tMessageStart, tFirstBlock: result.tFirstBlock, tFirstToolInput: result.tFirstToolInput, tEnd: result.tEnd,
        transformations: result.inputTransformations.length, requestChars: JSON.stringify(request.body).length, at: new Date().toISOString(),
        slim: { stages: slim.knowledge ? stagesFor(JSON.parse(String(live.content)) as Record<string, any>) : undefined, rawInput: slim.short ? rawUse?.input : undefined,
          notationError: slim.short && (answer.input as Record<string, unknown>)?.['書き方の誤り'] ? (answer.input as Record<string, unknown>)['書き方の誤り'] : undefined } };
      appendFileSync(RESULTS3, `${JSON.stringify(row)}\n`);
      if (row.ok) done.add(`${id}|${scene.id}|${rep}`);
      console.log(`${id} ${scene.id} r${rep} ${row.ok ? 'ok' : `NG ${row.error}`} ${row.answer.tool} ${(row.tEnd / 1000).toFixed(1)}s out=${row.usage.output} in=${row.usage.input}/w${row.usage.cacheWrite}/r${row.usage.cacheRead} $${row.costUsd.toFixed(4)} total $${spent().toFixed(3)}`);
    }
  }
}
if (process.argv[1]?.endsWith('run3.ts')) {
  console.log(`run3 start variants=${wanted.join(',')} reps=${reps} scenes=${scenes.length} spent $${spent().toFixed(3)} cap $${CAP}`);
  await Promise.all(wanted.map(id => chain(id)));
  console.log('done; spent $', spent().toFixed(3));
}
