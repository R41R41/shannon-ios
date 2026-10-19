import { actionPermit } from '../../../infra/context/actionExecution.js';
import { autonomyDayKey } from '../../inhibition/inhibitionPorts.js';
import { callModel, ownerLocalTime, paidCall } from './autonomyLoopCalls.js';
import { agenticLoop, followUpsRemaining, observeReachOut, ownerRepliedAt, reachOutChain } from './autonomyLoopObserve.js';
import { AUTONOMY_FOLLOW_UP_MAXIMUM_CHARACTERS, AUTONOMY_JOT_MAXIMUM_CHARACTERS, followUpPrompt, happenedLines } from './autonomyLoopObservePrompts.js';
import { heldForOthers } from './autonomyLoopProvenance.js';
import { REACH_OUT_HELD_TOOL, conversationInProgress, heldByGate, intentArisenAt, type ReachOutDeliveryAnswer } from './autonomyLoopReachOutStep.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';
import { AUTONOMY_REACH_OUT_FOLLOW_UP_TOOL } from '../../inhibition/inhibitionPorts.js';
import { withoutSilenceTally } from './ownWordsTally.js';

/**
 * What she may do after a message of hers got no answer (owner decision 2026-10-02), besides looking
 * at the room or letting it go: call once more, or write down what she thinks.
 *
 * The second call is one model call with the facts of the first message and her own words of it in
 * front of her (owner decision 2026-10-02, ADR-0003; never anything the owner said) and, when she
 * looked at the room after it in this cycle, her own note of that look. One per message, a few per day; the gate counts them apart from the day's
 * three messages. It is not made once he has written or spoken. This file names interfaces only.
 */
export const REACH_OUT_FOLLOW_UP_TOOL = AUTONOMY_REACH_OUT_FOLLOW_UP_TOOL;
export const JOT_TOOL = 'study.jot';
const OUTPUT_TOKENS = 400;

