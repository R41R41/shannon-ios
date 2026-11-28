import { observeAsync, observeSync, observerHandoff } from '../../../infra/observer/observerContext.js';
import { renderedCompaction, type CompactionMessage } from '@shannon/mind';
import type { TaskHistoryWindow, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import { retryVerdict } from './fcaProviderRetry.js';
import type { FcaHistoryAhead, FcaHistoryAheadOptions, FcaHistoryCodec, FcaHistoryFloor, FcaHistoryPlan, FcaHistoryPolicy, FcaHistoryPorts, FcaHistoryPrepared,
  FcaHistoryReplay, FcaHistorySummarizer, FcaHistorySummaryInput } from './fcaHistoryPorts.js';

export const FCA_HISTORY_POLICY: Readonly<FcaHistoryPolicy> = Object.freeze({
  maximumNativeCharacters: 64_000, maximumRounds: 24, recentRounds: 6,
  // Fewer summary calls per compaction: Minecraft run 7 (2026-10-14) compacted 10 times in 33 steps with two or three calls each
  // (rounds of ~19,000 characters, at most one or two to a 32,000-character input), 221 s of its 639 s. On the Minecraft-shaped
  // fixture of `fcaProvenanceCap.test.ts` 64,000 makes 10–11 calls in 35 steps where 32,000 made 15–33. Even all in Japanese
  // (1.1 tokens a character) the input stays below the 100,000-token price step.
  maximumSummaryCharacters: 64_000, maximumBatches: 8,
  // Inline tool definitions are rebuilt from the catalog and sit in the cached prefix; a Minecraft body's 77 skills alone are
  // about 46,000 characters (Minebot lane 2026-10-14, task ecf64b3e failed its second step on them). Their own bound keeps
  // repeated selection changes from growing the request without limit; past it the round is compacted like any other.
  maximumToolDefinitionCharacters: 160_000,
  // Both together stay below about 100k tokens, Haiku's next price step (review P3-1).
  maximumReplayCharacters: 200_000,
  // Characters alone did not: Minebot lane runs 1 and 3 (2026-10-14) sent second decisions of 102,796 and 109,442 tokens, every
  // token of them at the long-prompt price (five times), from replays well inside 200,000 characters (Japanese and JSON run at
  // about 1.8 characters a token there). The codec's estimate (`FcaHistoryCodec.tokens`) of the whole replay stays within this,
  // leaving about 25,000 tokens for the instructions, the current decision and new definitions under the 100,000 step.
  maximumReplayTokens: 75_000,
});
/**
 * A body (Minecraft) task's history while its summaries are rare and by Haiku (`SHANNON_FCA_SUMMARY_MODEL=haiku`, owner decision
 * 2026-10-17): compacted when the conversation's estimated tokens pass 24,000, down to 8,000 with the newest 6 rounds kept whole
 * (fewer only while they alone would pass 8,000). The round count no longer decides (the default's 24 is hit by short rounds long
 * before 24,000 tokens). The characters bounds stay as they are: 24,000 tokens never reach them (at most 2.2 characters a token
 * by the estimate, 64,000 characters native), and the whole-replay bound of 75,000 tokens below the price step stays.
 * Known limits: a single round over 24,000 tokens has nothing older to summarize and is replayed as a clipped public epoch of at
 * most 64,000 characters every step (`clippedReplay`); an unusable summary falls back to a public epoch of up to 64,000 characters
 * and the next step asks again, once (`fallbackFcaHistory`): neither stores a summary, and neither loops within a step.
 */
export const FCA_BODY_HISTORY_POLICY: Readonly<Partial<FcaHistoryPolicy>> = Object.freeze({
  maximumRounds: 120, recentRounds: 6, maximumConversationTokens: 24_000, compactedConversationTokens: 8_000,
});
function policyOf(overrides: Partial<FcaHistoryPolicy>): FcaHistoryPolicy {
  const policy = { ...FCA_HISTORY_POLICY, ...overrides };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1)
    || policy.maximumRounds < policy.recentRounds
    || (policy.compactedConversationTokens ?? 0) > (policy.maximumConversationTokens ?? Infinity)) throw new Error('FCA_HISTORY_POLICY');
  return policy;
}
const size = (value: unknown): number => JSON.stringify(value).length;

/**
 * Every covered native round appears in the summary input, whole and in original order; only a round longer than the summary input by
 * itself has its longest texts shortened there, with the cut marked (`clippedRound`). Stored native history is never cut; a newest
 * round too long by itself is replayed for its next step as a clipped public epoch (`clippedReplay`).
 */
export function planFcaHistory(window: TaskHistoryWindow, codec: FcaHistoryCodec,
  overrides: Partial<FcaHistoryPolicy> = {}, settling = false, forceEpoch?: (replay: readonly unknown[]) => boolean): FcaHistoryPlan {
  const policy = policyOf(overrides);
  const projected = projectedRounds(window, codec);
  const history = epochReplay(window, codec);
  const recent = retainedRounds(projected, window.summary?.template ?? null, policy, codec);
  // While a compaction is settling (a batch was just installed this step), a bootstrap still above its share is compacted again,
  // so that one summary step leaves room for several native rounds (`retainedRounds`).
  const unsettled = settling && unsettledBootstrap(window, projected.length, recent, policy, codec);
  // A forced epoch (`prepareFcaHistory`) summarizes the older rounds even when the replay fits; it needs one round to summarize and one to keep.
  const forced = window.rounds.length >= 2 && forceEpoch?.(history) === true;
  if (!forced && window.rounds.length <= policy.maximumRounds && replayFits(history, codec, policy) && !unsettled) {
    const summary = window.summary?.template ?? null;
    return { kind: 'ready', replay: { history, summary, summaryText: summary ? renderedCompaction(summary, 'text') : '' } };
  }
  const eligible = recent > 0 ? projected.slice(0, -recent) : [];
  if (!eligible.length) return clippedReplay(window.summary?.template ?? null, projected.at(-1), codec, policy);
  const input = summaryInput(eligible, window.summary?.template ?? null, policy.maximumSummaryCharacters);
  if (!input.rounds.length) throw new Error('FCA_HISTORY_ROUND_LIMIT');
  return { kind: 'compact', input, request: { baseRevision: window.revision, sourceRevision: window.sourceRevision,
    tailSequence: window.tailSequence, sequences: input.rounds.map(round => round.sequence), retained: projected.slice(input.rounds.length) } };
}

/**
 * The share of the native budget a post-summary bootstrap may take: a third (Minebot lane, 2026-10-14, task 788da00a: the summary
 * kept the newest round in a bootstrap of 15–28k characters, the next round passed the budget again, and every step compacted).
 */
