import {
  SHANNON_EMOTION_KINDS,
  type ShannonEmotionKind,
  type ShannonExpressiveEmotion,
} from './types.js';
import { accuracyOverrideApplies, supportOverrideFor } from './emotionOverrides.js';
import { SHANNON_EMOTION_CONTINUITY } from './emotionTime.js';

const EMOTION_SET = new Set<string>(SHANNON_EMOTION_KINDS);
const PLAYFUL = new Set<ShannonEmotionKind>([
  'giggle', 'teasing', 'mischievous', 'plotting', 'smug', 'deadpan',
  'harmlessFalsehood', 'selfDeprecating', 'dramaticLament',
]);
const ATTACHMENT = new Set<ShannonEmotionKind>([
  'jealous', 'sulky', 'leftOut', 'lonely', 'attentionSeeking', 'lightPossessive', 'reassurance',
]);
const HIGH_ENERGY = new Set<ShannonEmotionKind>([
  'excited', 'ecstatic', 'cuteAngry', 'seriousAnger', 'indignant', 'panic', 'scream',
  'shocked', 'triumphant', 'urgent',
]);
const LOW_ENERGY = new Set<ShannonEmotionKind>([
  'relief', 'shy', 'sad', 'disappointed', 'hurt', 'regret', 'helpless', 'tired',
  'sleepy', 'gentle', 'relaxed', 'content', 'quietCompanion', 'tender',
]);
const NEGATIVE = new Set<ShannonEmotionKind>([
  'cuteAngry', 'seriousAnger', 'annoyed', 'indignant', 'frustrated', 'jealous', 'sulky',
  'leftOut', 'lonely', 'sad', 'disappointed', 'hurt', 'anxious', 'regret', 'helpless',
  'lamenting', 'panic', 'blocked', 'tired', 'apologetic',
]);
const POSITIVE = new Set<ShannonEmotionKind>([
  'bright', 'playful', 'happy', 'fun', 'excited', 'ecstatic', 'relief', 'pride', 'gratitude', 'hope', 'affectionate',
  'giggle', 'smug', 'bashful', 'hidingHappiness', 'triumphant', 'gentle', 'relaxed', 'content', 'quietCompanion', 'tender',
]);
/** The moment's reaction: startle-like kinds that are gone within minutes. */
const REACTION = new Set<ShannonEmotionKind>([
  'surprised', 'shocked', 'stunned', 'speechless', 'panic', 'scream', 'flustered', 'giggle',
]);
/**
 * Kinds that are a state of hers with a cause between her and the owner, rather than a reaction or
 * a tone of voice: expressed strongly toward the owner they stay underneath as her mood. Two groups
 * are left out on purpose. Sadness, worry and regret are mostly her answer to the owner's bad news,
 * and that must stay concern for him, not a low mood of her own. Bright, gentle, relaxed and the
 * like are how a reply is delivered (a greeting is bright), and a tone must not cover a mood.
 */
const MOOD_LIKE = new Set<ShannonEmotionKind>([
  'happy', 'excited', 'ecstatic', 'pride', 'gratitude', 'affectionate', 'tender',
  'seriousAnger', 'annoyed', 'indignant', 'frustrated', 'jealous', 'sulky', 'leftOut', 'lonely', 'lightPossessive', 'hurt',
]);

/**
 * Her answer to the owner rather than a feeling of her own: concern, protection, reassurance,
 * apology, sympathy. A mood she is in, however strong, never keeps these from showing.
 */
const SUPPORT = new Set<ShannonEmotionKind>(['caring', 'protective', 'reassurance', 'apologetic', 'sad', 'anxious', 'regret']);

export function isSupportEmotion(kind: ShannonEmotionKind): boolean {
  return SUPPORT.has(kind);
}

/** -1 for an unpleasant feeling, 1 for a pleasant one, 0 for one that is neither. */
export function shannonEmotionSign(kind: ShannonEmotionKind): -1 | 0 | 1 {
  return NEGATIVE.has(kind) ? -1 : POSITIVE.has(kind) ? 1 : 0;
}

