import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { callDecision, type CallResult } from './call.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { bootstrapFile } from './bootstrap.js';
import { CAP, guard, spent } from './ledger.js';
import type { Decision, Entry } from './load.js';
import { preflightAct, preflightText } from '../../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import { frameBefore, resultsByDecision, type Frames } from './preflightFrames.js';
import { r10Input } from './r10Live.js';
import { buildRequest, replayClient, VARIANTS, type SceneRewrite, type Variant } from './request.js';
import { decisionOf, loadScenes } from './score.js';
import type { ResultRow } from './run.js';

/**
 * 10/23 の比べ（守りと r10）。v4（Opus + 専用の指示文 + r10 の live）、v5（v4 + 送る前の守り + 聞き直し 1 回）、v6（Opus、thinking を切って、守りつき）、
 * v7（Sonnet、守りつき）。守りの無い版は v6u・v7u（1 回目の答え）。v5 の 1 回目は v4 と同じ要求・同じ答え（同じ標本）を使う。
 *   node --import tsx tests/decisionReplay/run2.ts --variants=v4,v6,v7 [--reps=2] [--scenes=s01,s36] [--out=results2.jsonl]
 * 呼び出しは data/ledger2.jsonl に数え（DECISION_REPLAY_LEDGER）、上限 DECISION_REPLAY_CAP を超える前に止まる。結果は data/results2.jsonl に 1 回ごと 1 行。
 * 守りは、act を送る時に体が持っていた最新の地図の見積もり（直前の act の終わりの地図）にかける。止めた時は、止めた事実を tool_result（is_error）で返して
 * 同じ判断をもう 1 回だけ聞く（2 回目の答えは、また止まる物でもそのまま採点する）。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
export const RESULTS2 = dataFile(flag('out') ?? 'results2.jsonl');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const wanted = (flag('variants') ?? 'v4').split(',');
const wantedScenes = flag('scenes')?.split(',');
const reps = Number(flag('reps') ?? 1);

export interface Usage4 { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface GuardInfo {
  stopped: boolean; code?: string; hand?: number; text?: string;
  /** 聞き直し 1 回の分（費用・時間・使った量）。 */
  reask?: { ok: boolean; error?: string; costUsd: number; tEnd: number; usage: Usage4; answerTool: string | null };
}
export interface Row2 extends ResultRow {
  guard?: GuardInfo;
  /** 守りを通る前の 1 回目の答え（守った版の行だけ）。 */
  firstAnswer?: ResultRow['answer'];
  firstUsage?: Usage4; firstCostUsd?: number; firstTEnd?: number;
  r10?: { factsRows: number; urgentLines: number; lastResults: boolean };
  /** 1 回目の呼び出しを v4 と分け合った行（費用はその 1 回目の分を含むが、帳簿には聞き直しの分だけ）。 */
  sharedFirst?: string;
}
const done = new Set<string>();
const loaded: Row2[] = [];
if (existsSync(RESULTS2)) for (const line of readFileSync(RESULTS2, 'utf8').split('\n').filter(Boolean)) {
  const row = JSON.parse(line) as Row2;
  loaded.push(row);
  if (row.ok) done.add(`${row.variant}|${row.scene}|${row.rep}`);
}

const runs = loadAllRuns();
const infos = new Map<string, Frames>();
const frames = (key: string) => infos.get(key) ?? (infos.set(key, resultsByDecision(runs.get(key)!)), infos.get(key)!);
const bootstrapOf = (key: string, epoch: number): string | null => {
  if (epoch === 0) return null;
  const file = bootstrapFile(runs.get(key)!);
  if (!existsSync(file)) throw new Error(`DECISION_REPLAY_NO_BOOTSTRAP ${key} e${epoch}`);
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>)[epoch] ?? null;
};
const client = replayClient(apiKey);
const scenes = loadScenes().filter(scene => !wantedScenes || wantedScenes.includes(scene.id.split('-')[0]!))
  .map(scene => ({ scene, decision: decisionOf(runs, scene) }))
  .sort((a, b) => a.scene.run.localeCompare(b.scene.run) || a.decision.epoch - b.decision.epoch || a.decision.index - b.decision.index);

const GUESS: Record<string, number> = { v1: 0.12, v2: 0.11, v4: 0.11, v6: 0.13, v7: 0.06 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const usageOf = (result: CallResult): Usage4 => ({ input: result.usage.input, output: result.usage.output, cacheWrite: result.usage.cacheWrite, cacheRead: result.usage.cacheRead });

async function callWithRetry(variant: Variant, body: Record<string, any>, headers: Record<string, string>, kind: string, scene: string, rep: number, estimate: number): Promise<CallResult> {
  guard(estimate);
  let result = await callDecision(client, body, headers, variant.model, kind, `${scene} r${rep}`);
  if (!result.ok && (result.status === undefined || result.status === 429 || result.status >= 500 || result.error?.includes('overloaded'))) {
    console.log(`${kind} ${scene} r${rep} retry after: ${result.error}`);
    await sleep(8_000);
    result = await callDecision(client, body, headers, variant.model, kind, `${scene} r${rep}`);
  }
  return result;
}

function rowOf(variant: string, scene: string, rep: number, result: CallResult, requestChars: number): Row2 {
  const answer = answerOf(result.content);
  return { variant, scene, rep, ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.status ? { status: result.status } : {}),
    answer: { tool: answer.tool, input: answer.input, why: answer.why, shapeProblem: answer.shapeProblem }, stopReason: result.stopReason,
    usage: usageOf(result), costUsd: result.costUsd, tMessageStart: result.tMessageStart, tFirstBlock: result.tFirstBlock, tFirstToolInput: result.tFirstToolInput,
    tEnd: result.tEnd, transformations: result.inputTransformations.length, requestChars, at: new Date().toISOString() };
}
const save = (row: Row2) => {
  appendFileSync(RESULTS2, `${JSON.stringify(row)}\n`);
  if (row.ok) done.add(`${row.variant}|${row.scene}|${row.rep}`);
  console.log(`${row.variant} ${row.scene} r${row.rep} ${row.ok ? 'ok' : `NG ${row.error}`} ${row.answer.tool} ${(row.tEnd / 1000).toFixed(1)}s out=${row.usage.output} $${row.costUsd.toFixed(4)}`
    + `${row.guard ? ` guard=${row.guard.stopped ? `止 ${row.guard.code}` : '通'}` : ''} total $${spent().toFixed(3)}`);
};

