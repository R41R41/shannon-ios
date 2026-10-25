import { presentShannonFeeling, type ShannonFeelingState } from './emotionContinuity.js';
import { currentShannonEmotion, holdsShannonFeeling, isShannonEmotionKind, resolveShannonEmotionState, shannonEmotionSign } from './emotionState.js';
import { SHANNON_EMOTION_TIME, type ShannonEmotionTiming } from './emotionTime.js';
import { SHANNON_OWNER_NAME } from './persona.js';
import type { CompanionStateSnapshot, ShannonEmotion, ShannonEmotionKind, ShannonExpressiveEmotion } from './types.js';

/**
 * What a moment of her Minecraft body does to her feeling (docs/minecraft-body-contract.md, phase 2; owner 2026-10-26: 「出来事は
 * コードで、考えていることは並列の Haiku でまれに」「行動には感情を使わない」). The only place a game moment is read as emotion.
 *
 * A moment is an input to the one existing emotion state, as a touch is (`touchEmotion.ts`): the reducer event `game-felt` calls
 * `feelGame`, which moves the continuous mood a small bounded step toward the row's mood and resolves the conversational feeling with
 * the resolver a reply uses, so carry-over, decay and the face table apply to it as to any other feeling. Nothing reads it back into
 * what her body does: the Minecraft decisions are given no feeling.
 */
export const SHANNON_GAME_MOMENT_KINDS = ['died', 'hurt', 'danger', 'milestone', 'stuck', 'nightSurvived', 'ownerNear', 'thought'] as const;
export type ShannonGameMomentKind = typeof SHANNON_GAME_MOMENT_KINDS[number];
/** Firsts of the way to the dragon, as the body names them (closed). */
export const SHANNON_GAME_MILESTONES = ['first_iron', 'first_diamond', 'nether_entered', 'fortress_found', 'blaze_rod', 'end_entered', 'dragon_killed'] as const;
export type ShannonGameMilestone = typeof SHANNON_GAME_MILESTONES[number];
/** What nearly killed her body (closed). */
export const SHANNON_GAME_DANGERS = ['lava', 'fall', 'drown', 'fire', 'explosion', 'mob'] as const;
export type ShannonGameDanger = typeof SHANNON_GAME_DANGERS[number];
/** The kinds a thought may bring (the parallel appraisal's menu): feelings of playing, none that belong to a person she talks with. */
export const SHANNON_GAME_THOUGHT_KINDS = [
  'happy', 'fun', 'excited', 'relief', 'pride', 'curiosity', 'smug', 'triumphant', 'determined', 'focused', 'cautious',
  'frustrated', 'annoyed', 'disappointed', 'anxious', 'surprised', 'confused', 'tired', 'blocked', 'retrying',
] as const satisfies readonly ShannonEmotionKind[];

export interface ShannonGameMoment {
  kind: ShannonGameMomentKind;
  /** `milestone` only. */
  milestone?: ShannonGameMilestone;
  /** `danger` only. */
  danger?: ShannonGameDanger;
  /** `hurt` only: the share of a full health bar lost at once, 0..1. */
  strength?: number;
  /** `stuck` only: acts that failed in a row. */
  count?: number;
  /** `thought` only: what the parallel appraisal read in her own decisions (`words`: at most 40 characters, said after 「マイクラで」). */
  thought?: { primary: ShannonEmotionKind; intensity: number; words: string };
}

interface GameRow { done: string; primary: ShannonEmotionKind; intensity: number; mood: Readonly<ShannonEmotion> }
const row = (done: string, primary: ShannonEmotionKind, intensity: number, valence: number, arousal: number, openness: number): GameRow =>
  Object.freeze({ done, primary, intensity, mood: Object.freeze({ valence, arousal, openness }) });

/** Every game feeling's cause begins so: it is how a feeling from the game is told from any other (`isGameFeeling`). */
export const SHANNON_GAME_CAUSE_PREFIX = 'マイクラで';