export function isReactionEmotion(kind: ShannonEmotionKind): boolean {
  return REACTION.has(kind);
}

export function isMoodLikeEmotion(kind: ShannonEmotionKind): boolean {
  return MOOD_LIKE.has(kind);
}

/**
 * Cues in Shannon's own completed reply. They describe how she just spoke, so
 * they are evidence of her feeling; the speaker's words are never matched here.
 * The first matching rule wins, so the character's core reactions come first.
 */
const FINAL_CUES: readonly { emotion: ShannonEmotionKind; pattern: RegExp }[] = [
  { emotion: 'flustered', pattern: /(?:あわわ|わわっ|はわわ|ち、違|ちょ、ちょっと待|そ、そんなはず|慌て)/u },
  { emotion: 'bashful', pattern: /(?:えへへ|照れ|恥ずか|赤くな|そんなこと言われ)/u },
  { emotion: 'smug', pattern: /(?:えっへん|ふふん|どやっ|ドヤ|さすがボク|ボクにかかれば|天才ですから|ボクは天才)/u },
  { emotion: 'giggle', pattern: /(?:ふふ|くすっ|笑っちゃ|おかしい)/u },
  { emotion: 'mischievous', pattern: /(?:企ん|悪戯|いたずら|内緒です|さては)/u },
  { emotion: 'cuteAngry', pattern: /(?:もうっ|むー|ぷんぷん|ぷんすか|まったくもう)/u },
  { emotion: 'jealous', pattern: /(?:嫉妬|やきもち|ほかの子|他の子)/u },
  // 「すね」 alone also matches every 「ですね」, so the kana form needs its verb ending.
  { emotion: 'sulky', pattern: /(?:拗ね|(?<![でま])すね(?:ちゃ|て|ます|る)|別にいいですけど)/u },
  { emotion: 'surprised', pattern: /(?:えっ|まさか|びっくり|驚き)/u },
  { emotion: 'speechless', pattern: /(?:言葉が出|唖然|なんですって)/u },
  { emotion: 'apologetic', pattern: /(?:ごめん|申し訳|すみません)/u },
  { emotion: 'caring', pattern: /(?:大丈夫ですか|大丈夫[？?]|無理しない|無理は禁物|心配です|心配し|そばにい)/u },
  { emotion: 'determined', pattern: /(?:任せて|やります|取りかか|書くぞ|進めます)/u },
  { emotion: 'triumphant', pattern: /(?:やった|成功|完成|できました|天才)/u },
  { emotion: 'excited', pattern: /(?:楽しみ|わくわく|最高|嬉しい|うれしい)/u },
  { emotion: 'fun', pattern: /(?:爆笑|大笑い|笑いが止まら|あはは)/u },
  { emotion: 'deadpan', pattern: /(?:ジト目|呆れ|やれやれ)/u },
  { emotion: 'selfDeprecating', pattern: /(?:苦笑|はは…)/u },
  { emotion: 'annoyed', pattern: /(?:むっと|納得いきません|納得いかない)/u },
  { emotion: 'relief', pattern: /(?:ほっと|安心しました|よかったです|助かりました)/u },
  { emotion: 'curiosity', pattern: /(?:気になります|気になる|興味深|知りたいです|面白そう)/u },
  { emotion: 'sad', pattern: /(?:悲しい|寂しい|つらい|残念)/u },
  { emotion: 'confused', pattern: /(?:分からない|わからない|混乱|どういうこと)/u },
  { emotion: 'focused', pattern: /(?:考えてみます|整理します|検討します|うーん)/u },
  { emotion: 'sleepy', pattern: /(?:眠い|ふわぁ|おやすみなさい)/u },
  { emotion: 'gratitude', pattern: /(?:ありがとうございます|感謝)/u },
];