const bootstrapShare = (policy: FcaHistoryPolicy) => Math.floor(policy.maximumNativeCharacters / 3);

/** The current epoch's replay: its bootstrap, if a summary installed one, and every native round after its reset. */
function epochReplay(window: TaskHistoryWindow, codec: FcaHistoryCodec): unknown[] {
  if (window.summary && (!window.summary.bootstrapText || window.summary.resetThroughSequence < window.summary.throughSequence)) {
    throw new Error('FCA_HISTORY_EPOCH_MISSING');
  }
  return [
    ...window.summary ? codec.bootstrap(window.summary.bootstrapText) : [],
    ...window.rounds.filter(round => round.sequence > (window.summary?.resetThroughSequence ?? 0)).flatMap(round => [...round.entries]),
  ];
}

/** Whether a public bootstrap passes its share of the budget: its characters, and its estimated tokens where the policy has a target. */
function bootstrapTooLong(text: string, policy: FcaHistoryPolicy, codec: FcaHistoryCodec): boolean {
  const target = policy.compactedConversationTokens;
  return text.length > bootstrapShare(policy) || (target !== undefined && (codec.tokens?.(codec.bootstrap(text)) ?? 0) > target);
}

/** A bootstrap above its share with older rounds still to summarize beside the ones it keeps whole. */
function unsettledBootstrap(window: TaskHistoryWindow, rounds: number, recent: number, policy: FcaHistoryPolicy, codec: FcaHistoryCodec): boolean {
  return !!window.summary && recent > 0 && rounds > recent && bootstrapTooLong(window.summary.bootstrapText, policy, codec);
}

/**
 * How many of the newest rounds a compaction keeps whole in its public bootstrap: at most `recentRounds`, and fewer while their
 * public transcript would pass the bootstrap's share of the budget, down to the newest one (a research round's web results are
 * 30,000–40,000 characters: owner test 2026-10-13, two rounds of 41,554 and 33,778 left the task unknown with
 * FCA_HISTORY_RECENT_LIMIT). The rest is summarized, in as many batches as the summary input needs. Zero when only the newest round
 * exists; a newest round too long by itself is replayed clipped (`clippedReplay`).
 */
function retainedRounds(projected: readonly ProjectedRound[], previous: FcaHistorySummaryInput['previous'], policy: FcaHistoryPolicy,
  codec: FcaHistoryCodec): number {
  let recent = Math.min(policy.recentRounds, projected.length - 1);
  const bootstrap = (count: number) => JSON.stringify({ kind: 'fca_public_history', summary: previous, rounds: projected.slice(-count) });
  while (recent > 1 && bootstrapTooLong(bootstrap(recent), policy, codec)) recent -= 1;
  return Math.max(recent, 0);
}

/**
 * Whether the replay fits its bounds. It is replayed byte for byte either way; only what each part is measured against differs:
 * inline tool definitions (`reproducible`) apart from the rest, both together (review P3-1), and the codec's token estimate of the
 * whole (`maximumReplayTokens`). The native budget measures each
 * entry as the codec measures it (`FcaHistoryCodec.measured`: a decision message without the parts each decision restates, which
 * the whole replay's bound still counts).
 */
function replayFits(history: readonly unknown[], codec: FcaHistoryCodec, policy: FcaHistoryPolicy): boolean {
  const definitional = (entry: unknown) => codec.reproducible?.(entry) === true;
  const conversational = history.filter(entry => !definitional(entry) && codec.rendered?.(entry) !== false);
  const native = size(conversational.map(entry => codec.measured?.(entry) ?? entry)), definitions = size(history.filter(definitional));
  return native <= policy.maximumNativeCharacters && definitions <= policy.maximumToolDefinitionCharacters
    && size(conversational) + definitions <= policy.maximumReplayCharacters
    && tokensFit(history, codec, policy);
}

/**
 * The token half of `replayFits`: the codec's estimate of the whole replay, and (with a conversation bound) of the conversation measured as the
 * native budget measures it (`measured`): without the catalog, skill index, instructions and recall a decision restates, which the first
 * decision of every new epoch carries in full. The same public form the 8,000-token target measures (`bootstrapTooLong`); otherwise a
 * compaction would be followed at once by a round over 24,000 and a summary every step. What a stretch checks between its decisions, and a
 * floor is cut to: the price step is a matter of tokens.
 */
function tokensFit(history: readonly unknown[], codec: FcaHistoryCodec, policy: FcaHistoryPolicy): boolean {
  return (codec.tokens?.(history) ?? 0) <= policy.maximumReplayTokens
    && (policy.maximumConversationTokens === undefined || conversationTokens(history, codec) <= policy.maximumConversationTokens);
}

/** The codec's token estimate of the conversation: the replay without its rebuildable definitions and unrendered entries, each as the native budget measures it. */
function conversationTokens(history: readonly unknown[], codec: FcaHistoryCodec): number {
  const definitional = (entry: unknown) => codec.reproducible?.(entry) === true;
  return codec.tokens?.(history.filter(entry => !definitional(entry) && codec.rendered?.(entry) !== false).map(entry => codec.measured?.(entry) ?? entry)) ?? 0;
}

function projectedRounds(window: TaskHistoryWindow, codec: FcaHistoryCodec): ProjectedRound[] {
  return window.rounds.map(round => {
    const messages = codec.project(round);
    if (!messages) throw new Error('FCA_HISTORY_INCOMPLETE_ROUND');
    const outcome: CompactionMessage = { id: `fca-round:${round.sequence}:status`, role: 'assistant',
      content: `Committed task status after this round: ${round.status}. A requested completion is not proof of completion.` };
    return { sequence: round.sequence, stepId: round.stepId, messages: [...messages, outcome] };
  });
}

/** The shortest any message of a clipped round becomes: enough to say what it was. */
const CLIPPED_MESSAGE_CHARACTERS = 400;
type ProjectedRound = { sequence: number; stepId: string; messages: CompactionMessage[] };
const SUMMARY_CUT = (omitted: number) => `…（要約用に後略: ${omitted}字）`;
const REPLAY_CUT = (omitted: number) => `…（長いため後略: ${omitted}字）`;

/** One round, clipped as `levelClipped` does. */
function clippedRound(round: ProjectedRound, measure: (round: ProjectedRound) => number, maximum: number,
  marker: (omitted: number) => string): ProjectedRound | null {
  return levelClipped([round], ([candidate]) => measure(candidate!), maximum, marker)?.[0] ?? null;
}
const clippedCount = (clipped: readonly ProjectedRound[], original: readonly ProjectedRound[]) =>
  clipped.reduce((count, round, index) => count + round.messages.filter((message, at) => message.content !== original[index]!.messages[at]!.content).length, 0);