export const SHANNON_GAME_MILESTONE_FEELINGS: Readonly<Record<ShannonGameMilestone, GameRow>> = Object.freeze({
  first_iron: row('初めて鉄を手に入れた', 'happy', 0.45, 0.35, 0.50, 0.60),
  first_diamond: row('ダイヤを見つけた', 'excited', 0.65, 0.50, 0.70, 0.65),
  nether_entered: row('ネザーに着いた', 'excited', 0.60, 0.40, 0.70, 0.60),
  fortress_found: row('ネザー要塞を見つけた', 'excited', 0.55, 0.40, 0.68, 0.60),
  blaze_rod: row('ブレイズロッドを手に入れた', 'pride', 0.55, 0.45, 0.60, 0.60),
  end_entered: row('エンドに着いた', 'excited', 0.70, 0.45, 0.75, 0.62),
  dragon_killed: row('エンダードラゴンを倒した', 'triumphant', 0.85, 0.60, 0.80, 0.70),
});
export const SHANNON_GAME_DANGER_FEELINGS: Readonly<Record<ShannonGameDanger, GameRow>> = Object.freeze({
  lava: row('溶岩に落ちかけた', 'shocked', 0.55, -0.10, 0.72, 0.40),
  fall: row('高い所から落ちかけた', 'shocked', 0.50, -0.10, 0.70, 0.40),
  drown: row('おぼれかけた', 'anxious', 0.50, -0.20, 0.65, 0.38),
  fire: row('燃えてしまった', 'shocked', 0.50, -0.10, 0.70, 0.40),
  explosion: row('爆発に巻き込まれかけた', 'shocked', 0.60, -0.15, 0.75, 0.38),
  mob: row('敵に囲まれた', 'anxious', 0.50, -0.15, 0.66, 0.38),
});
const DIED = row('死んでしまった', 'frustrated', 0.62, -0.30, 0.60, 0.40);
const HURT = row('攻撃を受けた', 'surprised', 0.40, 0.00, 0.58, 0.45);
const HURT_BADLY = row('大けがをした', 'shocked', 0.55, -0.10, 0.68, 0.40);
const STUCK = row('何度もうまくいかなかった', 'frustrated', 0.45, -0.15, 0.55, 0.40);
const STUCK_LONG = row('ずっとうまくいかない', 'annoyed', 0.55, -0.25, 0.60, 0.35);
const NIGHT = row('夜を越えた', 'relief', 0.40, 0.30, 0.35, 0.60);
const OWNER_NEAR = row(`${SHANNON_OWNER_NAME}がそばに来た`, 'happy', 0.40, 0.35, 0.50, 0.65);
/** A hit that takes this share of her health or more is a bad one. */
export const SHANNON_GAME_BAD_HURT = 0.3;
/** Fails in a row from which she is stuck, and from which it has gone on long. */
export const SHANNON_GAME_STUCK_FROM = 3;
export const SHANNON_GAME_STUCK_LONG_FROM = 6;
/** A thought's intensity is held inside these: it is felt, and never louder than the moments that happen to her. */
export const SHANNON_GAME_THOUGHT_INTENSITY = Object.freeze({ minimum: 0.3, maximum: 0.65 });
/** The share of the distance to the row's mood one moment covers, and the most one moment moves a mood value (as a touch). */
export const SHANNON_GAME_MOOD_RATE = 0.18;
export const SHANNON_GAME_MOOD_STEP = 0.08;
/** A thought moves the mood more gently than a moment that happens to her. */
const THOUGHT_WEIGHT = 0.6;

const clamp = (value: number, minimum: number, maximum: number) => Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
const includes = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

export const isShannonGameMilestone = (value: unknown): value is ShannonGameMilestone => includes(SHANNON_GAME_MILESTONES, value);
export const isShannonGameDanger = (value: unknown): value is ShannonGameDanger => includes(SHANNON_GAME_DANGERS, value);
export const isShannonGameThoughtKind = (value: unknown): value is typeof SHANNON_GAME_THOUGHT_KINDS[number] => includes(SHANNON_GAME_THOUGHT_KINDS, value);

/** A thought's words as a cause: one line, no brackets or control characters, at most 40 characters. Empty when nothing is left. */
export function gameThoughtWords(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f「」『』【】<>]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^マイクラで/u, '').slice(0, 40);
}

/** The row for a moment: its words, feeling and mood. Null for a moment that names nothing usable (a thought with no kind). */
export function gameFeeling(moment: ShannonGameMoment): (GameRow & { weight: number }) | null {
  switch (moment.kind) {
    case 'died': return { ...DIED, weight: 1 };
    case 'hurt': return { ...(clamp(moment.strength ?? 0, 0, 1) >= SHANNON_GAME_BAD_HURT ? HURT_BADLY : HURT), weight: 1 };
    case 'danger': return isShannonGameDanger(moment.danger) ? { ...SHANNON_GAME_DANGER_FEELINGS[moment.danger], weight: 1 } : null;
    case 'milestone': return isShannonGameMilestone(moment.milestone) ? { ...SHANNON_GAME_MILESTONE_FEELINGS[moment.milestone], weight: 1 } : null;
    case 'stuck': {
      const count = Math.trunc(clamp(moment.count ?? 0, 0, 999));
      return count >= SHANNON_GAME_STUCK_LONG_FROM ? { ...STUCK_LONG, weight: 1 } : count >= SHANNON_GAME_STUCK_FROM ? { ...STUCK, weight: 1 } : null;
    }
    case 'nightSurvived': return { ...NIGHT, weight: 1 };
    case 'ownerNear': return { ...OWNER_NEAR, weight: 1 };
    case 'thought': {
      const thought = moment.thought;
      const words = gameThoughtWords(thought?.words);
      if (!thought || !isShannonEmotionKind(thought.primary) || !isShannonGameThoughtKind(thought.primary) || !words) return null;
      const sign = shannonEmotionSign(thought.primary);
      // Pleasant or not by the kind's own sign; how awake it is, the middle of the range: only the sign is read from a thought.
      return { done: words, primary: thought.primary, weight: THOUGHT_WEIGHT,
        intensity: clamp(thought.intensity, SHANNON_GAME_THOUGHT_INTENSITY.minimum, SHANNON_GAME_THOUGHT_INTENSITY.maximum),
        mood: Object.freeze({ valence: sign * 0.35, arousal: 0.5, openness: 0.5 }) };
    }
  }
}

