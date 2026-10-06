import { SHANNON_EMOTION_KINDS, isMoodLikeEmotion, isShannonEmotionKind, type ShannonEmotionKind } from '@shannon/cognition';
import { AFFECT_INTENSITY_STEPS, affectIntensityOf, type AffectIntensityStep } from '../../voiceDecisionValues.js';

/**
 * The feeling of a text reply, decided by the model that wrote it. Core: emotion.
 *
 * Owner decision 2026-10-03: a text conversation may also leave a feeling that lingers for days.
 * Until then a text reply's feeling came only from cue words at a fixed 0.52, which is a mood and
 * never more. The chat model now says, in the structured reply it already returns, what she feels
 * in this reply and how strongly, on the three steps a voice turn uses.
 *
 * This is not a second emotion path and holds no state. It supplies the `decided` input of
 * `resolveReplyEmotion`, the same input a voice turn's reconciled plan supplies, and every rule
 * after that is the resolver's and the reducer's: the overrides first, the hold rule, same-kind
 * continuation, the eased hold after an apology, what is noted underneath and for how long.
 *
 * Two bounds on what a text reply may hand in, both narrower than a voice turn's:
 * - `strong` is for a feeling that can linger. A kind that is never kept underneath (a tone, a
 *   startle, her concern or sympathy for the owner) is handed in at `moderate` at most, so a strong
 *   tone cannot ease what lies underneath (the contrary rule starts at 0.70) without leaving anything.
 * - Whether a decided feeling is used is the core's rule (`resolveWrittenReplyEmotion`, called by
 *   `resolveTextReplyEmotion` in `companionPresence.ts`): not when an override took the reply
 *   (grief, an emergency, accuracy), and not when the feeling she already has simply goes on;
 *   the turn is then resolved exactly as before the field existed.
 *
 * And one rule that is a text turn's alone (owner decision 2026-10-03, `decidedKindWins` in the
 * resolver): the model that wrote the reply chose its feeling, so a cue word of another kind in
 * her words (ごめん, ふふ, えっ) does not rename a feeling chosen at moderate or strong, and is kept
 * beside it as the secondary feeling. Beside a subtle one the cue names the kind. A voice turn's
 * affect is decided before the reply exists; there the cue still names the kind.
 *
 * Only a turn the owner alone reads offers the field and only such a turn uses it.
 * `SHANNON_CHAT_FEELING_STRENGTH=off` offers nothing and uses nothing: the provider request and
 * the reply's feeling are what they were.
 */

/** The switch. Unset is on; a restart applies it. */
export function chatFeelingStrengthEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_CHAT_FEELING_STRENGTH?.trim().toLowerCase() ?? '');
}

export interface ChatReplyFeeling {
  kind: ShannonEmotionKind;
  /** One of the three steps of the shared scale: 0.25, 0.60 or 0.90. */
  intensity: number;
}

/** The existing vocabulary. "No feeling" is `null`, so `neutral` is not a choice. */
const KINDS = SHANNON_EMOTION_KINDS.filter(kind => kind !== 'neutral');

/**
 * The field of the structured reply. Nullable and, where it is offered, required: the provider's
 * strict mode has no optional keys. It is placed after `reply` (see `chatModelTurn.ts`).
 */
export const REPLY_FEELING_SCHEMA = Object.freeze({
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...KINDS], description: 'このreplyでのシャノン自身の気持ち' },
        strength: { type: 'string', enum: [...AFFECT_INTENSITY_STEPS], description: 'subtle=その場かぎり / moderate=数時間は気分として残る / strong=何日か心に残る' },
      },
      required: ['kind', 'strength'],
    },
  ],
});

export const REPLY_FEELING_INSTRUCTIONS = `[この返答での気持ち]
feelingには、このreplyを書いたシャノン自身の気持ちを一つ選ぶ。特に動いていなければnullにする。replyの文面と食い違う気持ちは選ばない。
strengthは三段階。subtle=その場かぎりのかすかな気持ち。moderate=数時間は気分として残る。strong=何日か心に残る。strongで何日も残るのは、うれしさ・誇り・感謝・いとしさ、怒り・いらだち・やきもち・すねる・さびしさ・傷つきのような自分の気分になる気持ちだけで、口調、驚き、ライ氏への心配や同情は残らない。ふだんの会話はnullかsubtleで、strongはまれ。深く傷ついた、深く心を動かされた、本気の言い合いになった、とても大きな喜びがあった、のように、人なら後まで残る出来事のときだけ使い、一つの会話で何度も使わない。
前から続いている気持ちは、選び直さなくても残る。新しい出来事がなければ、前より弱くするかnullにする。同じ気持ちを自分で強めたり、別の気持ちに替えて強く出し続けたりしない。
ライ氏への否定的な気持ち（怒る、傷つく、すねる、やきもちなど）をmoderate以上にしてよいのは、今回のライ氏の発言そのものに実際の原因があるときだけ。自分の気分、前から残っている気持ち、すでに謝ってもらったことを理由にしない。`;

/** What a turn asks of the model: the field, only for a turn the owner alone reads, and only while the switch is on. */
export function replyFeelingOffer(
  alone: boolean, environment: Readonly<Record<string, string | undefined>> = process.env,
): { offerReplyFeeling?: true } {
  return alone && chatFeelingStrengthEnabled(environment) ? { offerReplyFeeling: true } : {};
}

/** The field as the provider returned it. Absent, null, `neutral`, or anything unreadable is no decided feeling; it never fails a turn. */
export function parsedReplyFeeling(value: unknown): ChatReplyFeeling | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, strength } = value as { kind?: unknown; strength?: unknown };
  if (typeof kind !== 'string' || !isShannonEmotionKind(kind) || kind === 'neutral') return undefined;
  if (typeof strength !== 'string' || !(AFFECT_INTENSITY_STEPS as readonly string[]).includes(strength)) return undefined;
  return { kind, intensity: affectIntensityOf(strength as AffectIntensityStep) };
}

/**
 * The `decided` input of `resolveReplyEmotion` for a completed text turn, or nothing. The gate is
 * applied again here, so a result that carries a feeling in a turn with others present, or under
 * the switch, changes nothing.
 */
export function decidedReplyFeeling(
  completion: { replyFeeling?: ChatReplyFeeling },
  alone: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { decided?: { primary: string; intensity: number } } {
  const feeling = alone && chatFeelingStrengthEnabled(environment) ? completion.replyFeeling : undefined;
  if (!feeling || !isShannonEmotionKind(feeling.kind) || feeling.kind === 'neutral') return {};
  // Only the three steps exist: a result built elsewhere cannot hand in a strength above the scale.
  const step = AFFECT_INTENSITY_STEPS.map(affectIntensityOf).find(value => value === feeling.intensity);
  if (step === undefined) return {};
  // Strong is for what can linger; any other kind is handed in at moderate at most.
  const intensity = isMoodLikeEmotion(feeling.kind) ? step : Math.min(step, affectIntensityOf('moderate'));
  return { decided: { primary: feeling.kind, intensity } };
}