/**
 * The newest round alone is longer than the native budget and nothing older can be summarized (Minebot lane 2026-10-14: a
 * Minecraft task's first round, with its observation, never reached a second step). This step replays a fresh public epoch
 * instead: the existing summary, if any, and that round's public transcript with its longest texts cut and marked. Signed
 * blocks never enter a changed prefix and nothing is stored: the original round stays whole in the history, the replay is
 * rebuilt identically while it stays the newest, and the next step's ordinary compaction covers it. The task's goal and
 * completion criteria are not in this history; each decision states them again in its own message.
 */
function clippedReplay(previous: FcaHistorySummaryInput['previous'], newest: ProjectedRound | undefined, codec: FcaHistoryCodec,
  policy: FcaHistoryPolicy): FcaHistoryPlan {
  if (!newest) throw new Error('FCA_HISTORY_RECENT_LIMIT');
  const replayOf = (round: ProjectedRound) => codec.bootstrap(JSON.stringify({ kind: 'fca_public_history', summary: previous, rounds: [round] }));
  const clipped = clippedRound(newest, round => size(replayOf(round)), policy.maximumNativeCharacters, REPLAY_CUT);
  if (!clipped) throw new Error('FCA_HISTORY_RECENT_LIMIT');
  const clippedMessages = clippedCount([clipped], [newest]);
  return { kind: 'ready', replay: { history: replayOf(clipped), summary: previous,
    summaryText: previous ? renderedCompaction(previous, 'text') : '', clippedMessages } };
}

/**
 * The summary call answered, but with no usable summary (`SUMMARY_UNUSABLE`). Minebot lane run 2 (2026-10-14, task 94e879f8): such
 * an answer left the step unknown and the task paused, though the call had come back and nothing had run. This step replays a fresh
 * public epoch instead, as `clippedReplay` does: the existing summary and every uncovered round's public transcript, the longest
 * texts cut and marked until it fits the native budget; only when even that cannot fit, the oldest rounds are left out and counted
 * (`omittedRounds`). Nothing is stored: the original rounds stay whole, and the next step's compaction asks for a summary again (at
 * most one summary call per batch, never a hidden retry).
 */
export function fallbackFcaHistory(window: TaskHistoryWindow, codec: FcaHistoryCodec,
  overrides: Partial<FcaHistoryPolicy> = {}): FcaHistoryReplay & { omittedRounds: number } {
  const policy = policyOf(overrides), maximum = policy.maximumNativeCharacters;
  const projected = projectedRounds(window, codec);
  const previous = window.summary?.template ?? null;
  const replayOf = (rounds: readonly ProjectedRound[], omittedRounds: number) => codec.bootstrap(JSON.stringify({ kind: 'fca_public_history',
    summary: previous, ...(omittedRounds ? { omittedRounds } : {}), rounds }));
  // Each round's share of the replay with every text at its shortest, measured once (review of 8da89bc7: re-clipping every
  // remaining round for each round left out took 56 s for 40 rounds). Keep the newest rounds whose shares fit, then clip them once.
  const envelope = size(replayOf([], projected.length));
  const shortest = projected.map(round => size(replayOf([waterClipped(round, CLIPPED_MESSAGE_CHARACTERS, REPLAY_CUT)], projected.length)) - envelope + 1);
  let kept = 0;
  for (let total = envelope; kept < projected.length && total + shortest[projected.length - 1 - kept]! <= maximum; kept++) {
    total += shortest[projected.length - 1 - kept]!;
  }
  // The shares slightly overstate (a separator each, the longest count field) and are an estimate for any codec: the exact measure
  // decides, from one round more than they allow, one round fewer at a time if it must.
  for (kept = Math.min(projected.length, kept + 1); kept > 0; kept--) {
    const omittedRounds = projected.length - kept, rounds = projected.slice(omittedRounds);
    const clipped = levelClipped(rounds, candidate => size(replayOf(candidate, omittedRounds)), maximum, REPLAY_CUT);
    if (!clipped) continue;
    return { history: replayOf(clipped, omittedRounds), summary: previous, summaryText: previous ? renderedCompaction(previous, 'text') : '',
      clippedMessages: clippedCount(clipped, rounds), omittedRounds };
  }
  throw new Error('FCA_HISTORY_RECENT_LIMIT');
}

/** A round with every text longer than `level` cut to it and marked, where the cut shortens it; never inside a surrogate pair (review of 1a647abc). */
function waterClipped(round: ProjectedRound, level: number, marker: (omitted: number) => string): ProjectedRound {
  return { ...round, messages: round.messages.map(message => {
    let keep = level;
    if (/[\uD800-\uDBFF]/u.test(message.content[keep - 1] ?? '')) keep -= 1;
    const cut = `${message.content.slice(0, keep)}${marker(message.content.length - keep)}`;
    return cut.length < message.content.length ? { ...message, content: cut } : { ...message };
  }) };
}

/**
 * Rounds with their longest texts cut to one common length (the highest that fits, found by halving: a bounded number of
 * measures, each linear), the end marked, never below `CLIPPED_MESSAGE_CHARACTERS`; null when even that does not fit.
 * Every message stays, with its id, role and call id.
 */
function levelClipped(rounds: readonly ProjectedRound[], measure: (rounds: ProjectedRound[]) => number, maximum: number,
  marker: (omitted: number) => string): ProjectedRound[] | null {
  const whole = rounds.map(round => ({ ...round, messages: round.messages.map(message => ({ ...message })) }));
  if (measure(whole) <= maximum) return whole;
  const at = (level: number) => rounds.map(round => waterClipped(round, level, marker));
  const floor = at(CLIPPED_MESSAGE_CHARACTERS);
  if (measure(floor) > maximum) return null;
  let low = CLIPPED_MESSAGE_CHARACTERS, high = Math.max(low, ...rounds.flatMap(round => round.messages.map(message => message.content.length)));
  let best = floor;
  while (low < high) {
    const level = Math.ceil((low + high) / 2), candidate = at(level);
    const fits = measure(candidate) <= maximum;
    low = fits ? level : low;
    high = fits ? high : level - 1;
    best = fits ? candidate : best;
  }
  return best;
}

/**
 * Codes of a summary call that came back complete, its spend recorded, with nothing usable in it: the summarizer's own refusal and
 * the decision model's closed checks of a finished answer. An abort, a lost response or a held permit is never one of them.
 */
