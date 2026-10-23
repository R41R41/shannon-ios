import type Anthropic from '@anthropic-ai/sdk';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import { cacheFcaBodyRequest } from './anthropicFcaBodyCache.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import { HAIKU_PROTOCOL_PREFIX } from './haikuCache.js';
import { cutToFit, LIVE_TYPICAL_TOKENS, type CutResult } from './anthropicFcaStateCut.js';
import { stateMessage, storedState } from './anthropicFcaStoredState.js';
import { clearAtMessage, FCA_TRANSIENT_THINKING, isFcaClearAtMessage, liveObject, liveSkillCounts, renderedRequest, storedFields }
  from './anthropicFcaTransient.js';

/** The room (estimated tokens) one more round takes in the replay: its calls, their stored results and the answer's blocks. */
export const FCA_TRANSIENT_ROUND_TOKENS = 4_000;
/** What a summary's bootstrap takes of a new epoch's replay (`FCA_BODY_HISTORY_POLICY` compacts down to 8,000). */
export const FCA_TRANSIENT_BOOTSTRAP_TOKENS = 8_000;
/** What a typical live state takes of a new epoch's first request. */
export const FCA_TRANSIENT_LIVE_TOKENS = LIVE_TYPICAL_TOKENS;

/**
 * How a request was shortened, content-free (`fca_decision_metrics.cut`, `fca_request_compacted`). Levels are characters, except `trim`:
 * the level (1 to 5) of the live state's structure left out (`anthropicFcaLiveTrim.ts`); null: not cut.
 */
export interface CutStages {
  catalog: number | null; state: number | null; live: number | null; trim: number | null;
  /** Even the floor left the request over `compactAboveTokens`. */
  over: boolean;
  /** The replay bound could not be kept (even names only left no room for another step), so only the request bound was. */
  replayRelaxed: boolean;
  /** A part cut earlier could not be restated whole in this request. */
  deferred: boolean;
  /** The parts and the catalog items this state names as cut (`capped`, `cappedCatalog`). */
  parts: number; items: number;
}

/**
 * A transient body task's request (`anthropicFcaTransient.ts`): what changed in the task's state, as a stored user text; the tool
 * changes; then this turn's live state in a turn-scoped system message, last. The explicit 1h breakpoints only (`cacheFcaBodyRequest`).
 * The stored round is the turn as sent, so the next request extends it byte for byte, the earlier live states included.
 *
 * Size: as for a legacy decision message, nothing is cut unless the WHOLE request (core, replay, this step's state, the tool additions
 * and the live state) is estimated above `compactAboveTokens`; then `cutToFit` first lets a live spike give way (its long texts down to the 400-character
 * floor, then the farther entities and later facts, down to a typical live state), then shortens descriptions, then other long texts, never a name or
 * the skill index (`anthropicFcaStateCut.ts`). One more bound holds the cut to what the owner's rule needs: the state this step
 * stores joins the replay, which is bounded below the price step too (`replayTokenLimit`); a state that would leave no room for another
 * step would be summarized away every step, so it is shortened to fit (and only if even names alone cannot, the bound is let go).
 * A part that was cut earlier is stated whole again as soon as the request fits and the replay, with the whole part, can take another
 * step in this epoch (L1: else the cut copy stays and the epoch is ended by a summary, `stateCut`, unless the next step could restate
 * it in place, L2, and a new epoch could hold it with its bootstrap, L3).
 *
 * Known limit (review 4): a tool opened by `tool_open` is declared in this turn's `tool_addition`, one block for each tool (up to dozens),
 * between the last stored block of the previous request and this one's. The cache looks back about 20 blocks for the earlier write, so
 * that request may write the history again once. Watch `in.write` of the decision after a `tool_open` in the first supervised run
 * (`fca_decision_metrics`) before relying on it.
 */
