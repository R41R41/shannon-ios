/** The vocabulary of her own messages where they leave: the source keys of her initiatives, what a delivery point answers, and the line her messages carry when others may see them (Syzygy ADR-0008 stage 3, S2: moved unchanged out of `reachOutDelivery.ts`, which now names the vocabulary and the speaker). */
import { OBSERVED_REACH_OUT_REASONS, type ObservedReachOutReason } from '../../contracts/autonomyObservationContract.js';
import type { ProactiveDeliveryHold } from '../../mind/attention/attentionPorts.js';
import { speakTimePrivacyCheck } from '../../mind/perception/voiceCompanionPresence.js';
import { UNLABELLED_DISCLOSURE_MARKER } from '@shannon/cognition';

/**
 * A message she starts on her own, from her own activity (owner decision 2026-10-02),
 * delivered the way she says anything unprompted: one assistant message in the owner's
 * most recent Talk and one initiative, which the apps, the push worker and her body read.
 *
 * It does not use the day's one spontaneous-topic slot. Its own key is
 * `reach-out:<owner-local day>:<n>`, and the unique day key of `initiative_messages`
 * makes the daily count hold even if two writers race. The message has no user side and
 * no `turn.completed` event, so nothing is learned about the owner from it.
 *
 * The one second call after a message got no answer (`follow_up`) leaves the same way and is not one
 * of the day's messages: its key is `reach-out-follow-up:<owner-local day>:<id of the message it follows>`,
 * so the same unique key allows one per message, and the day's count is read from those keys.
 */
export const REACH_OUT_SOURCE_PREFIX = 'reach-out:';

export const REACH_OUT_SOURCE_TITLE = 'シャノンから';

export const REACH_OUT_FOLLOW_UP_KEY_PREFIX = 'reach-out-follow-up:';

/**
 * The opening line of a call she places to his iPhone (owner decision 2026-10-03): a message of hers like any other,
 * under a key of its own, `reach-out-call:<owner-local day>:<random>`. It is not counted among the day's messages.
 */
export const REACH_OUT_CALL_KEY_PREFIX = 'reach-out-call:';

/** A second call whose prompt held her note of a look: the lock screen shows the fixed line of a look, as for `saw`. */
export const REACH_OUT_FOLLOW_UP_SEEN_SOURCE_PREFIX = `${REACH_OUT_SOURCE_PREFIX}follow_up:seen:`;

/** What a source reference says about a reach-out, or null. `GET /v1/initiatives` returns it as `kind` and `reason`. */
export function reachOutOfSource(sourceItemId: unknown): { kind: 'reach_out'; reason: ObservedReachOutReason } | null {
  if (typeof sourceItemId !== 'string' || !sourceItemId.startsWith(REACH_OUT_SOURCE_PREFIX)) return null;
  const reason = sourceItemId.slice(REACH_OUT_SOURCE_PREFIX.length).split(':')[0];
  return (OBSERVED_REACH_OUT_REASONS as readonly string[]).includes(reason ?? '') ? { kind: 'reach_out', reason: reason as ObservedReachOutReason } : null;
}

/** `held:<code>`: the proactive gate held it at this delivery point (Syzygy ADR-0008 stage 3); nothing was written. */
export type ReachOutDelivery = 'sent' | 'limit' | 'unavailable' | `held:${ProactiveDeliveryHold}`;

/**
 * What the prompt of a reach-out receives while someone other than the owner may see or hear her body:
 * the speak-time check and the marker of a conversation turn with other people present, unchanged.
 */
export const REACH_OUT_OTHERS_AUDIENCE = Object.freeze({
  instructions: [
    '[Other people may hear this — 同席者あり]\n- Her body reported that people other than ライ氏 can see or hear her now. This message is shown and spoken aloud by the body and may reach them.',
    speakTimePrivacyCheck,
  ].join('\n\n'),
  marker: UNLABELLED_DISCLOSURE_MARKER,
});