const SUMMARY_UNUSABLE: ReadonlySet<string> = new Set(['FCA_SUMMARY_INVALID', 'FCA_MODEL_TRUNCATED', 'FCA_MODEL_REFUSED',
  'FCA_MODEL_DECISION_MISSING', 'FCA_MODEL_OUTPUT_INVALID', 'FCA_MODEL_CALL_INVALID', 'FCA_MODEL_CONTROL_MIXED',
  'FCA_MODEL_SUMMARY_INVALID', 'FCA_MODEL_TOOL_NOT_OFFERED']);
function unusableSummary(error: unknown): { code: string; reason: string | null } | null {
  if (!(error instanceof Error) || !SUMMARY_UNUSABLE.has(error.message)) return null;
  const reason = (error as { reason?: unknown }).reason;
  return { code: error.message, reason: typeof reason === 'string' && /^[a-z_]{1,32}$/u.test(reason) ? reason : null };
}

/**
 * What a summary that could not be had comes to: an unusable answer, and, for a task that goes on whatever happens (`patient`), a provider
 * that could not be reached (what a decision is asked again for). Null: the error is the step's.
 */
function summaryFailure(error: unknown, patient: boolean | undefined): { code: string; reason: string | null } | null {
  const unusable = unusableSummary(error);
  if (unusable || !patient || !retryVerdict(error)) return unusable;
  return { code: error instanceof Error ? error.message : 'FCA_SUMMARY_UNAVAILABLE', reason: 'provider_unavailable' };
}

/** The oldest eligible rounds that fit the summary input, in order. */
function summaryInput(eligible: readonly ProjectedRound[], previous: FcaHistorySummaryInput['previous'], maximum: number) {
  const input = { previous, rounds: [] as ProjectedRound[] };
  for (const round of eligible) {
    if (size({ ...input, rounds: [...input.rounds, round] }) <= maximum) {
      input.rounds.push(round);
      continue;
    }
    // The oldest round alone is longer than the summary input: it is still covered whole (every message, in order), its longest
    // texts shortened for the summary only. The native round itself is replaced by the summary, as any compacted round is.
    const clipped = input.rounds.length ? null
      : clippedRound(round, candidate => size({ previous, rounds: [candidate] }), maximum, SUMMARY_CUT);
    if (clipped) input.rounds.push(clipped);
    break;
  }
  return input;
}

/** The step's replay after an unusable summary answer (`fallbackFcaHistory`), from a fresh window, logged content-free. */
function summaryFallback(step: TaskStep, ports: FcaHistoryPorts, policy: FcaHistoryPolicy,
  unusable: { code: string; reason: string | null }, batches: number): FcaHistoryReplay {
  const current = ports.runtime.history(step.scopeKey, step.taskId, step.messageIds);
  if (!current) throw new Error('FCA_TASK_NOT_FOUND');
  const { omittedRounds, ...replay } = fallbackFcaHistory(current, ports.codec, policy);
  const clippedMessages = replay.clippedMessages ?? 0;
  // Content-free: the closed code, the task's opaque id and what the fallback replay left out.
  console.log(`Shannon FCA history summary unusable task=${step.taskId} code=${unusable.code}${unusable.reason ? ` reason=${unusable.reason}` : ''} `
    + `fallback=public_epoch clipped=${clippedMessages} omittedRounds=${omittedRounds}`);
  observerHandoff('compact', 'context', { phase: 'history_summary_fallback', code: unusable.code, reason: unusable.reason,
    clippedMessages, omittedRounds, compactedBatches: batches });
  return replay;
}