export function transientRequest(parts: { model: string; maximumOutputTokens: number; compactAboveTokens: number; systemText: string;
  input: FcaModelInput; supplied: Record<string, unknown>; history: readonly Anthropic.MessageParam[];
  menu: { tools: Anthropic.Tool[]; appended: Anthropic.MessageParam[] };
  /** The transport block of system[0] (absent: `HAIKU_PROTOCOL_PREFIX`; a Minecraft body task's own: `MINECRAFT_TRANSPORT`). */
  protocol?: string;
  /** SHANNON_MINECRAFT_LLMC_V2: the live state rewritten before it is sized, cut and sent. */
  rewriteLive?(live: Record<string, unknown>): Record<string, unknown>;
  /** SHANNON_MINECRAFT_LLMC_V2: the knowledge of the stages the live state calls for, stated (as a part of the stored state) only when it changed. */
  stageKnowledge?(live: Record<string, unknown>): string | undefined }) {
  const { model, input, supplied, history, menu } = parts, maximum = parts.compactAboveTokens, limit = input.replayTokenLimit;
  const hour = { type: 'ephemeral' as const, ttl: '1h' as const }, protocol = parts.protocol ?? HAIKU_PROTOCOL_PREFIX;
  const system = [{ type: 'text' as const, cache_control: hour, text: parts.systemText }];
  const fixed = { model, max_tokens: parts.maximumOutputTokens, tools: menu.tools, tool_choice: { type: 'auto' as const },
    thinking: FCA_TRANSIENT_THINKING, output_config: { effort: 'low' as const },
    system: [{ type: 'text', text: protocol, cache_control: hour }, ...system] };
  const turnOf = (row: Record<string, unknown>, live: Record<string, unknown> | null, full: boolean): Anthropic.MessageParam[] => [
    ...[stateMessage(row, full)].filter((message): message is Anthropic.MessageParam => message !== null), ...menu.appended,
    ...(live ? [clearAtMessage(JSON.stringify(live))] : [])];
  // The request with an empty turn: everything the history, the tools and the instructions weigh (the way a legacy decision measured its body).
  // 64 tokens for the cache marker the last stored block gets (`cacheFcaBodyRequest`), which this estimate does not carry.
  const requestBase = estimatedAnthropicTokens(renderedRequest({ ...fixed, messages: [...history] })) + 64;
  const emptyBase = estimatedAnthropicTokens({ ...fixed, messages: [] }) + 64;
  const requestTokens = (row: Record<string, unknown>, live: Record<string, unknown>, full: boolean) =>
    requestBase + estimatedAnthropicTokens(turnOf(row, live, full));
  // What a new epoch would hold if it started with this state: a bootstrap, the state, one round.
  const replayTokens = (row: Record<string, unknown>, full: boolean) =>
    FCA_TRANSIENT_BOOTSTRAP_TOKENS + estimatedAnthropicTokens(turnOf(row, null, full)) + FCA_TRANSIENT_ROUND_TOKENS;
  // What this epoch's replay would hold after this state: what it holds now (the codec's measure, `anthropicFcaHistoryCodec.tokens`), the
  // state, one round (review 4, L1). A state that fits a new epoch only is not stated here: the next step would summarize it away.
  const replayNow = estimatedAnthropicTokens(history.filter(entry => !isFcaClearAtMessage(entry)));
  const continuedTokens = (row: Record<string, unknown>, full: boolean) =>
    replayNow + estimatedAnthropicTokens(turnOf(row, null, full)) + FCA_TRANSIENT_ROUND_TOKENS;
  const requestFits = (full: boolean) => (row: Record<string, unknown>, live: Record<string, unknown>) => requestTokens(row, live, full) <= maximum;
  const bothFit = (full: boolean) => (row: Record<string, unknown>, live: Record<string, unknown>) =>
    requestFits(full)(row, live) && (limit === undefined || replayTokens(row, full) <= limit);
  const wholeFits = (full: boolean) => (row: Record<string, unknown>, live: Record<string, unknown>) =>
    requestFits(full)(row, live) && (limit === undefined || continuedTokens(row, full) <= limit);

  // SHANNON_MINECRAFT_LLMC_V2: the live state as the mode writes it (`rewriteLive`, with the stages' knowledge as its first field).
  const raw = liveObject(supplied, input.transient);
  const live = parts.rewriteLive ? parts.rewriteLive(raw) : raw;
  const kept = storedFields(parts.stageKnowledge ? { ...supplied, stageKnowledge: parts.stageKnowledge(raw) } : supplied);
  let stored = storedState(kept, history);
  let deferred = false;
  if (stored.hasCut) {
    // A part cut earlier is stated whole again as soon as the request fits with it, and the replay with it can take another step. While the
    // cut copy is in the replay the whole one may not fit beside it: that is reported like a cut (`stateCut`), so that the next epoch
    // (whose first state is whole) starts sooner.
    const whole = storedState(kept, history, true);
    if (wholeFits(whole.full)(whole.row, live)) stored = whole;
    else deferred = true;
  }
  let fitted = cutToFit(stored.row, live, bothFit(stored.full));
  const replayRelaxed = fitted.over && limit !== undefined;
  if (replayRelaxed) fitted = cutToFit(stored.row, live, requestFits(stored.full));
  const stages = stagesOf(fitted, deferred, replayRelaxed);
  const storedCut = stages.catalog !== null || stages.state !== null;
  // A summary starts a new epoch whose first state is whole: worth forcing only if (L3) a whole state fits one with its bootstrap and a
  // typical live state, and (L2) the next step could not state it whole in place, beside this epoch's replay.
  const restorable = (storedCut || deferred) && (() => {
    const fresh = storedState(kept, []).row;
    if (emptyBase + FCA_TRANSIENT_BOOTSTRAP_TOKENS + estimatedAnthropicTokens(turnOf(fresh, null, true)) + FCA_TRANSIENT_LIVE_TOKENS > maximum
      || (limit !== undefined && replayTokens(fresh, true) > limit)) return false;
    const sent = turnOf(fitted.row, null, stored.full), next = storedState(kept, [...history, ...sent], true);
    const nextTurn = estimatedAnthropicTokens(turnOf(next.row, null, next.full)), sentTokens = estimatedAnthropicTokens(sent);
    const inPlace = requestBase + sentTokens + FCA_TRANSIENT_ROUND_TOKENS + nextTurn + FCA_TRANSIENT_LIVE_TOKENS <= maximum
      && (limit === undefined || replayNow + sentTokens + 2 * FCA_TRANSIENT_ROUND_TOKENS + nextTurn <= limit);
    return !inPlace;
  })();
  if (fitted.cut) logCut(model, maximum, stages);
  const turn = turnOf(fitted.row, fitted.live, stored.full);
  const body = cacheFcaBodyRequest({ model, max_tokens: parts.maximumOutputTokens, system, messages: [...history, ...turn], tools: menu.tools,
    tool_choice: { type: 'auto' as const }, thinking: FCA_TRANSIENT_THINKING, output_config: { effort: 'low' as const },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming, protocol);
  // `level`: the lowest of the character levels cut; when only the live state's structure was trimmed (no text cut), its trim level (1 to 5),
  // so that a trim alone is not reported as no cut at all (review 5, L-4); the whole stages are in `sent.stages`.
  const counts = liveSkillCounts(input.transient), levels = [stages.catalog, stages.state, stages.live].filter((level): level is number => level !== null);
  const built = { taskId: input.task.id, bodyAttached: input.body !== undefined, level: levels.length ? Math.min(...levels) : stages.trim,
    elidedParts: [] as string[], ...counts, sent: { ...counts, parts: stored.parts, cut: restorable, ...(fitted.cut || deferred ? { stages } : {}) } };
  return { turn, body, built };
}

/** What was cut, content-free. */
function stagesOf(fitted: CutResult, deferred: boolean, replayRelaxed: boolean): CutStages {
  const named = (value: unknown) => value && typeof value === 'object' ? Object.keys(value).length : 0;
  return { ...fitted.levels, over: fitted.over, replayRelaxed, deferred, parts: named(fitted.row.capped), items: named(fitted.row.cappedCatalog) };
}

function logCut(model: string, maximum: number, stages: CutStages): void {
  console.info(JSON.stringify({ event: 'fca_request_compacted', model, maximumTokens: maximum, transient: true, ...stages }));
}
