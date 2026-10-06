import { autonomyDayKey, yenFromUsd } from '../../inhibition/inhibitionPorts.js';
import { storyNotes } from './autonomyLoopPlan.js';
import {
  AUTONOMY_REACH_OUT_MAXIMUM_CHARACTERS, REACH_OUT_REASON_LABEL, parsedModelObject, reachOutPrompt,
  type PromptUpcoming, type ReachOutReason,
} from './autonomyLoopPrompts.js';
import { agenticLoop, observeReachOut, ownerRepliedAt } from './autonomyLoopObserve.js';
import { heldForOthers, unmarkedOnly } from './autonomyLoopProvenance.js';
import type { AutonomyLoopCycle, AutonomyPlannedStep } from './store/autonomyLoopState.js';
import type { PreparedStep, StepDependencies } from './autonomyLoopSteps.js';
import { autonomyModelCostUsd } from './autonomyModels.js';
import { AUTONOMY_REACH_OUT_TOOL } from '../../inhibition/inhibitionPorts.js';
import { AutonomyModelError, resolveAutonomyModel } from './autonomyTextModel.js';
import { STUDY_STATUS_LABEL } from './store/studyStore.js';

/**
 * The step 「話しかける」 (owner decision 2026-10-02): from her own activity she may write one
 * short message to the owner, up to a few times a day, with a declared reason from a closed set.
 *
 * She does not speak up while a conversation is in progress, nor within the spacing after her
 * last such message; there are no quiet hours, by the owner's decision. The gate counts the
 * day's messages. The step makes one model call and hands the text to the same path every
 * message she starts on her own takes: the owner's Talk, an initiative, a push. This file names
 * interfaces only: it opens no conversation, calendar or memory store.
 */
export interface AutonomyReachOuts {
  /** Messages she started on the owner-local day. */
  sentOn(scopeKey: string, dayKey: string): number;
  lastSentAt(scopeKey: string): string | null;
  /** While someone other than the owner may see or hear her body: the speak-time rule text and the marker for owner-private lines. Otherwise null. */
  audience(scopeKey: string, at: string): { instructions: string; marker: string } | null;
  say(scopeKey: string, input: { reason: ReachOutReason; text: string; dayKey: string; maximumPerDay: number }, at: string): 'sent' | 'limit' | 'unavailable';
  /**
   * Her opening line of a call to his iPhone (`autonomyLoopPhoneStep.ts`), written as a message of hers. It is not one of
   * the day's messages: calls have no count of their own, and take none of `maximumPerDay`.
   */
  sayByPhone?(scopeKey: string, input: { reason: ReachOutReason; text: string; dayKey: string }, at: string): 'sent' | 'limit' | 'unavailable';
  /** The newest message she started: its initiative id, when it was written, and whether it is a second call. */
  latest?(scopeKey: string): { id: string; at: string; reason?: string } | null;
  /** The words of one of her own messages (owner decision 2026-10-02, ADR-0003): for the second call that follows it. Null when it is not hers. */
  text?(scopeKey: string, initiativeId: string): string | null;
  /** Second calls she made on the owner-local day. */
  followUpsOn?(scopeKey: string, dayKey: string): number;
  /** Whether the message with this id was already called after. */
  followedUp?(scopeKey: string, originId: string): boolean;
  /** The one second call after her message `originId` got no answer. `seen`: its words were written with her note of a look in front of her. */
  sayAgain?(scopeKey: string, input: { originId: string; text: string; dayKey: string; maximumPerDay: number; seen?: boolean }, at: string): 'sent' | 'limit' | 'unavailable';
}

/** The owner's upcoming items as bounded lines; `others` leaves out what he keeps from the people present. */
export interface AutonomyUpcoming {
  lines(scopeKey: string, at: string, present: 'owner' | 'others'): readonly PromptUpcoming[];
}

export const REACH_OUT_TOOL = AUTONOMY_REACH_OUT_TOOL;
/** Recorded when she decided, having thought about it, to stay silent; not counted as a message. */
export const REACH_OUT_HELD_TOOL = 'owner.reach_out_held';
/** A conversation turn this recent counts as a conversation in progress, even when the cycle began before it. */
export const REACH_OUT_OWNER_QUIET_MILLISECONDS = 10 * 60_000;
const OUTPUT_TOKENS = 600;

export function conversationInProgress(dependencies: StepDependencies, scopeKey: string, at: string): boolean {
  const quiet = Math.max(dependencies.loop.ownerActiveMilliseconds, REACH_OUT_OWNER_QUIET_MILLISECONDS);
  return dependencies.showing.ownerActiveSince(scopeKey, new Date(Date.parse(at) - quiet).toISOString());
}

