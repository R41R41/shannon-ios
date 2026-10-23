import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { answerOf } from './checks.js';
import { callDecision, type CallResult } from './call.js';
import { loadAllRuns, dataFile } from './allRuns.js';
import { bootstrapFile } from './bootstrap.js';
import { candFixed, candFrame, candRows, candTurn, candidateAct } from './candidateAdapter.js';
import { CAP, guard, spent } from './ledger.js';
import { candidateInput } from '../../src/surfaces/minecraft/minecraftLlmcV2.js';
import { frames, scenesFor } from './sceneSet.js';
import { markCache, replayClient, sceneMessages } from './request.js';
import { readRows, latest } from './views5.js';
import type { Entry } from './load.js';
import type { Row2, Usage4 } from './run2.js';

/**
 * 10/23 の 4 つ目の比べ: 候補の版（cand）を回す。基準 v1 と同じ場面・同じ回数（v1 が 3 回の場面は 3 回、2 回の場面は 2 回）。
 *   node --import tsx tests/decisionReplay/run6.ts [--scenes=s01,s36] [--reps=3] [--out=results6.jsonl] [--dry]
 * 要求: system 2 ブロックと道具 6 つは候補の頭が作る（candidateFixed）、履歴は記録の履歴の過去の act を短い書き方の行に直した物、最後の live は candidateLive。
 * 答えは候補の頭の変換（candidateAct: 短い書き方の戻し → 形 → stopIf の点検 → 守り）を通す。守りが止めたら、事実を tool_result で返して 1 回だけ聞き直す。
 *  - 全部止めた（手 1 で止めた）: 聞き直しの答えを最終の答えとして採点する（また止まる物でも、そのまま）。
 *  - 部分送り（手 k で止めた）: 手 1…k-1 は送った扱い。結果は「手 1…k-1 は送った」+ 候補が作る「手 k から先は送っていない」の文を tool_result で返し、
 *    1 回だけ聞き直す。最終の答えは「送った前の手 + 聞き直しの答えの手」の組（聞き直しが mc.act でなければ、送った前の手だけ）。
 * 呼び出しは DECISION_REPLAY_LEDGER に数え、上限 DECISION_REPLAY_CAP を超える前に止まる。
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const dry = args.includes('--dry');
export const RESULTS6 = dataFile(flag('out') ?? 'results6.jsonl');
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY ?? '';
if (!apiKey && !dry) throw new Error('SHANNON_ANTHROPIC_API_KEY');
const VARIANT = flag('variant') ?? 'cand';
const MODEL = 'claude-opus-5-5';

export interface Sent6 { tool: string | null; input: unknown; fixes: string[]; problem: string | null; changed: boolean;
  guard?: { stopped: boolean; hand?: number; sentHands?: number; code?: string; text?: string; reask?: string }; combined?: boolean }
export interface Row6 extends Row2 {
  /** 候補の頭の変換を通した最終の答え（採点する物）。`answer` はモデルの最終の答えを JSON の手に戻しただけの物（変換なし）。 */
  sent: Sent6;
  /** 1 回目のモデルの答え（短い書き方のまま）。 */
  rawFirst?: unknown;
  /** 最終の答えが聞き直しの答えの時、その短い書き方のまま。 */
  rawFinal?: unknown;
}

