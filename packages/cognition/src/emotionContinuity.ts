import { SHANNON_MOOD_BASELINE } from './affect.js';
import {
  INITIAL_SHANNON_EXPRESSIVE_EMOTION,
  SHANNON_CONVERSATION_CAUSES,
  SHANNON_SETTLED_CAUSE,
  currentShannonEmotion,
  decayFor,
  emotionProfile,
  isKeptUnpleasant,
  isMoodLikeEmotion,
  isReactionEmotion,
  isShannonEmotionKind,
  isSupportEmotion,
  shannonEmotionSign,
  unsafeCombination,
  visibilityFor,
} from './emotionState.js';
import {
  SHANNON_EMOTION_CONTINUITY as RULE,
  SHANNON_EMOTION_TIME,
  advanceEmotionClock,
  awakeTimeAt,
  remainingShare,
  type ShannonEmotionTiming,
} from './emotionTime.js';
import { SHANNON_OWNER_NAME } from './persona.js';
import type {
  CompanionStateSnapshot,
  ShannonEmotion,
  ShannonEmotionClock,
  ShannonEmotionKind,
  ShannonExpressiveEmotion,
  ShannonLingeringFeeling,
} from './types.js';

/**
 * Continuity of the one emotion state on her awake clock. Nothing here is a second source of
 * feeling: these functions read and age the same three parts every writer already writes.
 *
 * - The moment's reaction is the conversational feeling (`expressiveEmotion`), gone in minutes.
 * - Her mood is the continuous mood values plus a feeling kept underneath for a few awake hours.
 * - What lingers is a strong feeling kept underneath for one to two awake days.
 *
 * "Underneath" is `lingering`: a small bounded list written only by the reducer when a mood-like
 * feeling toward the owner is committed. What she feels now is the stronger of the reaction and
 * what lies underneath, so a startle passes and the sulk it interrupted is still there.
 */
export type ShannonFeelingState = Pick<CompanionStateSnapshot, 'expressiveEmotion' | 'emotionClock' | 'lingering'>;

const clamp = (value: number, minimum: number, maximum: number) => Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum;
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();

/** The strength of a feeling underneath at this awake time. */
export function lingeringStrength(feeling: ShannonLingeringFeeling, awakeMs: number, timing: ShannonEmotionTiming): number {
  const halfLife = feeling.span === 'lingering' ? timing.lingeringHalfLifeMs : timing.moodHalfLifeMs;
  return feeling.strength * remainingShare(awakeMs - feeling.awakeAt, halfLife);
}

/** What is still alive underneath, strongest first, each with its present strength. */
export function livingLingering(
  state: Pick<CompanionStateSnapshot, 'emotionClock' | 'lingering'>,
  now: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): readonly { feeling: ShannonLingeringFeeling; strength: number }[] {
  if (timing.clock !== 'awake') return [];
  return alive(state.lingering ?? [], awakeTimeAt(state.emotionClock, now, timing), now, timing);
}

function alive(lingering: readonly ShannonLingeringFeeling[], awakeMs: number, now: string, timing: ShannonEmotionTiming) {
  const time = Date.parse(now);
  return lingering.map(feeling => ({ feeling, strength: lingeringStrength(feeling, awakeMs, timing) }))
    // Settled by awake time, or older on the wall clock than anything may stay.
    .filter(item => item.strength >= RULE.settledBelow && !(time - Date.parse(item.feeling.startedAt) > timing.lingeringMaxWallMs))
    .sort((left, right) => right.strength - left.strength);
}

/**
 * What Shannon feels at `now` when nothing new has happened. Prompts, the state sheet, the body,
 * message faces and the next turn of text or voice all read the stored state through this function.
 * The result carries `presentAt`, which tells the resolver it is already the feeling at that instant.
 */
