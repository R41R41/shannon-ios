import { observeAsync, observeSync, observerHandoff } from '../../../infra/observer/observerContext.js';
import { renderedCompaction, type CompactionMessage } from '@shannon/mind';
import type { TaskHistoryWindow, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaHistoryCodec, FcaHistoryPlan, FcaHistoryPolicy, FcaHistoryPorts, FcaHistoryReplay, FcaHistorySummaryInput } from './fcaHistoryPorts.js';

export const FCA_HISTORY_POLICY: Readonly<FcaHistoryPolicy> = Object.freeze({
  maximumNativeCharacters: 64_000, maximumRounds: 24, recentRounds: 6,
  maximumSummaryCharacters: 32_000, maximumBatches: 8,
});
function policyOf(overrides: Partial<FcaHistoryPolicy>): FcaHistoryPolicy {
  const policy = { ...FCA_HISTORY_POLICY, ...overrides };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1)
    || policy.maximumRounds < policy.recentRounds) throw new Error('FCA_HISTORY_POLICY');
  return policy;
}
const size = (value: unknown): number => JSON.stringify(value).length;

/**
 * Every covered native round appears in the summary input, whole and in original order; only a round longer than the summary input by
 * itself has its longest texts shortened there, with the cut marked (`clippedRound`). Native history is never cut.
 */
export function planFcaHistory(window: TaskHistoryWindow, codec: FcaHistoryCodec,
  overrides: Partial<FcaHistoryPolicy> = {}): FcaHistoryPlan {
  const policy = policyOf(overrides);
  const projected = window.rounds.map(round => {
    const messages = codec.project(round);
    if (!messages) throw new Error('FCA_HISTORY_INCOMPLETE_ROUND');
    const outcome: CompactionMessage = { id: `fca-round:${round.sequence}:status`, role: 'assistant',
      content: `Committed task status after this round: ${round.status}. A requested completion is not proof of completion.` };
    return { sequence: round.sequence, stepId: round.stepId, messages: [...messages, outcome] };
  });
  if (window.summary && (!window.summary.bootstrapText || window.summary.resetThroughSequence < window.summary.throughSequence)) {
    throw new Error('FCA_HISTORY_EPOCH_MISSING');
  }
  const history = [
    ...window.summary ? codec.bootstrap(window.summary.bootstrapText) : [],
    ...window.rounds.filter(round => round.sequence > (window.summary?.resetThroughSequence ?? 0)).flatMap(round => [...round.entries]),
  ];
  if (window.rounds.length <= policy.maximumRounds && size(history) <= policy.maximumNativeCharacters) {
    const summary = window.summary?.template ?? null;
    return { kind: 'ready', replay: { history, summary, summaryText: summary ? renderedCompaction(summary, 'text') : '' } };
  }
  // The newest rounds stay native; when they alone are too long (a research round's web results are 30,000–40,000 characters:
  // owner test 2026-10-13, two rounds of 41,554 and 33,778 left the task unknown with FCA_HISTORY_RECENT_LIMIT), fewer stay,
  // down to the newest one. Only a newest round too long by itself still holds.
  const recent = Math.min(policy.recentRounds, projected.length - 1);
  const eligible = recent > 0 ? projected.slice(0, -recent) : [];
  if (!eligible.length) throw new Error('FCA_HISTORY_RECENT_LIMIT');
  const input = summaryInput(eligible, window.summary?.template ?? null, policy.maximumSummaryCharacters);
  if (!input.rounds.length) throw new Error('FCA_HISTORY_ROUND_LIMIT');
  return { kind: 'compact', input, request: { baseRevision: window.revision, sourceRevision: window.sourceRevision,
    tailSequence: window.tailSequence, sequences: input.rounds.map(round => round.sequence), retained: projected.slice(input.rounds.length) } };
}

/** The shortest any message of a clipped round becomes: enough to say what it was. */
const CLIPPED_MESSAGE_CHARACTERS = 400;
type ProjectedRound = { sequence: number; stepId: string; messages: CompactionMessage[] };

/**
 * One round for the summary input with its longest texts cut (the end marked) until the input fits, or null when it cannot.
 * Every message stays, with its id, role and call id.
 */
function clippedRound(round: ProjectedRound, previous: unknown, maximum: number): ProjectedRound | null {
  const messages = round.messages.map(message => ({ ...message }));
  const over = () => size({ previous, rounds: [{ ...round, messages }] }) - maximum;
  for (let guard = 0; guard < messages.length * 4 && over() > 0; guard++) {
    const longest = messages.reduce((best, message) => message.content.length > best.content.length ? message : best);
    if (longest.content.length <= CLIPPED_MESSAGE_CHARACTERS) return null;
    let keep = Math.max(CLIPPED_MESSAGE_CHARACTERS, longest.content.length - over() - 64);
    // Never between the halves of a surrogate pair (review of 1a647abc).
    if (/[\uD800-\uDBFF]/u.test(longest.content[keep - 1] ?? '')) keep -= 1;
    longest.content = `${longest.content.slice(0, keep)}…（要約用に後略: ${longest.content.length - keep}字）`;
  }
  return over() > 0 ? null : { ...round, messages };
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
    const clipped = input.rounds.length ? null : clippedRound(round, previous, maximum);
    if (clipped) input.rounds.push(clipped);
    break;
  }
  return input;
}

/** Uses the current action permit; derived summary writes never enqueue work or retry a model call. */
export async function prepareFcaHistory(step: TaskStep, ports: FcaHistoryPorts, signal: AbortSignal,
  overrides: Partial<FcaHistoryPolicy> = {}): Promise<FcaHistoryReplay> {
  const policy = policyOf(overrides);
  const checked = async () => {
    signal.throwIfAborted();
    if (!ports.sourcesVisible() || !await ports.permit()) throw new Error('FCA_HISTORY_HELD');
    signal.throwIfAborted();
    if (!ports.sourcesVisible() || ports.runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_HISTORY_HELD');
  };
  for (let batches = 0; ; batches++) {
    await checked();
    const window = ports.runtime.history(step.scopeKey, step.taskId, step.messageIds);
    if (!window) throw new Error('FCA_TASK_NOT_FOUND');
    const plan = planFcaHistory(window, ports.codec, policy);
    if (plan.kind === 'ready') {
      if (batches > 0) observerHandoff('compact', 'context', { phase: 'history_replay', compactedBatches: batches });
      return plan.replay;
    }
    if (!ports.summarizer) throw new Error('FCA_HISTORY_SUMMARIZER_REQUIRED');
    if (batches >= policy.maximumBatches) throw new Error('FCA_HISTORY_COMPACTION_LIMIT');
    observerHandoff('fca', 'compact', { roundCount: plan.input.rounds.length, batch: batches });
    const template = await observeAsync('compact', { phase: 'summarize', roundCount: plan.input.rounds.length, batch: batches },
      () => ports.summarizer!.summarize(plan.input, signal));
    await checked();
    if (!observeSync('compact', { phase: 'commit', roundCount: plan.input.rounds.length },
      () => ports.runtime.commitCompaction(step, { ...plan.request, template }, ports.sourcesVisible), committed => ({ committed }))) throw new Error('FCA_HISTORY_COMMIT_FENCED');
  }
}