/** The look before each use of the stored history: not aborted, sources visible, the permit held, the task executing (else `FCA_HISTORY_HELD`). */
function historyChecked(step: TaskStep, ports: FcaHistoryPorts, signal: AbortSignal): () => Promise<void> {
  return async () => {
    signal.throwIfAborted();
    if (!ports.sourcesVisible() || !await ports.permit()) throw new Error('FCA_HISTORY_HELD');
    signal.throwIfAborted();
    if (!ports.sourcesVisible() || ports.runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_HISTORY_HELD');
  };
}

/**
 * Uses the current action permit; derived summary writes never enqueue work or retry a model call. `forceEpoch` (asked with the epoch replay,
 * before any compaction) makes the first plan summarize (a real summary, never a clipped replay) so that the replay starts a new epoch: the only
 * way the tools a signed prefix binds can change (`fcaCoreTools.ts`). With a summary made beside the steps (`ahead`) it never summarizes in the step: a ready
 * summary is installed, else the new epoch begins with a floor (`aheadHead`). `patient` (a body task nobody is watching, 4 to 5 hours): a provider
 * that could not be reached for the summary (a 5xx, a throttle, a reset: what a decision would be asked again for) gives the clipped replay
 * of an unusable answer and the task goes on, instead of failing it at the second such error in a row.
 */
export async function prepareFcaHistory(step: TaskStep, ports: FcaHistoryPorts, signal: AbortSignal,
  overrides: Partial<FcaHistoryPolicy> = {},
  options: { forceEpoch?: (replay: readonly unknown[]) => boolean; ahead?: FcaHistoryAheadOptions; patient?: boolean } = {}): Promise<FcaHistoryReplay> {
  const policy = policyOf(overrides);
  const checked = historyChecked(step, ports, signal);
  const aheadState = { installed: false, truncated: false };
  for (let batches = 0; ; batches++) {
    await checked();
    const window = ports.runtime.history(step.scopeKey, step.taskId, step.messageIds);
    if (!window) throw new Error('FCA_TASK_NOT_FOUND');
    // A second batch may follow only to settle the bootstrap, and only while another batch remains (`maximumBatches`).
    const settling = batches > 0 && batches + 1 < policy.maximumBatches, forceEpoch = batches === 0 ? options.forceEpoch : undefined;
    // mb-llmc r3: with `ahead`, a summary made beside the steps (`aheadTurn`); a turn with no plan goes round again.
    const { plan } = await aheadTurn({ step, ports, window, policy, ahead: options.ahead, state: aheadState, checked, settling, forceEpoch });
    if (!plan) continue;
    if (plan.kind === 'ready') {
      if (batches > 0) observerHandoff('compact', 'context', { phase: 'history_replay', compactedBatches: batches });
      const clippedMessages = plan.replay.clippedMessages;
      if (clippedMessages !== undefined) observerHandoff('fca', 'context', { phase: 'history_clipped', clippedMessages });
      return plan.replay;
    }
    if (!ports.summarizer) throw new Error('FCA_HISTORY_SUMMARIZER_REQUIRED');
    if (batches >= policy.maximumBatches) throw new Error('FCA_HISTORY_COMPACTION_LIMIT');
    // Flow 1113 (run 9, t=4175-4385: three summaries in a row cut at the output cap, 37 s each): after a cut summary no second one is asked in this
    // step (the clipped replay carries it), and for `AHEAD_RETRY_ROUNDS` rounds none is asked in a later step either; past the bounds meanwhile
    // the stored history is brought back within them without a model call (`truncatedCommit`).
    if (aheadState.truncated) return summaryFallback(step, ports, policy, { code: 'FCA_MODEL_TRUNCATED', reason: 'cooldown' }, batches);
    if (options.ahead && cutRecently(options.ahead.port, step.taskId, window)) {
      if (await truncatedCommit(step, ports, plan, window, options.ahead.port, checked)) {
        aheadState.truncated = true;
        continue;
      }
      return summaryFallback(step, ports, policy, { code: 'FCA_MODEL_TRUNCATED', reason: 'cooldown' }, batches);
    }
    observerHandoff('fca', 'compact', { roundCount: plan.input.rounds.length, batch: batches });
    let template: unknown;
    try {
      template = await observeAsync('compact', { phase: 'summarize', roundCount: plan.input.rounds.length, batch: batches },
        () => ports.summarizer!.summarize(plan.input, signal));
    } catch (error) {
      const unusable = summaryFailure(error, options.patient);
      if (!unusable || signal.aborted) throw error;
      await checked();
      if (unusable.code === 'FCA_MODEL_TRUNCATED' && !aheadState.truncated) {
        aheadState.truncated = true;
        if (await truncatedCommit(step, ports, plan, window, options.ahead?.port, checked)) continue;
      }
      return summaryFallback(step, ports, policy, unusable, batches);
    }
    await checked();
    if (!observeSync('compact', { phase: 'commit', roundCount: plan.input.rounds.length },
      () => ports.runtime.commitCompaction(step, { ...plan.request, template }, ports.sourcesVisible), committed => ({ committed }))) throw new Error('FCA_HISTORY_COMMIT_FENCED');
  }
}

/** What a failed `FcaHistoryPrepared` holds in `template` when its summary was cut at the output cap (`FCA_MODEL_TRUNCATED`): the mark of `cutRecently`. */
const CUT_AT_CAP = Object.freeze({ cut: 'FCA_MODEL_TRUNCATED' });
const isCut = (prepared: FcaHistoryPrepared | undefined): boolean => prepared?.state === 'failed' && prepared.template === CUT_AT_CAP;

/** Whether a summary of this task was cut at the output cap fewer than `AHEAD_RETRY_ROUNDS` rounds ago (beside the steps or in one). */
function cutRecently(port: FcaHistoryAheadOptions['port'], taskId: string, window: TaskHistoryWindow): boolean {
  const prepared = port.get(taskId);
  return isCut(prepared) && window.revision === prepared!.revision && window.tailSequence - prepared!.tail < AHEAD_RETRY_ROUNDS;
}

/**
 * A summary was cut at the output cap (or was, a few rounds ago): the stored history is brought back within its bounds without asking the
 * model again. The rounds the summary would have covered are replaced by the previous summary and one line that says how many were left out;
 * the rounds after them stay whole in the new epoch's bootstrap (the same shape as `fallbackFcaHistory`'s replay, now stored, so that the next step
 * does not replay and clip it again). The cut is marked in the ahead state as a failed summary (`cutRecently`) so that none is asked for
 * `AHEAD_RETRY_ROUNDS` rounds. False when the commit was fenced: the caller then replays the clipped fallback for this step.
 */
async function truncatedCommit(step: TaskStep, ports: FcaHistoryPorts, plan: Extract<FcaHistoryPlan, { kind: 'compact' }>, window: TaskHistoryWindow,
  port: FcaHistoryAheadOptions['port'] | undefined, checked: () => Promise<void>): Promise<boolean> {
  await checked();
  const sequences = plan.input.rounds.map(round => round.sequence);
  const previous = (window.summary?.template ?? {}) as unknown as Partial<Record<string, readonly string[]>>;
  const note = `要約が長すぎて切れたため、round ${sequences[0]}〜${sequences.at(-1)}（${sequences.length} 回分）の経過は省いた`;
  const template = { ...previous, 重要な文脈: [...(previous['重要な文脈'] ?? []), note] };
  const committed = observeSync('compact', { phase: 'commit_cut', roundCount: sequences.length },
    () => ports.runtime.commitCompaction(step, { ...plan.request, template }, ports.sourcesVisible), done => ({ committed: done }));
  console.log(`Shannon FCA history summary cut task=${step.taskId} commit=${committed} rounds=${sequences.length}`);
  if (!port) return committed;
  const after = committed ? ports.runtime.history(step.scopeKey, step.taskId, step.messageIds) ?? window : window;
  port.set(step.taskId, { revision: after.revision, sequences: [], tail: after.tailSequence, state: 'failed', template: CUT_AT_CAP, done: Promise.resolve() });
  return committed;
}

/**
 * mb-llmc r5 (run 28: five summaries, 14–16.6 s each, were all made in their steps and none beside them): the hard bounds raised only
 * the rounds and the conversation's tokens, while the replay passed the policy by its characters (64,000 native: a body round is mostly
 * ASCII, about two characters a token). Every bound a replay may pass gets room past the policy unless `hard` names it: the characters
 * half as much again, the whole replay's tokens a fifth. (The conversation's own hard bound is what holds a body task's request: it and the
 * instructions the decision adds, about 58,000-60,000 tokens, come to about 115,000, past the 100,000 of `PRICE_STEP_TOKENS`, as the policy's did.)
 */
export const FCA_AHEAD_ROOM = Object.freeze({ characters: 1.5, tokens: 1.2 });
function aheadRoom(policy: FcaHistoryPolicy): Partial<FcaHistoryPolicy> {
  return { maximumNativeCharacters: Math.ceil(policy.maximumNativeCharacters * FCA_AHEAD_ROOM.characters),
    maximumReplayCharacters: Math.ceil(policy.maximumReplayCharacters * FCA_AHEAD_ROOM.characters),
    maximumToolDefinitionCharacters: Math.ceil(policy.maximumToolDefinitionCharacters * FCA_AHEAD_ROOM.characters),
    maximumReplayTokens: Math.ceil(policy.maximumReplayTokens * FCA_AHEAD_ROOM.tokens) };
}

/** After a summary asked beside the steps came back unusable, the rounds that must follow before another is asked. */
const AHEAD_RETRY_ROUNDS = 3;

/**
 * One turn of `prepareFcaHistory` with a summary made beside the steps (mb-llmc r3): a ready one is committed first (no model call; its
 * bootstrap holds every round since it was asked, so it is not settled again), then `aheadHead` chooses the replay. This is the only place a
 * step looks at its history (11/28, replay of end run 18, plan G2): nothing between the decisions of a stretch asks for a summary, installs
 * one or cuts, so a stretch never changes the first message of its replay (the signed blocks of the old first message stay under it).
 */
async function aheadTurn(parts: { step: TaskStep; ports: FcaHistoryPorts; window: TaskHistoryWindow; policy: FcaHistoryPolicy;
  ahead: FcaHistoryAheadOptions | undefined; state: { installed: boolean }; checked(): Promise<void>; settling: boolean;
  forceEpoch: ((replay: readonly unknown[]) => boolean) | undefined }): Promise<{ plan?: FcaHistoryPlan }> {
  const { step, ports, window, policy, ahead, state } = parts;
  if (!ahead || !ports.summarizer) return { plan: planFcaHistory(window, ports.codec, policy, parts.settling, parts.forceEpoch) };
  if (!state.installed && await installAhead(step, ports, window, ahead, parts.checked)) {
    state.installed = true;
    ahead.note?.('installed');
    return {};
  }
  return aheadHead({ step, ports, window, policy, ahead, settling: parts.settling && !state.installed, forceEpoch: parts.forceEpoch });
}

/** Asks the summary of `plan` beside the step unless one is pending or ready (never twice), or a failed one is still cooling down (`AHEAD_RETRY_ROUNDS`). */
function askAhead(taskId: string, plan: Extract<FcaHistoryPlan, { kind: 'compact' }>, window: TaskHistoryWindow, ahead: FcaHistoryAheadOptions,
  summarizer: FcaHistorySummarizer): void {
  const prepared = ahead.port.get(taskId);
  if (prepared && !(prepared.state === 'failed' && window.tailSequence - prepared.tail >= AHEAD_RETRY_ROUNDS)) return;
  startAhead(taskId, plan, window, ahead, summarizer);
  ahead.note?.('started');
}

/**
 * The replay of a step, which never waits for a model (11/28: waits for a 15-29 s Haiku summary were 339 s of 18 runs' 1,400 s and closed the
 * dragon's phase 2 window three times in four). Past the policy (`maximumConversationTokens`) the summary is asked beside the step (`askAhead`);
 * a core forced to a new epoch (`forceEpoch`, also while a floor stands, which is then cut again) is a new epoch by a floor, not by a summary made in the step. The replay is then:
 * 1. a standing floor while it, with `FCA_FLOOR.headroomTokens` for what the step adds, is within the hard bounds (the first message stays the
 *    same, so the epoch continues: only the summary's installation, or a recut, changes it);
 * 2. the whole history while it leaves that headroom, else
 * 3. a new floor (`cutFloor`): the oldest rounds left out, counted and logged, the rest public and clipped to fit, held to the hard bound less the
 *    largest growth of a recent step.
 * While a summary cut at the output cap is cooling down and the whole history does not leave the headroom, the step goes on to `truncatedCommit`
 * (no model call). Where even the smallest floor does not fit, the summary and a count of the rounds left out are replayed for this step
 * (`emptiestReplay`), and where that does not fit either the step fails: no path of this function waits for a model or calls one.
 * The rounds stay whole in the store and the summary, when ready, is installed by the next step with every round since it was asked kept after it.
 */
function aheadHead(parts: { step: TaskStep; ports: FcaHistoryPorts; window: TaskHistoryWindow; policy: FcaHistoryPolicy; ahead: FcaHistoryAheadOptions;
  settling: boolean; forceEpoch: ((replay: readonly unknown[]) => boolean) | undefined }): { plan?: FcaHistoryPlan } {
  const { step, ports, window, policy, ahead } = parts, taskId = step.taskId;
  const bounds = hardBounds(policy, ahead), room = withHeadroom(bounds), previous = window.summary?.template ?? null;
  const ready = (history: readonly unknown[]): { plan: FcaHistoryPlan } => ({ plan: { kind: 'ready',
    replay: { history, summary: previous, summaryText: previous ? renderedCompaction(previous, 'text') : '' } } });
  const floored = flooredHistory(window, ahead.port.floor(taskId));
  // A stale core asks for a new epoch (`forceEpoch`) with the replay the model last saw: a standing floor's, else the history's own. A standing
  // floor that is asked about is not kept: the cut below starts the new epoch (its first message is new, so the core is pinned again there).
  let forced = false;
  const forceEpoch = parts.forceEpoch ? (replay: readonly unknown[]) => { const asked = parts.forceEpoch!(replay); forced = forced || asked; return asked; } : undefined;
  if (floored) forceEpoch?.(floored);
  const standing = forced ? null : floored;
  const plan = planFcaHistory(window, ports.codec, policy, parts.settling, floored ? undefined : forceEpoch);
  const past = forced ? planFcaHistory(window, ports.codec, policy, false) : plan;
  if (past.kind === 'compact') askAhead(taskId, past, window, ahead, ports.summarizer!);
  if (standing && tokensFit(standing, ports.codec, room)) {
    // The floor stands: the replay starts with the message it started with before (`FcaHistoryFloor`).
    observerHandoff('compact', 'context', { phase: 'history_dropped', summary: ahead.port.get(taskId)?.state ?? 'none', floor: 'standing' });
    ahead.note?.('dropped');
    return ready(standing);
  }
  if (plan.kind === 'ready' && !forced) return { plan };
  if (!forced) {
    const whole = planFcaHistory(window, ports.codec, room, false);
    if (whole.kind === 'ready') return { plan: whole };
    if (cutRecently(ahead.port, taskId, window)) return { plan };
  }
  const cut = cutFloor(taskId, window, ports, bounds, ahead);
  if (cut) {
    logDropped(taskId, ahead, cut.dropped);
    ahead.note?.('dropped');
    return ready(cut.floor.bootstrap);
  }
  // Not even the smallest floor fits (the newest round alone is past the bounds, by characters or by tokens): this step replays the summary and a count
  // of the rounds left out, no round. It calls no model and waits for none, stores nothing and holds no floor; where even that passes the bounds
  // (the summary itself is too long) the step fails visibly (`FCA_HISTORY_RECENT_LIMIT`) instead of waiting for a summary of rounds it does not hold.
  const emptiest = emptiestReplay(window, ports.codec, bounds);
  if (!emptiest) throw new Error('FCA_HISTORY_RECENT_LIMIT');
  const { omittedRounds, ...replay } = emptiest;
  logDropped(taskId, ahead, { omittedRounds, clippedMessages: replay.clippedMessages });
  ahead.note?.('dropped');
  return { plan: { kind: 'ready', replay } };
}

/** The replay with no round (`aheadHead`'s last resort): the existing summary and every round counted as left out; null where the codec's estimate passes the bounds. */
function emptiestReplay(window: TaskHistoryWindow, codec: FcaHistoryCodec, bounds: FcaHistoryPolicy): (FcaHistoryReplay & { omittedRounds: number }) | null {
  const previous = window.summary?.template ?? null, omittedRounds = projectedRounds(window, codec).length;
  const history = codec.bootstrap(JSON.stringify({ kind: 'fca_public_history', summary: previous, ...(omittedRounds ? { omittedRounds } : {}), rounds: [] }));
  if (!tokensFit(history, codec, bounds)) return null;
  return { history, summary: previous, summaryText: previous ? renderedCompaction(previous, 'text') : '', clippedMessages: 0, omittedRounds };
}

/** The bounds a step may reach while a summary is made beside the steps: the policy with room, the owner's hard bounds, and an urgent step's conversation. */
function hardBounds(policy: FcaHistoryPolicy, ahead: FcaHistoryAheadOptions): FcaHistoryPolicy {
  const conversation = ahead.urgent ? { maximumConversationTokens: Math.max(policy.maximumReplayTokens, ahead.hard.maximumConversationTokens ?? 0) } : {};
  return { ...policy, ...aheadRoom(policy), ...ahead.hard, ...conversation };
}

/** Content-free: the task's opaque id, what the summary beside the step is doing, and what the cut left out. */
function logDropped(taskId: string, ahead: FcaHistoryAheadOptions, dropped: { omittedRounds: number; clippedMessages?: number }): void {
  const why = ahead.port.get(taskId)?.state ?? 'none';
  console.log(`Shannon FCA history summary dropped task=${taskId} summary=${why} omittedRounds=${dropped.omittedRounds} clipped=${dropped.clippedMessages ?? 0}`);
  observerHandoff('compact', 'context', { phase: 'history_dropped', summary: why, omittedRounds: dropped.omittedRounds, clippedMessages: dropped.clippedMessages ?? 0, floor: 'cut', where: 'step' });
}

/**
 * What a cut leaves room for (11/28, plan G2 of the replay of end run 18, which kept the first message steady with few cuts): a replay is cut
 * when the conversation with `headroomTokens` (what one more step may add; at most `headroomShare` of the bound, so a small bound stays in
 * proportion) would pass the hard bound, down to the bound less that headroom and less the largest growth of the last `lookbackRounds` rounds
 * (a share, `firstShare`, of the bound while fewer than `minimumRounds` are known), never below `minimumTokens`. The headroom is taken off
 * twice (once in what triggers a cut, once in the floor): G2 itself cut to the bound less the largest growth only, which leaves no room at all
 * when the growth is steady (every step then cuts); in the replay of run 18 the two differ little (rewritten tokens 541k against 587k, the
 * same 35 changes of the first message, bias 9,000).
 */
export const FCA_FLOOR = Object.freeze({ headroomTokens: 8_000, headroomShare: 0.15, lookbackRounds: 16, minimumRounds: 4, firstShare: 0.3, minimumTokens: 4_000 });

const conversationLimit = (bounds: FcaHistoryPolicy): number => bounds.maximumConversationTokens ?? bounds.maximumReplayTokens;
const headroomOf = (bounds: FcaHistoryPolicy): number => Math.min(FCA_FLOOR.headroomTokens, Math.floor(conversationLimit(bounds) * FCA_FLOOR.headroomShare));

/** The bounds with the conversation's held to `tokens` (the compacted target kept below it); the whole replay's where there is no conversation bound. */
function withConversation(bounds: FcaHistoryPolicy, tokens: number): FcaHistoryPolicy {
  const limit = Math.max(1, Math.floor(tokens));
  if (bounds.maximumConversationTokens === undefined) return { ...bounds, maximumReplayTokens: Math.min(bounds.maximumReplayTokens, limit) };
  return { ...bounds, maximumConversationTokens: limit,
    ...(bounds.compactedConversationTokens !== undefined ? { compactedConversationTokens: Math.min(bounds.compactedConversationTokens, limit) } : {}) };
}

/** The hard bounds less one step's growth: what a replay must fit at the start of a step for the step to end within the bounds. */
const withHeadroom = (bounds: FcaHistoryPolicy): FcaHistoryPolicy => withConversation(bounds, conversationLimit(bounds) - headroomOf(bounds));

/** The conversation tokens a new floor is cut to (see `FCA_FLOOR`). */
function floorTarget(window: TaskHistoryWindow, bounds: FcaHistoryPolicy, codec: FcaHistoryCodec): number {
  const limit = conversationLimit(bounds), headroom = headroomOf(bounds);
  const grown = window.rounds.slice(-FCA_FLOOR.lookbackRounds).map(round => conversationTokens([...round.entries], codec));
  const margin = grown.length >= FCA_FLOOR.minimumRounds ? Math.max(...grown) : Math.floor(limit * FCA_FLOOR.firstShare);
  return Math.max(Math.min(FCA_FLOOR.minimumTokens, Math.floor(limit * 0.1)), limit - headroom - margin);
}

/** The replay a floor makes of this window: its bootstrap, then every round after the rounds it froze, native; null when it is not of this window's summary. */
function flooredHistory(window: TaskHistoryWindow, floor: FcaHistoryFloor | undefined): unknown[] | null {
  if (!floor || floor.revision !== window.revision || floor.frozenThrough > window.tailSequence) return null;
  return [...floor.bootstrap, ...window.rounds.filter(round => round.sequence > floor.frozenThrough).flatMap(round => [...round.entries])];
}

/**
 * Cuts the replay to a new floor and keeps it (`FcaHistoryAhead.setFloor`): `fallbackFcaHistory`'s public epoch of everything stored, held to
 * `floorTarget` of the conversation, else to the bounds themselves. Null when even the smallest does not fit.
 */
function cutFloor(taskId: string, window: TaskHistoryWindow, ports: FcaHistoryPorts, bounds: FcaHistoryPolicy, ahead: FcaHistoryAheadOptions):
  { floor: FcaHistoryFloor; dropped: FcaHistoryReplay & { omittedRounds: number } } | null {
  const dropped = truncatedReplay(window, ports.codec, withConversation(bounds, floorTarget(window, bounds, ports.codec))) ?? truncatedReplay(window, ports.codec, bounds);
  if (!dropped) return null;
  const omitted = dropped.omittedRounds ? window.rounds[dropped.omittedRounds - 1] : undefined;
  const floor: FcaHistoryFloor = { revision: window.revision, omitThrough: omitted?.sequence ?? 0, frozenThrough: window.tailSequence, bootstrap: dropped.history };
  ahead.port.setFloor(taskId, floor);
  return { floor, dropped };
}

/**
 * The replay of a step past the hard bounds with no summary yet (`fallbackFcaHistory`: the existing summary, the newest rounds' public
 * transcript, the oldest rounds left out and counted), held to the bounds by the codec's estimate: its native characters, then each time
 * a quarter fewer until the estimated tokens fit the whole replay's bound and the bound of the conversation, and then the largest cap that
 * still fits between that one and the one before (four halvings: a floor cut to its target, not to a quarter under it). When the smallest
 * still passes the conversation's bound it is used if the whole replay's bound holds (the price step is the limit that costs); else null.
 */
function truncatedReplay(window: TaskHistoryWindow, codec: FcaHistoryCodec, bounds: FcaHistoryPolicy): (FcaHistoryReplay & { omittedRounds: number }) | null {
  const at = (cap: number): (FcaHistoryReplay & { omittedRounds: number }) | null => {
    try { return fallbackFcaHistory(window, codec, { ...bounds, maximumNativeCharacters: cap }); } catch { return null; }
  };
  let smallest: (FcaHistoryReplay & { omittedRounds: number }) | null = null, missed = 0;
  for (let cap = bounds.maximumNativeCharacters; cap >= MINIMUM_TRUNCATED_CHARACTERS; cap = Math.floor(cap * 0.75)) {
    const next = at(cap);
    if (!next) break;
    smallest = next;
    if (!tokensFit(smallest.history, codec, bounds)) { missed = cap; continue; }
    let best = smallest, low = cap, high = missed;
    for (let round = 0; missed && round < 4 && high - low > 1; round++) {
      const middle = Math.ceil((low + high) / 2), candidate = at(middle);
      if (candidate && tokensFit(candidate.history, codec, bounds)) { best = candidate; low = middle; } else high = middle;
    }
    return best;
  }
  return smallest && (codec.tokens?.(smallest.history) ?? 0) <= bounds.maximumReplayTokens ? smallest : null;
}
const MINIMUM_TRUNCATED_CHARACTERS = 1_000;

/** The summaries made beside the steps, by task (in memory, at most 32 tasks). */
export function createFcaHistoryAhead(): FcaHistoryAhead {
  const kept = new Map<string, FcaHistoryPrepared>(), floors = new Map<string, FcaHistoryFloor>();
  return {
    get: taskId => kept.get(taskId),
    set(taskId, prepared) {
      kept.delete(taskId);
      kept.set(taskId, prepared);
      if (kept.size > 32) kept.delete(kept.keys().next().value as string);
    },
    clear: taskId => { kept.delete(taskId); },
    floor: taskId => floors.get(taskId),
    setFloor(taskId, floor) {
      floors.delete(taskId);
      if (!floor) return;
      floors.set(taskId, floor);
      if (floors.size > 32) floors.delete(floors.keys().next().value as string);
    },
  };
}

/** Asks the summary of `plan`'s rounds apart from the step; the step does not wait for it. Its outcome is logged content-free. */
function startAhead(taskId: string, plan: Extract<FcaHistoryPlan, { kind: 'compact' }>, window: TaskHistoryWindow, ahead: FcaHistoryAheadOptions,
  summarizer: FcaHistorySummarizer): void {
  let settle: () => void = () => undefined;
  const prepared: FcaHistoryPrepared = { revision: window.revision, sequences: plan.input.rounds.map(round => round.sequence),
    tail: window.tailSequence, state: 'pending', done: new Promise<void>(resolve => { settle = resolve; }) };
  ahead.port.set(taskId, prepared);
  const began = Date.now();
  void ahead.detach(signal => summarizer.summarize(plan.input, signal)).then(template => {
    prepared.template = template;
    prepared.state = 'ready';
    console.log(`Shannon FCA history summary ahead task=${taskId} outcome=ready rounds=${prepared.sequences.length} ms=${Date.now() - began}`);
  }, error => {
    prepared.state = 'failed';
    const code = error instanceof Error && /^[A-Z0-9_]{1,64}$/u.test(error.message) ? error.message : 'other';
    if (code === 'FCA_MODEL_TRUNCATED') prepared.template = CUT_AT_CAP;
    console.log(`Shannon FCA history summary ahead task=${taskId} outcome=failed code=${code} ms=${Date.now() - began}`);
  }).finally(() => settle());
}

/**
 * Commits the summary made beside an earlier step when it is ready and still covers the oldest rounds of this window (the same summary
 * revision): every round after them is kept whole in the new epoch's bootstrap. A stale one (another summary came first) is dropped.
 */
async function installAhead(step: TaskStep, ports: FcaHistoryPorts, window: TaskHistoryWindow, ahead: FcaHistoryAheadOptions,
  checked: () => Promise<void>): Promise<boolean> {
  const prepared = ahead.port.get(step.taskId);
  if (!prepared || prepared.state === 'pending') return false;
  const fits = prepared.revision === window.revision && prepared.sequences.length < window.rounds.length
    && prepared.sequences.every((sequence, index) => window.rounds[index]?.sequence === sequence);
  if (!fits) {
    ahead.port.clear(step.taskId);
    return false;
  }
  // A failed one is kept for its mark (`AHEAD_RETRY_ROUNDS`).
  if (prepared.state !== 'ready') return false;
  const projected = projectedRounds(window, ports.codec);
  await checked();
  const committed = observeSync('compact', { phase: 'commit_ahead', roundCount: prepared.sequences.length }, () => ports.runtime.commitCompaction(step, {
    baseRevision: window.revision, sourceRevision: window.sourceRevision, tailSequence: window.tailSequence, sequences: prepared.sequences,
    retained: projected.slice(prepared.sequences.length), template: prepared.template }, ports.sourcesVisible), done => ({ committed: done }));
  // Only a commit that went through uses the summary up: a fenced one (the lease or the sources moved meanwhile) is tried again at the next step
  // (a stale one is dropped by the check above), so that 15-29 s of summary are not thrown away.
  if (committed) ahead.port.clear(step.taskId);
  return committed;
}