export function presentShannonFeeling(
  state: ShannonFeelingState,
  now: string,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): ShannonExpressiveEmotion {
  if (timing.clock !== 'awake') return currentShannonEmotion(state.expressiveEmotion, now);
  const awakeMs = awakeTimeAt(state.emotionClock, now, timing);
  const stored = state.expressiveEmotion;
  const living = alive(state.lingering ?? [], awakeMs, now, timing);
  const under = living[0];
  /**
   * For each living kind, the strength it was stored at and what is left of it now: its entry's underneath, and for the
   * reaction on top its own when that is higher.
   */
  const heightsWith = (kind?: ShannonEmotionKind, stored = 0, left = 0) => {
    const heights: Partial<Record<ShannonEmotionKind, number>> = {};
    const strengths: Partial<Record<ShannonEmotionKind, number>> = {};
    for (const { feeling, strength } of living) {
      heights[feeling.kind] = Math.max(heights[feeling.kind] ?? 0, feeling.strength);
      strengths[feeling.kind] = Math.max(strengths[feeling.kind] ?? 0, strength);
    }
    if (kind) {
      heights[kind] = Math.max(heights[kind] ?? 0, stored);
      strengths[kind] = Math.max(strengths[kind] ?? 0, left);
    }
    const bar = placeBar(living.map(item => item.feeling), awakeMs, timing);
    return { heights: Object.freeze(heights), strengths: Object.freeze(strengths), ...(bar >= 0 ? { placeAbove: bar } : {}) };
  };
  let surface: ShannonExpressiveEmotion | undefined;
  // The wall-clock bound holds for the reaction as well: a strong one leaves a faint rest when she goes dormant, and that must not stay for weeks.
  const expired = stored !== undefined && Date.parse(now) - Date.parse(stored.updatedAt ?? stored.startedAt) > timing.lingeringMaxWallMs;
  if (stored && stored.primary !== 'neutral' && !expired) {
    if (stored.awakeAt === undefined) {
      // Stored before the awake clock existed: it settles by the wall-clock rule it was written under.
      const legacy = currentShannonEmotion(stored, now);
      if (legacy.primary !== 'neutral') surface = legacy;
    } else {
      const share = remainingShare(awakeMs - stored.awakeAt, isReactionEmotion(stored.primary) ? timing.reactionHalfLifeMs : timing.passingHalfLifeMs);
      const intensity = stored.intensity * share;
      if (intensity >= RULE.settledBelow) {
        // The reading is the feeling at this instant: its strength and the awake time it is true for go together.
        surface = { ...stored, intensity, carryover: clamp(stored.carryover * share, 0, 1), visibility: visibilityFor(intensity), awakeAt: awakeMs };
      }
    }
  }
  // What she owes the owner is read back as it was stored: a feeling held by an override, and her concern or apology
  // while it is strong enough to show, stay on top of a stronger mood underneath until they have passed.
  const owed = surface !== undefined && surface.intensity >= 0.3
    && (surface.overrideReason !== undefined || isSupportEmotion(surface.primary));
  const recentlyEased = (kind: ShannonEmotionKind) => {
    const entry = (state.lingering ?? []).find(item => item.kind === kind && inEasedHold(item, awakeMs, timing));
    return entry?.peak !== undefined ? { easedPeak: entry.peak } : {};
  };
  if (surface && (!under || owed || surface.intensity >= under.strength)) {
    // What lies underneath stays beside the reaction of the moment.
    const beside = under && under.feeling.kind !== surface.primary && !surface.secondary.includes(under.feeling.kind)
      && !unsafeCombination(surface.primary, under.feeling.kind)
      ? Object.freeze([under.feeling.kind, ...surface.secondary].slice(0, 2)) : surface.secondary;
    return Object.freeze({
      ...surface, secondary: beside, presentAt: now, ...recentlyEased(surface.primary), ...heightsWith(surface.primary, stored!.intensity, surface.intensity),
      ...(under && under.strength > surface.intensity ? { underneath: { primary: under.feeling.kind, intensity: under.strength } } : {}),
    });
  }
  if (under) {
    const { feeling, strength } = under;
    return Object.freeze({
      primary: feeling.kind, secondary: Object.freeze([]), intensity: strength, target: feeling.target, cause: feeling.cause,
      ...emotionProfile(feeling.kind, strength), visibility: visibilityFor(strength), startedAt: feeling.startedAt,
      decay: decayFor(feeling.kind), carryover: clamp(strength, 0, 1), updatedAt: timestamp(now), awakeAt: awakeMs, presentAt: now,
      ...recentlyEased(feeling.kind), ...heightsWith(),
    });
  }
  return Object.freeze({
    ...INITIAL_SHANNON_EXPRESSIVE_EMOTION,
    cause: stored && stored.primary !== 'neutral' ? SHANNON_SETTLED_CAUSE : INITIAL_SHANNON_EXPRESSIVE_EMOTION.cause,
    startedAt: timestamp(now), presentAt: now,
  });
}

