import type { TaskRuntime, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaQueueNews, FcaQueueWake } from './fcaPorts.js';
import { failureRefreshes } from './fcaToolState.js';
import type { FcaStepPorts } from './fcaRunner.js';
import { resultSummary, type RoundContext, type RoundOutcome } from './fcaToolRound.js';

/**
 * A step that goes on while the body works through its queue (design minebot-task-queue, 2026-10-26; `FcaBodyLifecycle.queue`). The step does not
 * end after one decision: while items are open it waits, with no model call, until the running one has `T` seconds left (`FcaBodyQueue.ready`), then
 * decides again from the history so far, and it commits only when no item is open. This file is what the step does between two decisions: the wait,
 * and the results of the items that ended meanwhile (news), which stand in the history once, at the end of the round they came during.
 */
export const FCA_STRETCH = Object.freeze({ maxDecisions: 10, maxMs: 180_000 });
export const NEWS_HEAD = '（列の知らせ）';

/** What the step does after a round's calls: wait for the queue to ask for a decision, or to run dry. `continuing`: decide again, items still open. */
export async function waitForQueue(parts: { ports: FcaStepPorts; signal: AbortSignal; runtime: TaskRuntime; step: TaskStep; tools: boolean;
  stale: boolean; round: number; startedAt: number }): Promise<{ continuing: boolean; wake: FcaQueueWake | null }> {
  const queue = parts.ports.body?.queue;
  if (!queue) return { continuing: false, wake: null };
  if (parts.stale) queue.cancelAll();
  const messages = () => (parts.runtime.pendingMessageIds?.(parts.step.scopeKey, parts.step.taskId) ?? []).some(id => !parts.step.messageIds.includes(id));
  const alert = () => { try { return parts.ports.body?.alert?.() === true; } catch { return false; } };
  const drain = parts.round >= FCA_STRETCH.maxDecisions || Date.now() - parts.startedAt >= FCA_STRETCH.maxMs;
  let wake: FcaQueueWake = 'empty';
  if (queue.open() && parts.tools && !parts.stale) wake = await queue.ready({ signal: parts.signal, drain, messages, alert });
  // Words from the owner: what waits is taken off, the running item goes on, and the step ends once it has (the message is the next step's).
  if (wake === 'message') queue.dropWaiting();
  // Continue contract 4: a reflex that hit its cap is a reason to decide now, with items still open (the decision may replace them).
  const continuing = wake === 'remaining' || wake === 'alert' || wake === 'reflex_capped';
  // Not deciding again: whatever is still open runs out first (a step is committed with no item unsettled).
  if (!continuing && queue.open()) await queue.ready({ signal: parts.signal, drain: true });
  return { continuing, wake };
}

/**
 * The items that ended since the last look, settled as a call's result is (the body's notes, the progress, the stored text, the failure ladder's
 * outcomes), and their words for the history. An item the body never ran, or that the head took off, is told and counts for nothing.
 */
export function settleNews(ctx: RoundContext, news: readonly FcaQueueNews[]): { text: string; outcomes: RoundOutcome[] } {
  const { ports, selection, metrics } = ctx;
  const outcomes: RoundOutcome[] = [], lines: string[] = [];
  for (const entry of news) {
    const { call, result, operationId } = entry;
    let text = result.text;
    if (entry.kind === 'ran') {
      ctx.progress({ operationId, tool: call.name, status: result.ok ? 'received' : 'failed' });
      ports.body?.noteResult?.(call, result, entry.ms);
      ports.tools?.progress?.observed(operationId, call.name, result);
      if (selection?.obsMode === 'transient' && ports.body?.storedResult) text = ports.body.storedResult(call, result.text);
      if (selection) {
        if (!result.ok && failureRefreshes(selection, call.name)) selection.refresh = true;
        selection.recentResults = [...selection.recentResults, { name: call.name, ok: result.ok, summary: resultSummary(result.text) }].slice(-8);
      }
      outcomes.push({ name: call.name, ok: result.ok || (ctx.bodyTask && result.progressed === true), cut: result.bodyReflex === true, read: false });
      metrics.tool(`${call.name}:news`, entry.ms);
    } else ctx.progress({ operationId, tool: call.name, status: 'failed' });
    lines.push(`${entry.label}: ${text}`);
  }
  return { text: lines.length ? `${NEWS_HEAD}\n${lines.join('\n')}` : '', outcomes };
}