/** Why she feels it, in the stored state's words (「マイクラでダイヤを見つけた」). Shown to the owner as the cause of 「いま」. */
export function gameCause(moment: ShannonGameMoment): string | null {
  const felt = gameFeeling(moment);
  return felt ? `${SHANNON_GAME_CAUSE_PREFIX}${felt.done}` : null;
}

/** Whether a stored feeling came from her Minecraft body (its cause begins with 「マイクラで」). */
export function isGameFeeling(emotion: Pick<ShannonExpressiveEmotion, 'cause'> | undefined): boolean {
  return emotion !== undefined && emotion.cause.startsWith(SHANNON_GAME_CAUSE_PREFIX);
}

/**
 * Whether what she feels now stays when a game moment comes: the one rule every writer shares (`holdsShannonFeeling`), so a stronger
 * feeling (from a conversation, a touch or an earlier moment) stays, a contrary one strong enough replaces it, and her concern held for
 * the owner's sake is not covered by a game. Under `clock: 'wall'` the present feeling stays when it is stronger.
 */
export function holdsFeelingThroughGame(
  state: ShannonFeelingState,
  feeling: { primary: ShannonEmotionKind; intensity: number },
  now: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): boolean {
  if (timing.clock !== 'awake') {
    const previous = state.expressiveEmotion;
    if (!previous) return false;
    const present = currentShannonEmotion(previous, now);
    return present.primary !== 'neutral' && (previous.overrideReason !== undefined || present.intensity > feeling.intensity);
  }
  const present = presentShannonFeeling(state, now, timing);
  return holdsShannonFeeling(present, feeling) || (present.underneath !== undefined && holdsShannonFeeling(present.underneath, feeling));
}

/**
 * The emotion state after one game moment. Pure. The mood moves by at most `SHANNON_GAME_MOOD_STEP` per value and never past the row's
 * mood, so any number of moments stays bounded. A moment that names nothing usable changes nothing.
 */
export function feelGame(
  state: Pick<CompanionStateSnapshot, 'emotion' | 'expressiveEmotion' | 'emotionClock' | 'lingering'>,
  moment: ShannonGameMoment,
  now: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): { emotion: ShannonEmotion; expressiveEmotion: ShannonExpressiveEmotion | undefined } {
  const felt = gameFeeling(moment);
  if (!felt) return { emotion: state.emotion, expressiveEmotion: state.expressiveEmotion };
  const toward = (current: number, target: number) =>
    clamp((target - current) * SHANNON_GAME_MOOD_RATE * felt.weight, -SHANNON_GAME_MOOD_STEP, SHANNON_GAME_MOOD_STEP);
  // A thought moves only how pleasant it is; a moment that happens to her moves all three.
  const emotion: ShannonEmotion = {
    valence: clamp(state.emotion.valence + toward(state.emotion.valence, felt.mood.valence), -1, 1),
    arousal: moment.kind === 'thought' ? state.emotion.arousal : clamp(state.emotion.arousal + toward(state.emotion.arousal, felt.mood.arousal), 0, 1),
    openness: moment.kind === 'thought' ? state.emotion.openness : clamp(state.emotion.openness + toward(state.emotion.openness, felt.mood.openness), 0, 1),
  };
  const previous = state.expressiveEmotion;
  if (previous && holdsFeelingThroughGame(state, { primary: felt.primary, intensity: felt.intensity }, now, timing)) {
    return { emotion, expressiveEmotion: previous };
  }
  const resolved = resolveShannonEmotionState({
    ...(timing.clock === 'awake' ? { previous: presentShannonFeeling(state, now, timing), replaces: true } : previous ? { previous } : {}),
    provisionalPrimary: felt.primary, provisionalIntensity: felt.intensity,
    transcript: '', now, target: moment.kind === 'ownerNear' ? SHANNON_OWNER_NAME : 'マイクラの世界',
  });
  return { emotion, expressiveEmotion: Object.freeze({ ...resolved, cause: `${SHANNON_GAME_CAUSE_PREFIX}${felt.done}` }) };
}