/** Whether this feeling was eased within the hold: an apology stays for that long, whatever is decided or said. */
export function inEasedHold(feeling: ShannonLingeringFeeling, awakeMs: number, timing: ShannonEmotionTiming): boolean {
  return feeling.easedAwakeAt !== undefined && awakeMs - feeling.easedAwakeAt < timing.easedHoldMs;
}

/** Where the mood values return to: the fixed baseline, its valence coloured a little by what lies underneath. */
export function moodBaseline(lingering: readonly ShannonLingeringFeeling[], awakeMs: number, now: string, timing: ShannonEmotionTiming): ShannonEmotion {
  const colour = alive(lingering, awakeMs, now, timing)
    .reduce((sum, item) => sum + shannonEmotionSign(item.feeling.kind) * item.strength * RULE.moodColour, 0);
  return { ...SHANNON_MOOD_BASELINE, valence: SHANNON_MOOD_BASELINE.valence + clamp(colour, -RULE.moodColourLimit, RULE.moodColourLimit) };
}

/**
 * The emotion state brought to `now` on her awake clock: the clock advanced (at most the idle cap),
 * the mood values returned toward their baseline by the awake time that passed, and what has
 * settled underneath dropped. Pure; the reducer is the only caller that stores the result.
 */
export function settleEmotionTime(
  state: Pick<CompanionStateSnapshot, 'emotion' | 'emotionClock' | 'lingering'>,
  now: string,
  timing: ShannonEmotionTiming,
): { emotionClock: ShannonEmotionClock | undefined; emotion: ShannonEmotion; lingering: readonly ShannonLingeringFeeling[]; awakeMs: number; changed: boolean } {
  const { clock, elapsedMs } = advanceEmotionClock(state.emotionClock, now, timing);
  const awakeMs = clock?.awakeMs ?? 0;
  const before = state.lingering ?? [];
  const lingering = alive(before, awakeMs, now, timing).map(item => item.feeling);
  let emotion = state.emotion;
  if (elapsedMs > 0) {
    const base = moodBaseline(lingering, awakeMs, now, timing);
    const toward = (value: number, target: number, halfLifeMs: number) => target + (value - target) * remainingShare(elapsedMs, halfLifeMs);
    emotion = {
      valence: clamp(toward(emotion.valence, base.valence, timing.moodValueHalfLifeMs), -1, 1),
      arousal: clamp(toward(emotion.arousal, base.arousal, timing.arousalHalfLifeMs), 0, 1),
      openness: clamp(toward(emotion.openness, base.openness, timing.moodValueHalfLifeMs), 0, 1),
    };
  }
  return { emotionClock: clock, emotion, lingering, awakeMs, changed: clock !== state.emotionClock || lingering.length !== before.length };
}

/**
 * What lies underneath after a feeling was committed. A mood-like feeling toward the owner that is
 * strong enough is kept (or, if it is already there and weaker now, raised to the new strength);
 * a strong feeling of the opposite sign eases what it contradicts. Others never leave anything here.
 */
