import { renderedCompaction, type CompactionMessage } from '@shannon/mind';
import type { TaskHistoryWindow, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaHistoryCodec, FcaHistoryPlan, FcaHistoryPolicy, FcaHistoryPorts, FcaHistoryReplay } from './fcaHistoryPorts.js';

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

/** No truncation: every covered native round appears in the summary input, in original order. */
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
  const eligible = projected.slice(0, -policy.recentRounds);
  if (!eligible.length) throw new Error('FCA_HISTORY_RECENT_LIMIT');
  const input = { previous: window.summary?.template ?? null, rounds: [] as typeof projected };
  for (const round of eligible) {
    const candidate = { ...input, rounds: [...input.rounds, round] };
    if (size(candidate) > policy.maximumSummaryCharacters) break;
    input.rounds.push(round);
  }
  if (!input.rounds.length) throw new Error('FCA_HISTORY_ROUND_LIMIT');
  return { kind: 'compact', input, request: { baseRevision: window.revision, sourceRevision: window.sourceRevision,
    tailSequence: window.tailSequence, sequences: input.rounds.map(round => round.sequence), retained: projected.slice(input.rounds.length) } };
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
    if (plan.kind === 'ready') return plan.replay;
    if (!ports.summarizer) throw new Error('FCA_HISTORY_SUMMARIZER_REQUIRED');
    if (batches >= policy.maximumBatches) throw new Error('FCA_HISTORY_COMPACTION_LIMIT');
    const template = await ports.summarizer.summarize(plan.input, signal);
    await checked();
    if (!ports.runtime.commitCompaction(step, { ...plan.request, template }, ports.sourcesVisible)) throw new Error('FCA_HISTORY_COMMIT_FENCED');
  }
}