/** Below this carry-over a previous feeling no longer continues into a new turn. */
export const SHANNON_EMOTION_CARRY_THRESHOLD = 0.28;
export const SHANNON_SETTLED_CAUSE = '前の気持ちは時間とともに落ち着いた';
const REPLY_CAUSE = '生成した応答の内容と会話文脈';
const PROVISIONAL_CAUSE = 'Jevの暫定判断と会話文脈';
const CARRIED_CAUSE = '直前の感情が自然に続いている';
/** The resolver's own wordings for a feeling that came from conversation; anything else names what happened (a touch). */
export const SHANNON_CONVERSATION_CAUSES: readonly string[] = Object.freeze([REPLY_CAUSE, PROVISIONAL_CAUSE, CARRIED_CAUSE]);

export const INITIAL_SHANNON_EXPRESSIVE_EMOTION: Readonly<ShannonExpressiveEmotion> = Object.freeze({
  primary: 'neutral', secondary: Object.freeze([]), intensity: 0.15,
  target: '会話', cause: '会話開始時の落ち着いた基準状態', arousal: 0.30, valence: 0,
  visibility: 'hidden', startedAt: new Date(0).toISOString(), decay: 0.48, carryover: 0,
});

export interface ResolveShannonEmotionInput {
  /**
   * The stored feeling, carried to `now` here by the wall-clock rule; or a reading by
   * `presentShannonFeeling` (it has `presentAt`), used as it stands and held against a weaker stimulus.
   */
  previous?: ShannonExpressiveEmotion;
  provisionalPrimary: ShannonEmotionKind | string;
  provisionalIntensity: number;
  transcript: string;
  reply?: string;
  now: string;
  target?: string;
  /** The caller already decided by `holdsShannonFeeling` that this stimulus replaces the present feeling (a touch). */
  replaces?: boolean;
  /**
   * The provisional feeling was decided by the writer of the reply itself (a text turn's chat model), so it is the feeling
   * of that reply: a cue word of another kind in her words does not rename it and stays beside it as the secondary feeling.
   * Absent (a voice turn, whose provisional affect was decided before the reply existed), the cue names the kind as before.
   */
  decidedKindWins?: boolean;
}

export function isShannonEmotionKind(value: string): value is ShannonEmotionKind {
  return EMOTION_SET.has(value);
}

export function normalizeShannonExpressiveEmotion(
  emotion: ShannonExpressiveEmotion,
): ShannonExpressiveEmotion {
  const secondary = [...new Set(emotion.secondary)]
    .filter((value): value is ShannonEmotionKind => isShannonEmotionKind(value) && value !== emotion.primary)
    .slice(0, 2);
  const visibility = ['hidden', 'subtle', 'expressed'].includes(emotion.visibility) ? emotion.visibility : 'hidden';
  const overrideReason = ['safety', 'grief', 'emergency', 'correction', 'topic-change'].includes(emotion.overrideReason ?? '')
    ? emotion.overrideReason : undefined;
  return Object.freeze({
    primary: isShannonEmotionKind(emotion.primary) ? emotion.primary : 'neutral',
    secondary: Object.freeze(secondary), intensity: clamp(emotion.intensity, 0, 1),
    target: compact(emotion.target, 80) || '会話', cause: compact(emotion.cause, 240) || '会話文脈',
    arousal: clamp(emotion.arousal, 0, 1), valence: clamp(emotion.valence, -1, 1), visibility,
    startedAt: Number.isFinite(Date.parse(emotion.startedAt)) ? emotion.startedAt : new Date(0).toISOString(),
    decay: clamp(emotion.decay, 0, 1), carryover: clamp(emotion.carryover, 0, 1),
    ...(emotion.updatedAt && Number.isFinite(Date.parse(emotion.updatedAt)) ? { updatedAt: emotion.updatedAt } : {}),
    ...(overrideReason ? { overrideReason } : {}),
    ...(typeof emotion.awakeAt === 'number' && Number.isFinite(emotion.awakeAt) && emotion.awakeAt >= 0 ? { awakeAt: emotion.awakeAt } : {}),
  });
}

