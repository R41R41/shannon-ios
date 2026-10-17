import type Anthropic from '@anthropic-ai/sdk';
import { compactedDecision } from './anthropicFcaCompaction.js';

/**
 * The first `full` stored state of an epoch, shortened when the whole request is estimated above `maximum` tokens, exactly as a legacy
 * decision message is (`compactedDecision`: the longest texts cut to one common length, each cut marked, the task, messages, children and
 * the fixed rules whole). A later `changed` state is small and never cut. The message is stored as sent, so a later request that has
 * the uncut part in its state restates it (a change against what was stated).
 */
export function cappedState<S extends { message: Anthropic.MessageParam | null; full: boolean }>(state: S,
  requestTokens: (message: Anthropic.MessageParam) => number, maximum: number): { state: S; level: number | null } {
  const block = Array.isArray(state.message?.content) ? state.message!.content[0] : undefined;
  if (!state.full || !state.message || block?.type !== 'text') return { state, level: null };
  const row = JSON.parse(block.text) as Record<string, unknown>;
  const compacted = compactedDecision(row, requestTokens(state.message), maximum);
  if (compacted.level === null) return { state, level: null };
  const message: Anthropic.MessageParam = { role: 'user', content: [{ type: 'text', text: JSON.stringify(compacted.fields) }] };
  return { state: { ...state, message }, level: compacted.level };
}
