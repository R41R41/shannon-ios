import type Anthropic from '@anthropic-ai/sdk';

/** The receipt `AnthropicFcaModel.decide` appends for a wait or a completion (`{"received":true,"requestedDecision":…}`). */
const RECEIPT = '{"received":true,"requestedDecision":';

/**
 * mb-llmc r5 (`FcaCompletionMistake.amend`): the native message that answers a wait or a completion, with `text` in place of its receipt,
 * as an error; null when `turn` is not one (or `text` is empty). The rest of the message stays as it was.
 */
export function amendAnthropicControl(turn: unknown, text: string): Anthropic.MessageParam | null {
  const message = turn && typeof turn === 'object' && !Array.isArray(turn) ? turn as { role?: unknown; content?: unknown } : null;
  if (message?.role !== 'user' || !Array.isArray(message.content) || typeof text !== 'string' || !text.trim()) return null;
  const blocks = message.content as Anthropic.ContentBlockParam[];
  const index = blocks.findIndex(block => block?.type === 'tool_result' && typeof block.content === 'string' && block.content.startsWith(RECEIPT));
  if (index < 0) return null;
  const content = [...blocks];
  content[index] = { ...(blocks[index] as Anthropic.ToolResultBlockParam), content: text, is_error: true };
  return { role: 'user', content };
}

/** With `waiting` (`fcaWaitGate.ts`): nobody can answer the task, so a wait waits for nothing. Data for the decision, never her words. */
export const FCA_WAIT_RULE = 'Nobody can send this task a message or answer a question: it has no unfinished child task and whoever handed it over '
  + 'cannot reply. fca_wait is turned away until refusedWaits reaches refusalLimit; a wait after that stops the task. '
  + 'Continue toward the goal with the offered tools, or use fca_complete once the completion criteria are met.';
/** mb-llmc r6 (`waits: 'answered'`, `FcaWaitAnswer`): a wait is answered with what there is to wait for, and never stops the task. */
export const FCA_WAIT_ANSWERED_RULE = 'Nobody can send this task a message or answer a question. fca_wait never stops this task: it is answered in '
  + 'one line with what there is to wait for in the world (a furnace, health coming back), or that there is nothing, and the task goes on.';
/** The rule that goes with a wait fact (the decision's `waiting`). */
export function fcaWaitRule(waiting: object): string { return 'waits' in waiting ? FCA_WAIT_ANSWERED_RULE : FCA_WAIT_RULE; }