/** 守り: 1 回目の答えにかけ、止めたら事実を返してもう 1 回聞く。守った版の行（最終の答え・合計の時間と費用）を返す。 */
async function guarded(variant: Variant, id: string, scene: string, rep: number, first: Row2, decision: Decision, request: Awaited<ReturnType<typeof buildRequest>>,
  rewrite: SceneRewrite, sharedFirst?: string): Promise<Row2> {
  const base: Row2 = { ...first, variant: id, firstAnswer: first.answer, firstUsage: first.usage, firstCostUsd: first.costUsd, firstTEnd: first.tEnd, ...(sharedFirst ? { sharedFirst } : {}) };
  if (!first.ok || first.answer.tool !== 'mc.act') return { ...base, guard: { stopped: false } };
  const frame = frameBefore(frames(decision.run.key), decision.index, decision.live);
  const stop = preflightAct(first.answer.input, { map: frame.map, feet: frame.feet });
  if (!stop) return { ...base, guard: { stopped: false } };
  const text = preflightText(stop);
  const useId = `toolu_replay_${scene.slice(0, 8)}_${rep}`;
  const live = (rewrite.turn ?? decision.turn).find(entry => entry.role === 'system')!;
  const extra: Entry[] = [{ role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'mc_act', input: first.answer.input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text, is_error: true }] }, { ...live }];
  const again = await buildRequest(variant, decision, decision.run.core, bootstrapOf(decision.run.key, decision.epoch), '5m', false, undefined, { ...rewrite, extra });
  const second = await callWithRetry(variant, again.body, again.headers, `replay-${id}-reask`, scene, rep, GUESS[variant.model.includes('sonnet') ? 'v7' : 'v4'] ?? 0.1);
  const row2 = rowOf(id, scene, rep, second, JSON.stringify(again.body).length);
  const sum = (a: Usage4, b: Usage4): Usage4 => ({ input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead });
  return { ...base, ok: row2.ok, ...(row2.error ? { error: row2.error } : {}), answer: row2.answer, stopReason: row2.stopReason, usage: sum(first.usage, row2.usage),
    costUsd: first.costUsd + row2.costUsd, tEnd: first.tEnd + row2.tEnd,
    guard: { stopped: true, code: stop.code, hand: stop.hand, text, reask: { ok: row2.ok, ...(row2.error ? { error: row2.error } : {}), costUsd: row2.costUsd, tEnd: row2.tEnd, usage: row2.usage, answerTool: row2.answer.tool } } };
}

async function chain(base: string): Promise<void> {
  const variant = VARIANTS.find(item => item.id === base)!;
  // v5 は v4 と同じ要求・同じ 1 回目の答え。聞き直しの要求の組み立て（版の設定）だけ v5 を使う。
  const guardVariant = base === 'v4' ? VARIANTS.find(item => item.id === 'v5')! : variant;
  const guardedId = base === 'v4' ? 'v5' : base;
  const rawId = base === 'v4' || !variant.preflight ? base : `${base}u`;
  let previous: (typeof scenes)[number] | undefined;
  for (const item of scenes) {
    const { scene, decision } = item;
    const info = frames(decision.run.key);
    const r10 = variant.r10 ? r10Input(decision, info) : null;
    const rewrite = r10 ? { rows: r10.rows, turn: r10.turn } : {};
    const run = decision.run;
    const request = await buildRequest(variant, decision, run.core, bootstrapOf(run.key, decision.epoch), '5m', false, previous?.decision, rewrite);
    previous = item;
    for (let rep = 1; rep <= reps; rep += 1) {
      const rawKey = `${rawId}|${scene.id}|${rep}`, guardedKey = `${guardedId}|${scene.id}|${rep}`;
      if (done.has(rawKey) && done.has(guardedKey)) continue;
      let first: Row2;
      if (done.has(rawKey)) first = loaded.filter(row => row.variant === rawId && row.scene === scene.id && row.rep === rep && row.ok).at(-1)!;
      else {
        const result = await callWithRetry(variant, request.body, request.headers, `replay-${rawId}`, scene.id, rep, GUESS[base] ?? 0.1);
        first = { ...rowOf(rawId, scene.id, rep, result, JSON.stringify(request.body).length), ...(r10 ? { r10: r10.notes } : {}) };
        save(first);
      }
      if (!done.has(guardedKey) && guardVariant.preflight) {
        const row = await guarded(guardVariant, guardedId, scene.id, rep, first, decision, request, rewrite, base === 'v4' ? 'v4' : undefined);
        save({ ...row, ...(r10 ? { r10: r10.notes } : {}) });
      }
    }
  }
}

if (process.argv[1]?.endsWith('run2.ts')) {
  console.log(`run2 start variants=${wanted.join(',')} reps=${reps} scenes=${scenes.length} spent $${spent().toFixed(3)} cap $${CAP}`);
  await Promise.all(wanted.map(base => chain(base)));
  console.log('done; spent $', spent().toFixed(3));
}