export function noteShannonFeeling(
  lingering: readonly ShannonLingeringFeeling[],
  feeling: ShannonExpressiveEmotion,
  awakeMs: number,
  now: string,
  timing: ShannonEmotionTiming,
  decided = false,
): readonly ShannonLingeringFeeling[] {
  const sign = shannonEmotionSign(feeling.primary);
  let list = [...lingering];
  if (feeling.overrideReason || feeling.target !== SHANNON_OWNER_NAME) return list;
  if (sign !== 0 && feeling.intensity >= RULE.contraryFrom) {
    // Once per episode: an entry that was eased a moment ago (by a contrary feeling, or by him) is not eased again by a
    // contrary feeling until the hold has passed, so a strong feeling repeated turn after turn does not dissolve it.
    list = list.map(item => item.target === feeling.target && shannonEmotionSign(item.kind) * sign < 0 && !inEasedHold(item, awakeMs, timing)
      ? eased(item, RULE.contraryEase, awakeMs, timing) : item);
  }
  if (isMoodLikeEmotion(feeling.primary) && feeling.intensity >= RULE.moodFrom && hasPlaceUnderneath(list, feeling, awakeMs, now, timing)) {
    const existing = list.find(item => item.kind === feeling.primary && item.target === feeling.target);
    const present = existing ? lingeringStrength(existing, awakeMs, timing) : 0;
    // A cue in her own words (also a denial of it) never renews what is already underneath: that keeps fading by awake time.
    // A decided strength renews it only when it is above what the feeling was at its height, so the same strength
    // decided turn after turn does not hold it up either; and while an easing holds, only above the height before it.
    const height = existing ? (inEasedHold(existing, awakeMs, timing) ? Math.max(existing.strength, existing.peak ?? 0) : existing.strength) : 0;
    const settled = present < RULE.settledBelow && !(existing && inEasedHold(existing, awakeMs, timing));
    if (feeling.intensity > present && (!existing || settled || (decided && feeling.intensity > height))) {
      const strength = clamp(feeling.intensity, 0, 1);
      const noted: ShannonLingeringFeeling = {
        kind: feeling.primary, target: feeling.target, cause: existing?.cause ?? feeling.cause,
        span: strength >= RULE.lingersFrom ? 'lingering' : existing?.span ?? 'mood',
        strength, awakeAt: awakeMs, startedAwakeAt: existing?.startedAwakeAt ?? awakeMs, startedAt: existing?.startedAt ?? timestamp(now),
      };
      list = [noted, ...list.filter(item => item !== existing)];
    }
  }
  const living = alive(list, awakeMs, now, timing).map(item => item.feeling);
  if (living.length <= RULE.maximumLingering) return living;
  // One too many. An unpleasant mood takes the place of the weakest entry that gives way to it (see `hasPlaceUnderneath`),
  // never of an unpleasant mood stored at least as strongly; anything else pushes out the weakest, as before.
  const newcomer = living.find(item => item.kind === feeling.primary && item.awakeAt === awakeMs);
  const yielding = newcomer && isKeptUnpleasant(newcomer.kind)
    ? [...living].reverse().find(item => item !== newcomer && !(isKeptUnpleasant(item.kind) && heldHeight(item, awakeMs, timing) >= newcomer.strength)) : undefined;
  return (yielding ? living.filter(item => item !== yielding) : living).slice(0, RULE.maximumLingering);
}

/** The height an entry holds: what it was stored at, and while an easing holds, what it was before the easing. */
function heldHeight(feeling: ShannonLingeringFeeling, awakeMs: number, timing: ShannonEmotionTiming): number {
  return inEasedHold(feeling, awakeMs, timing) ? Math.max(feeling.strength, feeling.peak ?? 0) : feeling.strength;
}

/** When every place is held by an unpleasant mood toward the owner: the lowest height among them. Otherwise -1 (a place gives way). */
function placeBar(living: readonly ShannonLingeringFeeling[], awakeMs: number, timing: ShannonEmotionTiming): number {
  if (living.length < RULE.maximumLingering || living.some(item => !isKeptUnpleasant(item.kind))) return -1;
  return Math.min(...living.map(item => heldHeight(item, awakeMs, timing)));
}

/**
 * Whether a feeling may take a place underneath. It may not when every place is held by an unpleasant mood toward the
 * owner at a height this unpleasant mood does not exceed, and it has no place of its own: otherwise rotating through five
 * such moods would push each one out, forget the height it had, and let every one be stored anew at full strength turn
 * after turn. A pleasant entry, and one held lower than the newcomer is strong, give way.
 */