export function sameShannonExpressiveEmotion(
  left: ShannonExpressiveEmotion,
  right: ShannonExpressiveEmotion,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function restoreShannonExpressiveEmotion(
  value: unknown,
  fallback: ShannonExpressiveEmotion,
): ShannonExpressiveEmotion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalizeShannonExpressiveEmotion(fallback);
  const row = value as Record<string, unknown>;
  const primary = typeof row.primary === 'string' && isShannonEmotionKind(row.primary) ? row.primary : fallback.primary;
  const number = (candidate: unknown, defaultValue: number) => typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate : defaultValue;
  return normalizeShannonExpressiveEmotion({
    primary,
    secondary: Array.isArray(row.secondary)
      ? row.secondary.filter((item): item is ShannonEmotionKind => typeof item === 'string' && isShannonEmotionKind(item))
      : [],
    intensity: number(row.intensity, fallback.intensity),
    target: typeof row.target === 'string' ? row.target : fallback.target,
    cause: typeof row.cause === 'string' ? row.cause : fallback.cause,
    arousal: number(row.arousal, fallback.arousal), valence: number(row.valence, fallback.valence),
    visibility: row.visibility === 'subtle' || row.visibility === 'expressed' ? row.visibility : 'hidden',
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : fallback.startedAt,
    decay: number(row.decay, fallback.decay), carryover: number(row.carryover, fallback.carryover),
    ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    ...(typeof row.overrideReason === 'string'
      ? { overrideReason: row.overrideReason as ShannonExpressiveEmotion['overrideReason'] } : {}),
    ...(typeof row.awakeAt === 'number' ? { awakeAt: row.awakeAt } : {}),
  });
}

