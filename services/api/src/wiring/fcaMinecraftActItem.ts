import type { PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../contracts/bodyControlContract.js';
import type { MadeIn } from '../contracts/continueContract.js';
import { actMilliseconds, type ActInput, type ActKeep } from '../contracts/minecraftActContract.js';
import { replaceOnly } from '../contracts/minecraftActShortContract.js';
import type { FcaExternalTools } from '../mind/action/fca/fcaPorts.js';
import type { KeptPromise } from '../mind/action/fca/fcaPlanTools.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { toolFailure, toolOk, type ToolResult } from '../mind/tools/toolRegistryPorts.js';
import type { MinecraftFeelingPort } from '../mind/emotion/minecraftFeeling.js';
import { conditionHolds, conditionText, conditionWords } from '../surfaces/minecraft/minecraftConditions.js';
import { feetOf } from '../surfaces/minecraft/minecraftLlmc.js';
import type { LlmcQueue } from '../surfaces/minecraft/minecraftLlmcQueue.js';
import { URGENT_TAG } from '../surfaces/minecraft/minecraftLlmcNode.js';
import { promiseKeptWords } from '../surfaces/minecraft/minecraftLlmcResultWords.js';
import { breakingWords } from '../surfaces/minecraft/minecraftLlmcPromises.js';
import { heldBeforeSendQueued } from '../surfaces/minecraft/minecraftLlmcQueueSend.js';
import type { BeforeSend } from '../surfaces/minecraft/minecraftLlmcPartial.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';

/**
 * `mc.act` as an item of the task queue (design minebot-task-queue): the act goes to the body at once and the tool returns when the body has it,
 * with where it stands in the queue; the act's own result comes later, as news in the history (`fcaRunner.ts`). A `pre` that the newest frame
 * shows unmet, for an item that would start at once (an empty queue), is not sent and the fact comes back (no round trip to the body).
 */
type Call = Parameters<FcaExternalTools['execute']>[0];

export async function sendItem(parts: { queue: LlmcQueue; control: MinecraftControl; bodyId: string; call: Call; skill: string;
  fixes: readonly string[]; node: string | null; current?: string | null; frame: BodyObservation | null;
  /** Continue contract 5: the observation the decision that chose this act read (its life, dimension, body and connection): the item carries it, not the newest frame's. */
  madeIn?: MadeIn | null;
  /** Amendment A-7 1: an entry of the act's `keep` put to the plan as a promise (`FcaPlanPort.keepPromise`). Absent: the plan cannot take it, and the result says so. */
  keep?(entry: ActKeep): KeptPromise | { problem: string };
  /** Amendment A-8 2: the plan's promises now (what an act that would spend them is told once, nothing refused). */
  promises?(): readonly PlanPromise[] }): Promise<ToolResult> {
  const { queue, call } = parts, input = call.input as ActInput;
  // `pre` and `replace` are the head's (the envelope carries `pre`), and so are `dependsOn` (the envelope), `uses` (kept with the command, never sent to the body) and `keep`
  // (made into promises of the plan below, once the queue has the act).
  const { pre, replace: _replace, dependsOn: _dependsOn, uses: _uses, keep, ...args } = input;
  const fixes = parts.fixes.length ? `（頭が形を直して送った: ${parts.fixes.join('、')}）\n` : '';
  if (pre && !queue.open() && conditionHolds(pre, parts.frame) === false) {
    const words = conditionWords(pre, parts.frame);
    return toolFailure('refused', `${fixes}送らなかった: 前提 ${conditionText(pre)} を今は満たさない${words ? `（${words}）` : ''}。体には何も送っていない`,
      { retryable: true });
  }
  const node = parts.node && parts.node !== URGENT_TAG ? parts.node : null;
  const added = await queue.add({ call: { id: call.operationId, name: call.name, input: call.input }, operationId: call.operationId, input,
    arguments: args as Record<string, unknown>, skill: parts.skill, ...(pre ? { pre } : {}), node, current: parts.current ?? null,
    why: String(input.why ?? ''), fixes: [], ...(parts.madeIn !== undefined ? { madeIn: parts.madeIn } : {}),
    maxMs: actMilliseconds(input, feetOf(parts.control.observe(parts.bodyId))) });
  if (!added.ok) return toolFailure('refused', `${fixes}${added.text}`, { retryable: true });
  const place = added.after ? `${added.after} の後` : '列は空だった。体はすぐ動く';
  // Amendment A-7 1: the act is in the queue; what it said to keep becomes promises (an open one of the same item and use is revised). Not put into the act's `uses`.
  const kept = (keep ?? []).map(entry => promiseKeptWords(entry, parts.keep ? parts.keep(entry) : { problem: 'この判断の計画には約束を書けない' }));
  // Amendment A-8 2: what the act would spend of the promised is said once, after the line of the queue (nothing is refused).
  const breaking = parts.promises ? breakingWords(parts.promises(), input.hands, parts.frame) : [];
  return toolOk([`${fixes}列に入れた ${added.item}（${place}。始まりの期限 +${Math.round(added.startInMs / 1000)} 秒）`, ...kept, ...breaking].join('\n'));
}

/** An input of nothing but `replace`: the items are taken off and that is the whole answer; null for any other input. */
export async function replacedOnly(queue: LlmcQueue, input: unknown): Promise<ToolResult | null> {
  const ids = replaceOnly(input);
  return ids ? toolOk(await queue.replace(ids)) : null;
}

/**
 * What goes before an act is sent: the items it replaces are taken off (said first in whatever the tool answers), and the guards read its hands after the
 * hands of the items ahead of it (`heldBeforeSendQueued`). `led` puts the replace's words before a result.
 */
export async function actGuards(parts: { queue: LlmcQueue; urgent: boolean; input: ActInput; frame: BodyObservation | null; taskId: string }):
  Promise<{ hold: BeforeSend | null; led(result: ToolResult): ToolResult }> {
  const lead = parts.input.replace?.length ? await parts.queue.replace(parts.input.replace) : null;
  const hold = heldBeforeSendQueued(parts.urgent, parts.input, parts.frame, parts.taskId, parts.queue.ahead());
  return { hold, led: result => lead ? { ...result, text: `${lead}\n${result.text}` } : result };
}

/** Owner 2026-10-26: each act the body ran is handed to her feeling when it ends (the queue tells it). */
export function feelWhenItsDone(queue: LlmcQueue, feelings: MinecraftFeelingPort, step: TaskStep): void {
  queue.onRan(({ call, why }, result) => feelings.noted({ scopeKey: step.scopeKey, taskId: step.taskId, goal: step.snapshot.task.goal,
    why: String((call.input as { why?: unknown } | null)?.why ?? why), ok: result.ok, reflex: result.bodyReflex === true,
    progressed: result.progressed === true, outcome: result.text.split('\n').find(text => !text.startsWith('（頭が形を直して')) ?? '' }));
}