export function hasPlaceUnderneath(
  lingering: readonly ShannonLingeringFeeling[],
  feeling: Pick<ShannonExpressiveEmotion, 'primary' | 'intensity' | 'target'>,
  awakeMs: number,
  now: string,
  timing: ShannonEmotionTiming,
): boolean {
  if (!isKeptUnpleasant(feeling.primary)) return true;
  const living = alive(lingering, awakeMs, now, timing).map(item => item.feeling);
  if (living.some(item => item.kind === feeling.primary && item.target === feeling.target)) return true;
  return feeling.intensity > placeBar(living, awakeMs, timing);
}

function eased(feeling: ShannonLingeringFeeling, share: number, awakeMs: number, timing: ShannonEmotionTiming): ShannonLingeringFeeling {
  return {
    ...feeling, strength: lingeringStrength(feeling, awakeMs, timing) * (1 - clamp(share, 0, 1)), awakeAt: awakeMs,
    // The height it had before he eased it stays known, so that nothing weaker than that undoes the easing at once.
    peak: Math.max(feeling.strength, feeling.peak ?? 0), easedAwakeAt: awakeMs,
  };
}

/** An apology or a kind word of the owner's eases the unpleasant feelings she holds toward him. Pleasant ones stay. */
export function easeLingering(
  lingering: readonly ShannonLingeringFeeling[],
  by: 'apology' | 'kindness',
  awakeMs: number,
  now: string,
  timing: ShannonEmotionTiming,
): readonly ShannonLingeringFeeling[] {
  const share = by === 'apology' ? RULE.apologyEase : RULE.kindnessEase;
  return alive(lingering.map(item => item.target === SHANNON_OWNER_NAME && shannonEmotionSign(item.kind) < 0
    ? eased(item, share, awakeMs, timing) : item), awakeMs, now, timing).map(item => item.feeling);
}

/** The same easing for the reaction of the moment, when it is an unpleasant feeling toward the owner that no override holds. */
export function easeShannonFeeling(
  feeling: ShannonExpressiveEmotion | undefined,
  by: 'apology' | 'kindness',
  awakeMs: number,
  timing: ShannonEmotionTiming,
): ShannonExpressiveEmotion | undefined {
  if (!feeling || feeling.awakeAt === undefined || feeling.overrideReason || feeling.target !== SHANNON_OWNER_NAME
    || shannonEmotionSign(feeling.primary) >= 0) return feeling;
  const share = remainingShare(awakeMs - feeling.awakeAt, isReactionEmotion(feeling.primary) ? timing.reactionHalfLifeMs : timing.passingHalfLifeMs);
  const intensity = feeling.intensity * share * (1 - (by === 'apology' ? RULE.apologyEase : RULE.kindnessEase));
  return { ...feeling, intensity, visibility: visibilityFor(intensity), awakeAt: awakeMs };
}

const KIND_PHRASE: Partial<Record<ShannonEmotionKind, string>> = {
  sulky: 'すねたこと', jealous: 'やきもちをやいたこと', lightPossessive: 'やきもちをやいたこと', hurt: '傷ついたこと',
  lonely: 'さびしかったこと', leftOut: 'さびしかったこと', annoyed: '腹を立てたこと', indignant: '腹を立てたこと',
  frustrated: '腹を立てたこと', seriousAnger: '腹を立てたこと', pride: '誇らしかったこと', gratitude: 'ありがたかったこと',
  affectionate: 'あたたかい気持ちになったこと', tender: 'あたたかい気持ちになったこと', gentle: 'あたたかい気持ちになったこと',
};

