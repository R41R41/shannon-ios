import type Anthropic from '@anthropic-ai/sdk';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import { cacheFcaBodyRequest } from './anthropicFcaBodyCache.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import { HAIKU_PROTOCOL_PREFIX } from './haikuCache.js';
import { cutToFit, type Levels } from './anthropicFcaStateCut.js';
import { stateMessage, storedState } from './anthropicFcaStoredState.js';
import { clearAtMessage, FCA_TRANSIENT_THINKING, liveObject, liveSkillCounts, renderedRequest } from './anthropicFcaTransient.js';

/**
 * A transient body task's request (`anthropicFcaTransient.ts`): what changed in the task's state, as a stored user text; the tool
 * changes; then this turn's live state in a turn-scoped system message, last. The explicit 1h breakpoints only (`cacheFcaBodyRequest`).
 * The stored round is the turn as sent, so the next request extends it byte for byte, the earlier live states included.
 *
 * Size: as for a legacy decision message, nothing is cut unless the WHOLE request (core, replay, this step's state, the tool additions
 * and the live state) is estimated above `compactAboveTokens`; then `cutToFit` shortens descriptions, then other long texts, never a
 * name or the skill index (`anthropicFcaStateCut.ts`). A part that was cut earlier is stated whole again as soon as the request fits.
 *
 * Known limit (review 4): a tool opened by `tool_open` is declared in this turn's `tool_addition`, one block for each tool (up to dozens),
 * between the last stored block of the previous request and this one's. The cache looks back about 20 blocks for the earlier write, so
 * that request may write the history again once. Watch `in.write` of the decision after a `tool_open` in the first supervised run
 * (`fca_decision_metrics`) before relying on it.
 */
export function transientRequest(parts: { model: string; maximumOutputTokens: number; compactAboveTokens: number; systemText: string;
  input: FcaModelInput; supplied: Record<string, unknown>; history: readonly Anthropic.MessageParam[];
  menu: { tools: Anthropic.Tool[]; appended: Anthropic.MessageParam[] } }) {
  const { model, input, supplied, history, menu } = parts, maximum = parts.compactAboveTokens;
  const hour = { type: 'ephemeral' as const, ttl: '1h' as const };
  const system = [{ type: 'text' as const, cache_control: hour, text: parts.systemText }];
  // The whole request as it would be sent with this state and this live state (the way a legacy decision measured its body).
  const turnOf = (row: Record<string, unknown>, live: Record<string, unknown>, full: boolean) =>
    [...[stateMessage(row, full)].filter((message): message is Anthropic.MessageParam => message !== null), ...menu.appended, clearAtMessage(JSON.stringify(live))];
  const fixed = { model, max_tokens: parts.maximumOutputTokens, tools: menu.tools, tool_choice: { type: 'auto' as const },
    thinking: FCA_TRANSIENT_THINKING, output_config: { effort: 'low' as const } };
  // The request as sent: the transport protocol's prefix comes before the system text (`cacheFcaBodyRequest`).
  // 64 tokens for the cache marker the last stored block gets (`cacheFcaBodyRequest`), which this estimate does not carry.
  const cost = (row: Record<string, unknown>, live: Record<string, unknown>, full: boolean) => 64 + estimatedAnthropicTokens(renderedRequest({ ...fixed,
    system: [{ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: hour }, ...system], messages: [...history, ...turnOf(row, live, full)] }));
  const live = liveObject(supplied, input.transient);
  let stored = storedState(supplied, history);
  let deferred = false;
  if (stored.hasCut) {
    // A part cut earlier is stated whole again as soon as the request fits with it. While the cut copy is in the replay the whole one may
    // not fit beside it: that is reported like a cut (`stateCut`), so that the next epoch (whose first state is whole) starts sooner.
    const whole = storedState(supplied, history, true);
    if (cost(whole.row, live, whole.full) <= maximum) stored = whole;
    else deferred = true;
  }
  const fitted = cutToFit(stored.row, live, (row, next) => cost(row, next, stored.full), maximum);
  const compacted = fitted.cut;
  if (compacted) logCut(model, maximum, fitted.levels, fitted.over);
  const turn = turnOf(fitted.row, fitted.live, stored.full);
  const body = cacheFcaBodyRequest({ model, max_tokens: parts.maximumOutputTokens, system, messages: [...history, ...turn], tools: menu.tools,
    tool_choice: { type: 'auto' as const }, thinking: FCA_TRANSIENT_THINKING, output_config: { effort: 'low' as const },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const counts = liveSkillCounts(input.transient), levels = Object.values(fitted.levels).filter((level): level is number => level !== null);
  const built = { taskId: input.task.id, bodyAttached: input.body !== undefined, level: levels.length ? Math.min(...levels) : null,
    elidedParts: [] as string[], ...counts, sent: { ...counts, parts: stored.parts, cut: compacted || deferred } };
  return { turn, body, built };
}

/** What was cut, content-free: the level of each stage (null: not cut) and whether even the floor left the request over. */
function logCut(model: string, maximum: number, levels: Levels, over: boolean): void {
  console.info(JSON.stringify({ event: 'fca_request_compacted', model, maximumTokens: maximum, transient: true, catalog: levels.catalog, state: levels.state,
    live: levels.live, over }));
}