const runs = loadAllRuns();
const read = (name: string): Row6[] => existsSync(dataFile(name)) ? readFileSync(dataFile(name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Row6) : [];
const have = (scene: string) => read(flag('out') ?? 'results6.jsonl').filter(row => row.variant === VARIANT && row.scene === scene && row.ok);
const v1Reps = new Map<string, number>();
for (const row of latest(readRows())) if (row.variant === 'v1') v1Reps.set(row.scene, Math.max(v1Reps.get(row.scene) ?? 0, row.rep));
const scenes = scenesFor(runs, flag('scenes')?.split(','));
const client = dry ? null : replayClient(apiKey);
const bootstrapOf = (key: string, epoch: number): string | null => {
  if (epoch === 0) return null;
  const file = bootstrapFile(runs.get(key)!);
  if (!existsSync(file)) throw new Error(`DECISION_REPLAY_NO_BOOTSTRAP ${key} e${epoch}`);
  return (JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>)[epoch] ?? null;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const GUESS = 0.08;
const sumUsage = (a: Usage4, b: Usage4): Usage4 => ({ input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead });
const usageOf = (result: CallResult): Usage4 => ({ input: result.usage.input, output: result.usage.output, cacheWrite: result.usage.cacheWrite, cacheRead: result.usage.cacheRead });

type Item = (typeof scenes)[number];
async function build(item: Item, previous: Item | undefined, extra: Entry[] = []) {
  const { decision } = item;
  const fixed = await candFixed(decision.run.core);
  const { turn, notes } = candTurn(decision);
  const rows = candRows(decision);
  const { messages } = sceneMessages(decision, bootstrapOf(decision.run.key, decision.epoch), false, { rows, turn, extra });
  const alsoAt = previous && previous.decision.run === decision.run && previous.decision.epochStart === decision.epochStart && previous.decision.index < decision.index
    ? sceneMessages(previous.decision, bootstrapOf(decision.run.key, decision.epoch), false, { rows: candRows(previous.decision), turn: candTurn(previous.decision).turn }).messages.length - 2 : undefined;
  const body = markCache({ ...fixed.fixed, model: MODEL, messages } as Record<string, any>, '5m', alsoAt);
  return { body, headers: fixed.headers, notes, live: turn.find(entry => entry.role === 'system')! };
}

async function call(body: Record<string, any>, headers: Record<string, string>, kind: string, note: string): Promise<CallResult> {
  guard(GUESS);
  let result = await callDecision(client!, body, headers, MODEL, kind, note);
  if (!result.ok && (result.status === undefined || result.status === 429 || result.status >= 500 || result.error?.includes('overloaded'))) {
    console.log(`${kind} ${note} retry after: ${result.error}`);
    await sleep(8_000);
    result = await callDecision(client!, body, headers, MODEL, kind, note);
  }
  return result;
}

/** モデルの答え（短い書き方）→ 道具の名前と入力（JSON の手）。 */
function expanded(result: CallResult) {
  const use = result.content.find(block => block.type === 'tool_use');
  const content = result.content.map(block => block.type === 'tool_use' && block.name === 'mc_act' ? { ...block, input: candidateInput('mc.act', block.input) } : block);
  const answer = answerOf(content);
  return { use, answer, tool: answer.tool, rawInput: use?.input };
}

async function chain(): Promise<void> {
  let previous: Item | undefined;
  for (const item of scenes) {
    const { scene, decision } = item;
    const want = flag('reps') ? Number(flag('reps')) : v1Reps.get(scene.id) ?? 2;
    const first = await build(item, previous);
    previous = item;
    const doneReps = new Set(have(scene.id).map(row => row.rep));
    if (dry) {
      console.log(VARIANT, scene.id.slice(0, 3), 'chars', JSON.stringify(first.body).length, 'tools', first.body.tools.length, 'need', Math.max(0, want - doneReps.size));
      continue;
    }
    const info = frames(runs, decision.run.key);
    for (let rep = 1; rep <= want; rep += 1) {
      if (doneReps.has(rep)) continue;
      const taskId = `replay-${scene.id}-${rep}`;
      const firstResult = await call(first.body, first.headers, 'replay-cand', `${scene.id} r${rep}`);
      const one = expanded(firstResult);
      const frame = candFrame(decision, info);
      let usage = usageOf(firstResult), cost = firstResult.costUsd, tEnd = firstResult.tEnd, ok = firstResult.ok, error = firstResult.error;
      let final = one, finalResult = firstResult;
      let sent: Sent6;
      const act = one.tool === 'mc.act' && one.use ? candidateAct(one.rawInput, frame, taskId) : null;
      if (!act) sent = { tool: one.tool, input: one.answer.input, fixes: [], problem: one.tool ? null : '道具の呼び出しが無い', changed: false };
      else sent = { tool: 'mc.act', input: act.input, fixes: act.fixes, problem: act.problem, changed: JSON.stringify(act.input) !== JSON.stringify(one.answer.input),
        ...(act.guard ? { guard: { stopped: act.guard.stopped, hand: act.guard.hand, sentHands: act.guard.sentHands, code: act.guard.code, text: act.guard.text } } : {}) };
      let rawFinal: unknown;
      if (firstResult.ok && act && !act.problem && act.guard) {
        const useId = String(one.use!.id);
        const partial = !act.guard.stopped;
        // 部分送りの文（候補が作る）は、送った手と送った後の足の見積もりを自分で言う。体の実際の結果の行は台に無い。
        const resultText = act.guard.text;
        const extra: Entry[] = [{ role: 'assistant', content: [{ type: 'tool_use', id: useId, name: 'mc_act', input: one.rawInput }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: resultText, is_error: true }] }, { ...first.live }];
        const again = await build(item, undefined, extra);
        const second = await call(again.body, again.headers, 'replay-cand-reask', `${scene.id} r${rep}`);
        usage = sumUsage(usage, usageOf(second)); cost += second.costUsd; tEnd += second.tEnd;
        const two = expanded(second);
        rawFinal = two.rawInput;
        const act2 = two.tool === 'mc.act' && two.use ? candidateAct(two.rawInput, frame, taskId) : null;
        ok = second.ok; error = second.error; final = two; finalResult = second;
        const guardInfo = { stopped: act.guard.stopped, hand: act.guard.hand, sentHands: act.guard.sentHands, code: act.guard.code, text: act.guard.text,
          reask: two.tool ?? 'none' };
        if (partial) {
          const sentPart = (act.input as { hands: unknown[] }).hands;
          // 送った前の手 + 聞き直しの答えの手（聞き直しが mc.act なら、その手を体の最新の状態から続ける物として）。
          if (act2 && !act2.problem) {
            const tail = (act2.input as { hands?: unknown[] }).hands ?? [];
            sent = { tool: 'mc.act', input: { ...(act2.input as object), hands: [...sentPart, ...tail] }, fixes: [...act.fixes, ...act2.fixes], problem: null, changed: true, combined: true, guard: guardInfo };
          } else sent = { tool: 'mc.act', input: act.input, fixes: act.fixes, problem: act2?.problem ?? null, changed: true, combined: true, guard: guardInfo };
        } else if (act2) {
          sent = { tool: 'mc.act', input: act2.input, fixes: act2.fixes, problem: act2.problem, changed: true, guard: { ...guardInfo, ...(act2.guard ? { stoppedAgain: true } : {}) } as never };
        } else sent = { tool: two.tool, input: two.answer.input, fixes: [], problem: two.tool ? null : '道具の呼び出しが無い', changed: true, guard: guardInfo };
      }
      const row: Row6 = { variant: VARIANT, scene: scene.id, rep, ok, ...(error ? { error } : {}),
        answer: { tool: final.tool, input: final.answer.input, why: final.answer.why, shapeProblem: final.answer.shapeProblem }, stopReason: finalResult.stopReason, usage, costUsd: cost,
        tMessageStart: firstResult.tMessageStart, tFirstBlock: firstResult.tFirstBlock, tFirstToolInput: firstResult.tFirstToolInput, tEnd, transformations: firstResult.inputTransformations.length,
        requestChars: JSON.stringify(first.body).length, at: new Date().toISOString(), sent, rawFirst: one.rawInput, ...(rawFinal !== undefined ? { rawFinal } : {}),
        firstUsage: usageOf(firstResult), firstCostUsd: firstResult.costUsd, firstTEnd: firstResult.tEnd };
      appendFileSync(RESULTS6, `${JSON.stringify(row)}\n`);
      if (row.ok) doneReps.add(rep);
      console.log(`${VARIANT} ${scene.id} r${rep} ${row.ok ? 'ok' : `NG ${row.error}`} ${one.tool} ${(tEnd / 1000).toFixed(1)}s out=${usage.output} $${cost.toFixed(4)} ${sent.guard ? `guard=${sent.guard.stopped ? '全止' : `部分${sent.guard.sentHands}`}→${sent.guard.reask}` : ''} total $${spent().toFixed(3)}`);
    }
  }
}
if (process.argv[1]?.endsWith('run6.ts')) {
  console.log(`run6 start scenes=${scenes.length} spent $${spent().toFixed(3)} cap $${CAP}${dry ? ' DRY' : ''}`);
  await chain();
  console.log('done; spent $', spent().toFixed(3));
}