export function resolveShannonEmotionState(
  input: ResolveShannonEmotionInput,
): ShannonExpressiveEmotion {
  const transcript = compact(input.transcript, 2_000);
  const reply = compact(input.reply ?? '', 2_000);
  const combined = `${transcript}\n${reply}`;
  // A reading is already the feeling at `now` on her awake clock; a stored feeling is carried by the wall-clock rule.
  const reading = input.previous?.presentAt !== undefined;
  const previous = input.previous ? (reading ? input.previous : carriedShannonEmotion(input.previous, input.now)) : undefined;
  let primary = isShannonEmotionKind(input.provisionalPrimary) ? input.provisionalPrimary : 'neutral';
  let intensity = clamp(input.provisionalIntensity, 0, 1);
  const provisional = { primary, intensity };
  let overrideReason: ShannonExpressiveEmotion['overrideReason'];
  let cause = reply ? REPLY_CAUSE : PROVISIONAL_CAUSE;
  let fromCue = false;
  let cueBeside: ShannonEmotionKind | undefined;

  const support = supportOverrideFor(transcript);
  if (support === 'emergency') {
    primary = 'protective';
    intensity = Math.max(0.78, intensity);
    overrideReason = 'emergency';
    cause = '相手の安全を最優先する必要がある';
  } else if (support === 'grief') {
    primary = 'caring';
    intensity = Math.max(0.68, intensity);
    overrideReason = 'grief';
    cause = '深い悲しみや喪失へ静かに寄り添う';
  } else {
    const finalCue = FINAL_CUES.find(rule => rule.pattern.test(reply));
    if (finalCue && input.decidedKindWins && primary !== 'neutral' && finalCue.emotion !== primary) {
      // The writer of this reply decided its feeling: kind and strength stand, and the word is kept beside it.
      cueBeside = finalCue.emotion;
    } else if (finalCue) {
      primary = finalCue.emotion;
      intensity = Math.max(intensity, 0.52);
      // Her own words name the feeling. Its strength was decided for this reply only when the same kind was decided at
      // least as strongly as the cue's floor; a strength that comes from the floor alone is the cue's.
      fromCue = provisional.primary !== primary || provisional.intensity < intensity;
    } else if (!reading && primary === 'neutral' && previous && previous.primary !== 'neutral'
      && previous.carryover >= SHANNON_EMOTION_CARRY_THRESHOLD) {
      primary = previous.primary;
      intensity = Math.max(intensity, previous.intensity * previous.carryover);
      cause = CARRIED_CAUSE;
    }
  }

  const playsWith = (kind: ShannonEmotionKind) => accuracyOverrideApplies(combined, kind, PLAYFUL.has(kind) || ATTACHMENT.has(kind));
  // Play in her words is still play when the decided kind stands beside it: accuracy replaces it as before.
  if (playsWith(primary) || (cueBeside !== undefined && playsWith(cueBeside))) {
    primary = /(?:ごめん|申し訳|失敗)/u.test(combined) ? 'apologetic' : 'focused';
    intensity = Math.min(0.72, Math.max(0.45, intensity));
    overrideReason = 'safety';
    cause = '事実・安全・記憶・進捗では遊びより正確さを優先する';
  }

  let strongerAgain = false;
  if (reading && previous && previous.primary !== 'neutral') {
    // The same feeling again, from a stimulus that is not stronger than what she feels, is that feeling going on:
    // nothing is stored, so it can neither grow nor be raised back to this reading later. Only a stimulus that is
    // itself stronger is a new feeling, at its own strength. A weaker stimulus of another kind does not replace it.
    if (previous.primary === primary && !overrideReason) {
      // A touch the caller already let through is felt as that touch, each time, at the touch's own strength.
      if (!input.replaces) {
        // What was decided for this reply, before the cue's floor: only that can be stronger than what she feels.
        const decidedStrength = provisional.primary === primary ? provisional.intensity : 0;
        // An unpleasant feeling toward the owner (what his apology eases) that her own words name, also to deny it, is
        // that feeling going on whatever the cue's strength. Her concern, her apology and a pleasant feeling voiced
        // again are felt anew for that reply, at the cue's strength.
        const easable = shannonEmotionSign(primary) < 0 && !SUPPORT.has(primary);
        // He eased it a moment ago: nothing short of its earlier height brings it back up.
        const eased = previous.easedPeak !== undefined && decidedStrength <= previous.easedPeak;
        if (eased || intensity <= previous.intensity || (decidedStrength <= previous.intensity && easable)) {
          return continuedShannonEmotion(previous, primary, input.now);
        }
      }
      strongerAgain = true;
    } else if (previous.primary === primary) {
      // The same override again (he is still in danger) is felt anew, at full strength.
      strongerAgain = true;
    } else if (!input.replaces && (holdsShannonFeeling(previous, { primary, intensity, overrideReason })
      // Her concern or apology on top does not lower the bar: the mood it covers still holds against a weaker stimulus.
      || (previous.underneath !== undefined && holdsShannonFeeling(previous.underneath, { primary, intensity, overrideReason })))) {
      return continuedShannonEmotion(previous, primary, input.now);
    }
  }

  const carried = previous && previous.primary !== primary
    && (reading ? previous.primary !== 'neutral' : previous.carryover >= 0.24)
    && !unsafeCombination(primary, previous.primary)
    ? [previous.primary]
    : [];
  // No override took the reply: the cue word her decided feeling did not follow is the feeling beside it.
  const secondary = cueBeside && !overrideReason && cueBeside !== primary && !unsafeCombination(primary, cueBeside)
    ? [cueBeside, ...carried.filter(kind => kind !== cueBeside)] : carried;
  const profile = emotionProfile(primary, intensity);
  const sameEpisode = previous?.primary === primary && !overrideReason;
  const decay = decayFor(primary);
  const carryover = clamp((sameEpisode ? previous.carryover : 0.35) + intensity * 0.32 - decay * 0.18, 0, 1);

  return Object.freeze({
    primary,
    secondary: Object.freeze(secondary),
    intensity,
    target: compact(input.target ?? 'ライ氏', 80) || 'ライ氏',
    cause,
    arousal: profile.arousal,
    valence: profile.valence,
    visibility: visibilityFor(intensity),
    startedAt: sameEpisode ? previous.startedAt : validTimestamp(input.now),
    decay,
    carryover,
    updatedAt: validTimestamp(input.now),
    ...(overrideReason ? { overrideReason } : {}),
    ...(strongerAgain ? { continued: false } : {}),
    ...(fromCue ? {} : { decided: true }),
  });
}