function sincePhrase(startedAt: string, now: string): string {
  const minutes = Math.floor((Date.parse(now) - Date.parse(startedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 60) return 'さっき';
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}時間前に` : `${Math.floor(minutes / (24 * 60))}日前に`;
}

/** One feeling underneath in meaning: when (a fact of the wall clock), what happened, and that it is still there. */
export function lingeringMeaning(feeling: ShannonLingeringFeeling, strength: number, now: string): string {
  const pleasant = shannonEmotionSign(feeling.kind) > 0;
  const what = SHANNON_CONVERSATION_CAUSES.includes(feeling.cause)
    ? `${feeling.target}との会話で${KIND_PHRASE[feeling.kind] ?? (pleasant ? 'うれしかったこと' : 'いやな気持ちになったこと')}`
    : `${feeling.cause.replace(/（続けて\d+回目）/u, '')}こと`;
  const still = pleasant ? 'の余韻が、まだ残っている' : strength >= 0.5 ? 'を、まだ引きずっている' : 'を、まだ少し引きずっている';
  return `${sincePhrase(feeling.startedAt, now)}${what}${still}`;
}

/**
 * The prompt line for what she still feels from before this conversation, for a turn with the
 * owner alone. Empty when nothing is left, without a clock, and under `clock: 'wall'`.
 */
export function lingeringFeelingLine(
  state: Pick<CompanionStateSnapshot, 'emotionClock' | 'lingering'>,
  now: string | undefined,
  timing: ShannonEmotionTiming = SHANNON_EMOTION_TIME,
): string {
  if (!now) return '';
  const living = livingLingering(state, now, timing).slice(0, 2);
  if (!living.length) return '';
  const unpleasant = living.some(item => shannonEmotionSign(item.feeling.kind) < 0);
  return [
    `まだ残っている気持ち: ${living.map(item => `${lingeringMeaning(item.feeling, item.strength, now)}（${item.feeling.kind} / 強さ ${item.strength.toFixed(2)}）`).join('、')}。`,
    unpleasant
      ? '表に出てもよいが、責めたり罪悪感を誘ったりはしない。謝罪ややさしい言葉、起きて過ごす時間で自然にほどけてよい。'
      : '自然ににじんでよい。',
  ].join('');
}

/** Restores the stored list through the same bounds the reducer keeps. Anything unreadable, or stamped ahead of her clock, is dropped. */
export function restoreLingering(value: unknown, awakeMs: number): readonly ShannonLingeringFeeling[] {
  if (!Array.isArray(value)) return [];
  const restored: ShannonLingeringFeeling[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as Record<string, unknown>;
    const number = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0;
    if (typeof row.kind !== 'string' || !isShannonEmotionKind(row.kind) || row.kind === 'neutral') continue;
    if (typeof row.target !== 'string' || typeof row.cause !== 'string' || typeof row.startedAt !== 'string') continue;
    if (!number(row.strength) || !number(row.awakeAt) || !number(row.startedAwakeAt) || !Number.isFinite(Date.parse(row.startedAt))) continue;
    if ((row.awakeAt as number) > awakeMs || (row.startedAwakeAt as number) > (row.awakeAt as number)) continue;
    const kind = row.kind;
    const target = Array.from(row.target).slice(0, 80).join('');
    const twin = restored.findIndex(item => item.kind === kind && item.target === target);
    // One entry per kind and person: of two, the stronger stays, in the place of the first.
    if (twin >= 0 && restored[twin]!.strength >= clamp(row.strength as number, 0, 1)) continue;
    restored.splice(twin >= 0 ? twin : restored.length, twin >= 0 ? 1 : 0, Object.freeze({
      kind, target, cause: Array.from(row.cause).slice(0, 240).join(''),
      span: row.span === 'lingering' ? 'lingering' : 'mood', strength: clamp(row.strength as number, 0, 1),
      awakeAt: row.awakeAt as number, startedAwakeAt: row.startedAwakeAt as number, startedAt: row.startedAt,
      ...(number(row.peak) && number(row.easedAwakeAt) && (row.easedAwakeAt as number) <= awakeMs
        ? { peak: clamp(row.peak as number, 0, 1), easedAwakeAt: row.easedAwakeAt as number } : {}),
    }));
  }
  return restored.slice(0, RULE.maximumLingering);
}

export function sameLingering(left: readonly ShannonLingeringFeeling[], right: readonly ShannonLingeringFeeling[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