/** How many more times she may speak up today, or 0 while she may not: switched off, used up, too soon, or a conversation in progress. */
export function reachOutsRemaining(dependencies: StepDependencies, scopeKey: string, at: string): number {
  const { reachOuts, config, loop } = dependencies;
  if (!reachOuts || config.maximumReachOutsPerDay < 1) return 0;
  try {
    const remaining = config.maximumReachOutsPerDay - reachOuts.sentOn(scopeKey, autonomyDayKey(at, config));
    if (remaining < 1) return 0;
    const last = reachOuts.lastSentAt(scopeKey);
    if (last && Date.parse(at) - Date.parse(last) < loop.reachOutSpacingMilliseconds) return 0;
    return conversationInProgress(dependencies, scopeKey, at) ? 0 : remaining;
  } catch { return 0; }
}

export function prepareReachOut(dependencies: StepDependencies, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, at: string): PreparedStep | null {
  const { store, config, reachOuts, upcoming } = dependencies;
  const reason = step.reason;
  if (!reason || reason === 'follow_up' || !reachOuts || reachOutsRemaining(dependencies, cycle.scopeKey, at) < 1) return null;
  const others = reachOuts.audience(cycle.scopeKey, at);
  // With anyone else present, what she wrote after reading the owner's documents is not material for a message (ADR-0007).
  // In a session that is not marked, nothing marked either (`unmarkedOnly`).
  const shown = unmarkedOnly(dependencies, cycle, others !== null);
  // Each reason has its own material, and nothing to be about means nothing to say.
  const notes = reason === 'share' ? storyNotes(store, cycle.scopeKey, undefined, 12, false, shown).filter(note => !note.seen).slice(0, 4) : [];
  const stories = reason === 'share' ? store.study.list(cycle.scopeKey).filter(piece => piece.kind === 'story' && piece.status !== 'put_away' && shown(piece)).slice(0, 3)
    .map(piece => ({ title: piece.title, statusLabel: STUDY_STATUS_LABEL[piece.status] })) : [];
  const items = reason === 'upcoming' ? upcoming?.lines(cycle.scopeKey, at, others ? 'others' : 'owner') ?? [] : [];
  // What she saw in this cycle: her own note of that look, never a frame.
  const seen = reason === 'saw' ? store.study.list(cycle.scopeKey)
    .filter(piece => piece.kind === 'note' && piece.origin === 'room_look' && piece.status !== 'put_away' && piece.createdAt >= cycle.startedAt)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.body : undefined;
  if ((reason === 'share' && !notes.length && !stories.length) || (reason === 'upcoming' && !items.length) || (reason === 'saw' && !seen)) return null;
  // What she knows of him, without anything that must reach nobody else: her words may be seen or heard beyond him.
  let owned: string | null = null;
  try {
    owned = dependencies.loop.ownerContext ? dependencies.ownerContext?.forMessage(cycle.scopeKey, at, notes.map(note => note.title).join(' '), others !== null)?.section ?? null : null;
  } catch { owned = null; }
  const prompt = reachOutPrompt({ reason, localTime: localTime(at, config.timeZone), notes, stories, upcoming: items, ...(seen ? { seen } : {}), others, ...(owned ? { ownerContext: owned } : {}), ...(dependencies.loop.ownerContext && dependencies.ownerContext ? { notesPrivate: true } : {}) });
  const model = resolveAutonomyModel('prose', store.modelPreferences(cycle.scopeKey), id => dependencies.model.canUse(id));
  if (!model) return null;
  const estimate = { inputTokens: Math.ceil((prompt.system.length + prompt.prompt.length) * 1.5) + 64, outputTokens: OUTPUT_TOKENS };
  const costUsd = autonomyModelCostUsd(model, estimate, config.modelPrices);
  if (costUsd === null) return null;
  const label = REACH_OUT_REASON_LABEL[reason];
  return {
    request: {
      domain: 'owner_message', summary: `持ち主に、自分から一言話しかけます（理由: ${label}）。`, tool: REACH_OUT_TOOL,
      paid: { model, estimatedCostYen: yenFromUsd(costUsd, config) },
    },
    purpose: 'prose', estimate,
    async perform(adapters, performAt, signal) {
      if (!adapters.model || !adapters.reachOuts) return { outcome: 'failed', summary: '話しかける道具が渡されなかったため、話しかけませんでした。' };
      // He may have started talking since the plan was made: then she stays out of it, and nothing is spent.
      if (conversationInProgress(dependencies, cycle.scopeKey, performAt)) {
        return { outcome: 'failed', summary: `話している最中なので、話しかけませんでした（理由: ${label}）。`, reasonCode: 'conversation_in_progress' };
      }
      let reply: Record<string, unknown> | null = null;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        const result = await adapters.model.generate({ model, system: prompt.system, prompt: prompt.prompt, maximumOutputTokens: OUTPUT_TOKENS, signal });
        reply = parsedModelObject(result.text);
        usage = result.usage;
      } catch (error) {
        // An error the provider answered with is charged what it reported; no answer at all is charged the estimate.
        usage = error instanceof AutonomyModelError ? error.usage : estimate;
        return { outcome: 'failed', summary: `話しかけようとしましたが、言葉になりませんでした（理由: ${label}）。`, reasonCode: 'model_failed', ...(usage ? { usage } : {}) };
      }
      if (!reply || typeof reply.message !== 'string') return { outcome: 'failed', summary: `話しかけようとしましたが、言葉になりませんでした（理由: ${label}）。`, reasonCode: 'model_failed', usage };
      const text = reply.message.replace(/\s+/gu, ' ').trim().slice(0, AUTONOMY_REACH_OUT_MAXIMUM_CHARACTERS);
      // Silence is hers to choose.
      if (!text) return { outcome: 'done', usage, tool: REACH_OUT_HELD_TOOL, summary: `話しかけようかと思いましたが、やめておきました（理由: ${label}）。` };
      // While she watches what follows, the message carries the time it is written, not the time the step began: an owner turn
      // that arrived while the model was writing is then not an answer to it, and she does not speak over that turn.
      const agentic = agenticLoop(dependencies);
      const writeAt = agentic ? dependencies.now?.() ?? performAt : performAt;
      if (agentic && (conversationInProgress(dependencies, cycle.scopeKey, writeAt) || ownerRepliedAt(dependencies, cycle.scopeKey, performAt))) {
        return { outcome: 'failed', usage, summary: `話している最中なので、話しかけませんでした（理由: ${label}）。`, reasonCode: 'conversation_in_progress' };
      }
      // Someone else may have come while she wrote it: in a session that read the owner's documents she holds it.
      if (heldForOthers(dependencies, cycle, writeAt)) return { outcome: 'done', usage, tool: REACH_OUT_HELD_TOOL, reasonCode: 'others_present', summary: `ほかの人がいるので、話しかけるのをやめておきました（理由: ${label}）。` };
      let delivery: ReturnType<AutonomyReachOuts['say']>;
      try {
        delivery = adapters.reachOuts.say(cycle.scopeKey, { reason, text, dayKey: autonomyDayKey(writeAt, config), maximumPerDay: config.maximumReachOutsPerDay }, writeAt);
      } catch { delivery = 'unavailable'; }
      // What she said is in the Talk; the record keeps only that she spoke and why.
      if (delivery === 'sent') {
        const sent = agentic ? latestOf(adapters.reachOuts, cycle.scopeKey) : null;
        if (!sent) return { outcome: 'done', usage, summary: `持ち主に話しかけました（理由: ${label}）。` };
        // Syzygy ADR-0008 stage 1: what she expects of it is opened now and settled by what she sees follow (`observeStep`).
        dependencies.prediction?.sent?.(cycle.scopeKey, { id: sent.id, reason, others: others !== null }, sent.at);
        // She stays with it for a short while: did he answer, and what did her body do with it. Facts only.
        let observed: Awaited<ReturnType<typeof observeReachOut>>;
        try {
          observed = await observeReachOut(dependencies, cycle.scopeKey, { id: sent.id, at: sent.at, reason }, { wait: true, signal });
        } catch {
          // The message is sent whatever comes of watching: the step is reported as before.
          return { outcome: 'done', usage, summary: `持ち主に話しかけました（理由: ${label}）。` };
        }
        return {
          outcome: 'done', usage, observed, reasonCode: observed.replied ? 'replied' : 'no_reply',
          summary: `持ち主に話しかけました（理由: ${label}）。${observed.replied ? '返事がありました。' : observed.waitedSeconds >= 60 ? `${Math.round(observed.waitedSeconds / 60)}分待ちましたが、返事はまだありません。` : '返事はまだありません。'}`,
        };
      }
      return {
        outcome: 'failed', usage, reasonCode: delivery === 'limit' ? 'daily_limit' : 'nowhere_to_speak',
        summary: delivery === 'limit' ? `今日はもう十分に話しかけたので、やめておきました（理由: ${label}）。` : `話しかける場所がなかったので、話しかけませんでした（理由: ${label}）。`,
      };
    },
  };
}

function latestOf(reachOuts: AutonomyReachOuts, scopeKey: string): { id: string; at: string } | null {
  try { return reachOuts.latest?.(scopeKey) ?? null; } catch { return null; }
}

function localTime(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  } catch {
    return at.slice(0, 16);
  }
}
