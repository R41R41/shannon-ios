import { observeAsync, observeSync, observerHandoff } from '../../../infra/observer/observerContext.js';
import { renderedCompaction, type CompactionMessage } from '@shannon/mind';
import type { TaskHistoryWindow, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaHistoryAhead, FcaHistoryAheadOptions, FcaHistoryCodec, FcaHistoryPlan, FcaHistoryPolicy, FcaHistoryPorts, FcaHistoryPrepared,
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
    && (codec.tokens?.(history) ?? 0) <= policy.maximumReplayTokens
    // Measured as the native budget measures (`measured`): without the catalog, skill index, instructions and recall a decision
    // restates, which the first decision of every new epoch carries in full. The same public form the 8,000-token target measures
    // (`bootstrapTooLong`); otherwise a compaction would be followed at once by a round over 24,000 and a summary every step.
    && (policy.maximumConversationTokens === undefined
      || (codec.tokens?.(conversational.map(entry => codec.measured?.(entry) ?? entry)) ?? 0) <= policy.maximumConversationTokens);
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

/**
 * Uses the current action permit; derived summary writes never enqueue work or retry a model call. `forceEpoch` (asked with the epoch replay,
 * before any compaction) makes the first plan summarize (a real summary, never a clipped replay) so that the replay starts a new epoch: the only
 * way the tools a signed prefix binds can change (`fcaCoreTools.ts`).
 */
export async function prepareFcaHistory(step: TaskStep, ports: FcaHistoryPorts, signal: AbortSignal,
  overrides: Partial<FcaHistoryPolicy> = {},
  options: { forceEpoch?: (replay: readonly unknown[]) => boolean; ahead?: FcaHistoryAheadOptions } = {}): Promise<FcaHistoryReplay> {
  const policy = policyOf(overrides);
  const checked = async () => {
    signal.throwIfAborted();
    if (!ports.sourcesVisible() || !await ports.permit()) throw new Error('FCA_HISTORY_HELD');
    signal.throwIfAborted();
    if (!ports.sourcesVisible() || ports.runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_HISTORY_HELD');
  };
  const aheadState = { installed: false, waited: false };
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
    observerHandoff('fca', 'compact', { roundCount: plan.input.rounds.length, batch: batches });
    let template: unknown;
    try {
      template = await observeAsync('compact', { phase: 'summarize', roundCount: plan.input.rounds.length, batch: batches },
        () => ports.summarizer!.summarize(plan.input, signal));
    } catch (error) {
      const unusable = unusableSummary(error);
      if (!unusable || signal.aborted) throw error;
      await checked();
      return summaryFallback(step, ports, policy, unusable, batches);
    }
    await checked();
    if (!observeSync('compact', { phase: 'commit', roundCount: plan.input.rounds.length },
      () => ports.runtime.commitCompaction(step, { ...plan.request, template }, ports.sourcesVisible), committed => ({ committed }))) throw new Error('FCA_HISTORY_COMMIT_FENCED');
  }
}

/** How long a step past the hard bounds waits for a summary already asked beside the steps (mb-llmc r3). */
const AHEAD_WAIT_MS = 30_000;
/**
 * mb-llmc r5 (run 28: five summaries, 14–16.6 s each, were all made in their steps and none beside them): the hard bounds raised only
 * the rounds and the conversation's tokens, while the replay passed the policy by its characters (64,000 native: a body round is mostly
 * ASCII, about two characters a token). Every bound a replay may pass gets room past the policy unless `hard` names it: the characters
 * half as much again, the whole replay's tokens a fifth (still below the 100,000-token price step with the instructions and a decision).
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
 * bootstrap holds every round since it was asked, so it is not settled again); then the plan, and past the policy `aheadStep`.
 */
async function aheadTurn(parts: { step: TaskStep; ports: FcaHistoryPorts; window: TaskHistoryWindow; policy: FcaHistoryPolicy;
  ahead: FcaHistoryAheadOptions | undefined; state: { installed: boolean; waited: boolean }; checked(): Promise<void>; settling: boolean;
  forceEpoch: ((replay: readonly unknown[]) => boolean) | undefined }): Promise<{ plan?: FcaHistoryPlan }> {
  const { step, ports, window, policy, ahead, state } = parts;
  if (!ahead || !ports.summarizer) return { plan: planFcaHistory(window, ports.codec, policy, parts.settling, parts.forceEpoch) };
  if (!state.installed && await installAhead(step, ports, window, ahead, parts.checked)) {
    state.installed = true;
    ahead.note?.('installed');
    return {};
  }
  const plan = planFcaHistory(window, ports.codec, policy, parts.settling && !state.installed, parts.forceEpoch);
  if (plan.kind === 'ready' || parts.forceEpoch) return { plan };
  const next = await aheadStep(step.taskId, window, plan, policy, ahead, ports, state.waited);
  if (next.waited) state.waited = true;
  return next.replay ? { plan: { kind: 'ready', replay: next.replay } } : next.waited ? {} : { plan };
}

/**
 * Past the policy (mb-llmc r3): within the hard bounds, the whole replay, with the summary asked beside the step when none is pending
 * (or the last came back unusable `AHEAD_RETRY_ROUNDS` rounds ago); past them, one wait for a pending one. Else nothing: the step summarizes.
 */
async function aheadStep(taskId: string, window: TaskHistoryWindow, plan: Extract<FcaHistoryPlan, { kind: 'compact' }>, policy: FcaHistoryPolicy,
  ahead: FcaHistoryAheadOptions, ports: FcaHistoryPorts, waited: boolean): Promise<{ replay?: FcaHistoryReplay; waited?: boolean }> {
  const conversation = ahead.urgent ? { maximumConversationTokens: Math.max(policy.maximumReplayTokens, ahead.hard.maximumConversationTokens ?? 0) } : {};
  const hard = planFcaHistory(window, ports.codec, { ...policy, ...aheadRoom(policy), ...ahead.hard, ...conversation }, false);
  const prepared = ahead.port.get(taskId);
  if (hard.kind === 'ready') {
    if (!prepared || (prepared.state === 'failed' && window.tailSequence - prepared.tail >= AHEAD_RETRY_ROUNDS)) {
      startAhead(taskId, plan, window, ahead, ports.summarizer!);
      ahead.note?.('started');
    }
    return { replay: hard.replay };
  }
  if (prepared?.state !== 'pending' || waited) return {};
  ahead.note?.('waited');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([prepared.done, new Promise<void>(resolve => { timer = setTimeout(resolve, ahead.waitMs ?? AHEAD_WAIT_MS); })]);
  clearTimeout(timer);
  return { waited: true };
}

/** The summaries made beside the steps, by task (in memory, at most 32 tasks). */
export function createFcaHistoryAhead(): FcaHistoryAhead {
  const kept = new Map<string, FcaHistoryPrepared>();
  return {
    get: taskId => kept.get(taskId),
    set(taskId, prepared) {
      kept.delete(taskId);
      kept.set(taskId, prepared);
      if (kept.size > 32) kept.delete(kept.keys().next().value as string);
    },
    clear: taskId => { kept.delete(taskId); },
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
  ahead.port.clear(step.taskId);
  const projected = projectedRounds(window, ports.codec);
  await checked();
  return observeSync('compact', { phase: 'commit_ahead', roundCount: prepared.sequences.length }, () => ports.runtime.commitCompaction(step, {
    baseRevision: window.revision, sourceRevision: window.sourceRevision, tailSequence: window.tailSequence, sequences: prepared.sequences,
    retained: projected.slice(prepared.sequences.length), template: prepared.template }, ports.sourcesVisible), committed => ({ committed }));
}