/**
 * Whether the feeling she has now stays when a new stimulus arrives. This is the one rule every
 * writer of the feeling goes through (a reply in text or voice, a touch, her line about a touch):
 * a feeling is not replaced by a weaker stimulus, which is kept as the secondary feeling instead.
 * It gives way to a stimulus that is at least as strong, to one of the opposite sign that is
 * strong in its own right, and to what she owes the owner: always to the overrides (emergency,
 * grief, accuracy), and to her concern, reassurance, apology and sympathy for him when they are
 * strong enough to show (0.30) and the present feeling is not itself held by an override.
 * A touch additionally never displaces a feeling held for the owner's sake, and a feeling that
 * itself came from a touch always gives way to the next touch.
 */
export function holdsShannonFeeling(
  present: Pick<ShannonExpressiveEmotion, 'primary' | 'intensity' | 'overrideReason'> | undefined,
  incoming: { primary: ShannonEmotionKind; intensity: number; overrideReason?: ShannonExpressiveEmotion['overrideReason'] | undefined },
  touch?: { presentFromTouch: boolean },
): boolean {
  if (!present || present.primary === 'neutral' || present.intensity < SHANNON_EMOTION_CONTINUITY.settledBelow) return false;
  if (incoming.overrideReason) return false;
  if (SUPPORT.has(incoming.primary) && incoming.intensity >= 0.3 && !present.overrideReason) return false;
  if (touch) {
    if (touch.presentFromTouch) return false;
    if (present.overrideReason) return true;
  }
  if (shannonEmotionSign(present.primary) * shannonEmotionSign(incoming.primary) < 0
    && incoming.intensity >= SHANNON_EMOTION_CONTINUITY.contraryFrom) return false;
  return present.intensity > incoming.intensity;
}

/** The present feeling goes on; the weaker stimulus is kept beside it as the feeling of the moment. */
export function continuedShannonEmotion(
  previous: ShannonExpressiveEmotion,
  incoming: ShannonEmotionKind,
  now: string,
): ShannonExpressiveEmotion {
  const { presentAt: _presentAt, ...kept } = previous;
  const { continued: _continued, decided: _decided, underneath: _underneath, easedPeak: _easedPeak, ...rest } = kept;
  const secondary = incoming !== 'neutral' && incoming !== previous.primary && !unsafeCombination(previous.primary, incoming)
    ? [incoming, ...previous.secondary.filter(kind => kind !== incoming)].slice(0, 2)
    : previous.secondary;
  return Object.freeze({
    ...rest, secondary: Object.freeze([...secondary]), visibility: visibilityFor(previous.intensity), updatedAt: validTimestamp(now),
    continued: true,
  });
}

/**
 * The wall-clock carry-over rule, as it was before the awake clock: used for a stored feeling that
 * has no awake stamp yet and under `clock: 'wall'`. A stored feeling loses
 * `decay` of carry-over per 30 minutes since it was last expressed (at most
 * 0.85), measured from `updatedAt` (older snapshots: `startedAt`).
 */
export function carriedShannonEmotion(
  emotion: ShannonExpressiveEmotion,
  now: string,
): ShannonExpressiveEmotion {
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(emotion.updatedAt ?? emotion.startedAt));
  if (!Number.isFinite(elapsed)) return emotion;
  const timeDecay = Math.min(0.85, elapsed / 1_800_000 * emotion.decay);
  return { ...emotion, carryover: clamp(emotion.carryover - timeDecay, 0, 1) };
}

/**
 * What Shannon feels at `now` when nothing new has happened: the stored
 * feeling at the share of its carry-over that remains, or the settled baseline
 * once the carry-over is below the threshold. Prompts, the state sheet and message
 * expressions all read the stored state through this function.
 */
