import type Anthropic from '@anthropic-ai/sdk';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import { cacheFcaBodyRequest } from './anthropicFcaBodyCache.js';
import { FCA_STATE_LIMIT } from './anthropicFcaStateCap.js';
import { clearAtMessage, FCA_TRANSIENT_THINKING, liveSkillCounts, liveState, storedState } from './anthropicFcaTransient.js';

/**
 * A transient body task's request (`anthropicFcaTransient.ts`): what changed in the task's state, as a stored user text; the tool
 * changes; then this turn's live state in a turn-scoped system message, last. The explicit 1h breakpoints only (`cacheFcaBodyRequest`).
 * The stored round is the turn as sent, so the next request extends it byte for byte, the earlier live states included. The epoch's
 * first full state is shortened above the threshold as a legacy decision message is (`anthropicFcaStateCap.ts`).
 *
 * Known limit (review 4): a tool opened by `tool_open` is declared in this turn's `tool_addition`, one block for each tool (up to dozens),
 * between the last stored block of the previous request and this one's. The cache looks back about 20 blocks for the earlier write, so
 * that request may write the history again once. Watch `in.write` of the decision after a `tool_open` in the first supervised run
 * (`fca_decision_metrics`) before relying on it.
 */
export function transientRequest(parts: { model: string; maximumOutputTokens: number; systemText: string;
  input: FcaModelInput; supplied: Record<string, unknown>; history: readonly Anthropic.MessageParam[];
  menu: { tools: Anthropic.Tool[]; appended: Anthropic.MessageParam[] } }) {
  const { model, input, supplied, history, menu } = parts;
  const system = [{ type: 'text' as const, cache_control: { type: 'ephemeral' as const, ttl: '1h' as const }, text: parts.systemText }];
  const live = clearAtMessage(liveState(supplied, input.transient));
  const turnOf = (state: Anthropic.MessageParam | null) => [...(state ? [state] : []), ...menu.appended, live];
  // A stored state above its limit is cut and marked, a first `full` and a `changed` one alike (`anthropicFcaStateCap.ts`).
  const state = storedState(supplied, history, FCA_STATE_LIMIT);
  if (state.level !== null) {
    console.info(JSON.stringify({ event: 'fca_request_compacted', model, level: state.level, maximumTokens: FCA_STATE_LIMIT.maximumTokens, transient: true }));
  }
  const turn = turnOf(state.message);
  const body = cacheFcaBodyRequest({ model, max_tokens: parts.maximumOutputTokens, system, messages: [...history, ...turn], tools: menu.tools,
    tool_choice: { type: 'auto' as const }, thinking: FCA_TRANSIENT_THINKING, output_config: { effort: 'low' as const },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const counts = liveSkillCounts(input.transient);
  const built = { taskId: input.task.id, bodyAttached: input.body !== undefined, level: state.level, elidedParts: [] as string[], ...counts,
    sent: { ...counts, parts: state.parts } };
  return { turn, body, built };
}
