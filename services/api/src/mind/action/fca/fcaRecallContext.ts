import { createHash } from 'node:crypto';
import { OWNER_AUDIENCE, isMemoryInquiry } from '@shannon/cognition';
import type { TaskRecallInput } from '../../recall/taskRecallPorts.js';
import type { TaskStep } from '../taskRuntime/taskRuntimePorts.js';

/** Refresh only when the goal, admitted input, progress or outcome changes, not on every scheduler tick. */
export function fcaRecallContext(step: TaskStep, prior: Record<string, unknown>, signal: AbortSignal) {
  const old = prior.fcaRecallInput;
  const previous = old && typeof old === 'object' ? old as { messages?: unknown } : {};
  const messages = step.snapshot.messages.length ? step.snapshot.messages.slice(-8).map(message => ({ id: message.id, text: message.text.slice(0, 700) }))
    : Array.isArray(previous.messages) ? previous.messages : [];
  const selection = prior.fcaToolSelection as { recentResults?: unknown } | undefined;
  const context = { goal: step.snapshot.task.goal, criteria: step.snapshot.task.completionCriteria,
    progress: step.snapshot.task.summary, messages, results: selection?.recentResults ?? [] };
  const serialized = JSON.stringify(context);
  const contextVersion = createHash('sha256').update(serialized).digest('hex');
  const cue = [step.snapshot.task.goal.slice(0, 1400), step.snapshot.task.summary.slice(0, 500), JSON.stringify(messages).slice(0, 1400), JSON.stringify(context.results).slice(0, 600)].join('\n').slice(0, 4000);
  // Only a decision that waits for enrichment starts it (`TaskRecallInput.semantic`); the deterministic recall is always given.
  const inquiry = isMemoryInquiry(cue);
  const input: TaskRecallInput = { scopeKey: step.scopeKey, taskId: step.taskId, contextVersion, cue, present: OWNER_AUDIENCE, signal, semantic: inquiry };
  return { input, checkpoint: { messages }, waitMilliseconds: inquiry ? 1500 : 0 };
}