export function currentShannonEmotion(
  stored: ShannonExpressiveEmotion | undefined,
  now: string,
): ShannonExpressiveEmotion {
  const carried = stored ? carriedShannonEmotion(stored, now) : undefined;
  if (!carried || carried.primary === 'neutral' || carried.carryover < SHANNON_EMOTION_CARRY_THRESHOLD) {
    return Object.freeze({
      ...INITIAL_SHANNON_EXPRESSIVE_EMOTION,
      cause: carried && carried.primary !== 'neutral' ? SHANNON_SETTLED_CAUSE : INITIAL_SHANNON_EXPRESSIVE_EMOTION.cause,
      startedAt: validTimestamp(now),
    });
  }
  // Full strength at the moment it was expressed, fading with the carry-over that remains.
  const remaining = stored!.carryover > 0 ? carried.carryover / stored!.carryover : 0;
  const intensity = clamp(carried.intensity * remaining, 0, 1);
  return Object.freeze({ ...carried, intensity, visibility: visibilityFor(intensity) });
}

export function visibilityFor(intensity: number): ShannonExpressiveEmotion['visibility'] {
  return intensity < 0.3 ? 'hidden' : intensity < 0.62 ? 'subtle' : 'expressed';
}

/**
 * `others`: the owner's own call while someone else can hear. A feeling she carries may have a cause
 * that is his alone (what was said or done between the two of them), so the feeling may show and its
 * cause is neither given to the model nor said.
 */
export function buildExpressiveEmotionPrompt(
  emotion: ShannonExpressiveEmotion,
  audience: 'owner' | 'guest' | 'others' = 'owner',
): string {
  return [
    '[Current expressive emotion — guidance, never a reason to fake facts]',
    `primary=${emotion.primary}; secondary=${emotion.secondary.join(',') || 'none'}; intensity=${emotion.intensity.toFixed(2)}; visibility=${emotion.visibility}`,
    `target=${emotion.target}; cause=${audience === 'others' ? 'withheld while others can hear' : emotion.cause}; carryover=${emotion.carryover.toFixed(2)}; decay=${emotion.decay.toFixed(2)}`,
    audience === 'guest'
      ? 'Keep first person as ボク. This is a temporary guest session: do not assume the speaker is ライ氏 and do not address them as ライ氏. Let emotion shape wording and rhythm without naming the label.'
      : `Keep first person as ボク and address the owner as ライ氏 when natural. Let emotion shape wording and rhythm without naming the label.${audience === 'others' ? ' Do not say why you feel this way while others can hear.' : ''}`,
    'Do not force advice when companionship is wanted. Jealousy, sulking, anger, and teasing must stay light, non-controlling, and never induce guilt.',
    'A harmless falsehood is allowed only as an obvious joke with immediate reveal; never use it for facts, people, memory, progress, safety, health, or money.',
  ].join('\n');
}

export function emotionProfile(primary: ShannonEmotionKind, intensity: number): { valence: number; arousal: number } {
  const valence = NEGATIVE.has(primary) ? -0.25 - intensity * 0.55
    : primary === 'neutral' || primary === 'focused' || primary === 'cautious' ? 0
      : 0.18 + intensity * 0.62;
  const arousal = HIGH_ENERGY.has(primary) ? 0.55 + intensity * 0.45
    : LOW_ENERGY.has(primary) ? 0.38 - intensity * 0.2
      : 0.28 + intensity * 0.44;
  return { valence: clamp(valence, -1, 1), arousal: clamp(arousal, 0, 1) };
}

export function decayFor(primary: ShannonEmotionKind): number {
  if (['panic', 'scream', 'shocked', 'surprised', 'giggle'].includes(primary)) return 0.82;
  if (['hurt', 'sad', 'lonely', 'affectionate', 'tender', 'quietCompanion'].includes(primary)) return 0.24;
  return 0.48;
}

export function unsafeCombination(primary: ShannonEmotionKind, secondary: ShannonEmotionKind): boolean {
  return (primary === 'protective' || primary === 'caring')
    && (PLAYFUL.has(secondary) || ATTACHMENT.has(secondary));
}

function compact(value: string, maximum: number): string {
  return Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
}

function validTimestamp(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