export function prepareFollowUp(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store, config, reachOuts } = dependencies;
  if (!agenticLoop(dependencies) || !reachOuts?.sayAgain || !step.originId) return null;
  const observations = store.loop.observations.ofCycle(cycle.id);
  const chain = reachOutChain(observations);
  // Only after the unanswered message of this very cycle, only once, and not once he has answered.
  if (!chain || chain.pending.id !== step.originId || followUpsRemaining(dependencies, cycle.scopeKey, at) < 1) return null;
  if (reachOuts.followedUp?.(cycle.scopeKey, chain.pending.id) !== false) return null;
  const origin = chain.pending;
  if (ownerRepliedAt(dependencies, cycle.scopeKey, origin.sentAt) || conversationInProgress(dependencies, cycle.scopeKey, at)) return null;
  const others = reachOuts.audience(cycle.scopeKey, at);
  // What she saw when she looked after that message: her own note of that look, never a frame.
  const seen = store.study.list(cycle.scopeKey)
    .filter(piece => piece.kind === 'note' && piece.origin === 'room_look' && piece.status !== 'put_away' && piece.createdAt >= origin.sentAt && piece.createdAt >= cycle.startedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.body;
  // Her own first message, in her words (owner decision 2026-10-02, ADR-0003), so the second call can follow from it.
  let said: string | null = null;
  try { said = reachOuts.text?.(cycle.scopeKey, origin.id) ?? null; } catch { said = null; }
  const happened = observations.filter(item => item.ordinal >= chain.ordinal).flatMap(item => happenedLines(item, { at, timeZone: config.timeZone }));
  const call = paidCall(dependencies, cycle.scopeKey, 'prose', followUpPrompt({
    localTime: ownerLocalTime(at, config.timeZone, true), happened, ...(said ? { said } : {}), ...(seen ? { seen } : {}), others,
  }), OUTPUT_TOKENS);
  if (!call) return null;
  const arisenAt = intentArisenAt(dependencies, cycle, at);
  return {
    request: {
      domain: 'owner_message', summary: '返事がなかったので、持ち主にもう一度だけ声をかけます。', tool: REACH_OUT_FOLLOW_UP_TOOL,
      paid: { model: call.model, estimatedCostYen: call.estimatedCostYen },
    },
    purpose: 'prose', estimate: call.estimate,
    async perform(adapters, performAt, signal) {
      if (!adapters.model || !adapters.reachOuts?.sayAgain) return { outcome: 'failed', summary: '話しかける道具が渡されなかったため、声をかけませんでした。' };
      // He answered, or is talking: there is nothing to follow, and nothing is spent.
      const stopped = (at: string, usage?: { inputTokens: number; outputTokens: number }) => (ownerRepliedAt(dependencies, cycle.scopeKey, origin.sentAt)
        ? { outcome: 'failed' as const, summary: '返事が来ていたので、もう一度は声をかけませんでした。', reasonCode: 'replied', ...(usage ? { usage } : {}) }
        : conversationInProgress(dependencies, cycle.scopeKey, at)
          ? { outcome: 'failed' as const, summary: '話している最中なので、もう一度は声をかけませんでした。', reasonCode: 'conversation_in_progress', ...(usage ? { usage } : {}) }
          : null);
      const before = stopped(performAt);
      if (before) return before;
      const { reply, usage } = await callModel(adapters, call, signal);
      if (!reply || typeof reply.message !== 'string') return { outcome: 'failed', summary: 'もう一度声をかけようとしましたが、言葉になりませんでした。', reasonCode: 'model_failed', usage };
      // Owner 2026-10-19: a second call does not count his quiet back at him (`ownWordsTally.ts`).
      const text = withoutSilenceTally(reply.message.replace(/\s+/gu, ' ').trim().slice(0, AUTONOMY_FOLLOW_UP_MAXIMUM_CHARACTERS));
      // Letting it go is hers to choose.
      if (!text) return { outcome: 'done', usage, tool: REACH_OUT_HELD_TOOL, summary: 'もう一度声をかけようかと思いましたが、そのままにしました。' };
      // The second call carries the time it is written, and is not made over a turn that arrived while the model was writing.
      const writeAt = dependencies.now?.() ?? performAt;
      const after = stopped(writeAt, usage);
      if (after) return after;
      // Someone else may have come while she wrote it: in a marked session she holds it (ADR-0007).
      if (heldForOthers(dependencies, cycle, writeAt)) return { outcome: 'done', usage, tool: REACH_OUT_HELD_TOOL, reasonCode: 'others_present', summary: 'ほかの人がいるので、もう一度声をかけるのはやめておきました。' };
      let delivery: ReachOutDeliveryAnswer;
      try {
        await actionPermit();
        delivery = adapters.reachOuts.sayAgain(cycle.scopeKey, {
          originId: origin.id, text, dayKey: autonomyDayKey(writeAt, config), maximumPerDay: config.maximumReachOutFollowUpsPerDay, seen: Boolean(seen), arisenAt,
        }, writeAt);
      } catch { delivery = 'unavailable'; }
      // Syzygy ADR-0008 stage 3: the proactive gate held it where it would have been written.
      const held = heldByGate(delivery, 'もう一度声をかけるの', usage);
      if (held) return held;
      if (delivery !== 'sent') {
        return {
          outcome: 'failed', usage, reasonCode: delivery === 'limit' ? 'daily_limit' : 'nowhere_to_speak',
          summary: delivery === 'limit' ? '今日はもう十分に声をかけ直したので、やめておきました。' : '話しかける場所がなかったので、声をかけませんでした。',
        };
      }
      let sent: { id: string; at: string } | null = null;
      try { sent = adapters.reachOuts.latest?.(cycle.scopeKey) ?? null; } catch { sent = null; }
      // Her words are in the Talk; the record keeps only that she called again. She does not wait a second time.
      const observed = sent ? await observeReachOut(dependencies, cycle.scopeKey, { id: sent.id, at: sent.at, reason: 'follow_up' }, { wait: false }) : undefined;
      return { outcome: 'done', usage, summary: '返事がなかったので、持ち主にもう一度だけ声をかけました。', ...(observed ? { observed } : {}) };
    },
  };
}

/** A short note of her own about it, in the words her thinking step chose. No model is called; one per cycle. */
export function prepareJot(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store, config } = dependencies;
  const body = step.intent?.replace(/\s+/gu, ' ').trim().slice(0, AUTONOMY_JOT_MAXIMUM_CHARACTERS);
  if (!agenticLoop(dependencies) || !body) return null;
  const observations = store.loop.observations.ofCycle(cycle.id);
  // Only about a message of this cycle, and only once.
  if (!observations.some(item => item.step === 'reach_out' && item.outcome === 'done' && item.reachOut) || observations.some(item => item.step === 'jot')) return null;
  return {
    request: { domain: 'aether_study', summary: '話しかけたあとで思ったことを、書斎に短いメモとして書きます。', tool: JOT_TOOL },
    async perform() {
      return {
        outcome: 'done', summary: '話しかけたあとで思ったことを、書斎のメモに書き留めました。',
        commit: (_remaining, commitAt) => {
          const piece = store.study.create(cycle.scopeKey, { kind: 'note', title: `話しかけたあとで（${localHour(commitAt || at, config.timeZone)}）`, body, origin: 'reach_out' }, commitAt);
          if (typeof piece === 'string') throw new Error(piece);
          return { link: `shannon-study://${piece.id}` };
        },
      };
    },
  };
}

function localHour(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, month: 'long', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).format(new Date(at));
  } catch {
    return at.slice(0, 13);
  }
}
