import { SHANNON_EMOTION_TIME, type ShannonEmotionTiming } from '@shannon/cognition';

/**
 * The emotion timing this process runs with. Core: emotion.
 *
 * `packages/cognition` holds the one table of time constants and reads no environment; this is
 * the only place the server may override a value, and every reader and writer of her feeling in
 * this process takes its timing from here, so they cannot disagree.
 *
 * - `SHANNON_EMOTION_CLOCK=awake|wall` (default `awake`). `wall` is the kill switch: fading is
 *   measured on the wall clock by the rules as they were before the awake clock, and nothing is
 *   kept or shown underneath the feeling of the moment.
 * - `SHANNON_EMOTION_IDLE_MINUTES`: the gap after which she counts as dormant.
 * - `SHANNON_EMOTION_*_HALF_LIFE_MINUTES` / `SHANNON_EMOTION_LINGERING_HALF_LIFE_HOURS`: one value of the table each.
 */
const MINUTE = 60_000;
let cached: { key: string; timing: ShannonEmotionTiming } | undefined;

const NAMES = [
  'SHANNON_EMOTION_CLOCK', 'SHANNON_EMOTION_IDLE_MINUTES', 'SHANNON_EMOTION_REACTION_HALF_LIFE_MINUTES',
  'SHANNON_EMOTION_PASSING_HALF_LIFE_MINUTES', 'SHANNON_EMOTION_MOOD_HALF_LIFE_MINUTES',
  'SHANNON_EMOTION_MOOD_VALUE_HALF_LIFE_MINUTES', 'SHANNON_EMOTION_AROUSAL_HALF_LIFE_MINUTES',
  'SHANNON_EMOTION_LINGERING_HALF_LIFE_HOURS',
] as const;

export function emotionTiming(environment: Readonly<Record<string, string | undefined>> = process.env): ShannonEmotionTiming {
  const key = NAMES.map(name => environment[name] ?? '').join('\n');
  if (cached?.key === key) return cached.timing;
  // A value that is not a positive number inside its bounds is ignored: the table's own value stands.
  const duration = (name: typeof NAMES[number], unit: number, fallback: number, maximum: number) => {
    const parsed = Number(environment[name]);
    return environment[name]?.trim() && Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed * unit : fallback;
  };
  const timing: ShannonEmotionTiming = Object.freeze({
    clock: environment.SHANNON_EMOTION_CLOCK?.trim().toLowerCase() === 'wall' ? 'wall' : 'awake',
    idleCapMs: duration('SHANNON_EMOTION_IDLE_MINUTES', MINUTE, SHANNON_EMOTION_TIME.idleCapMs, 120),
    reactionHalfLifeMs: duration('SHANNON_EMOTION_REACTION_HALF_LIFE_MINUTES', MINUTE, SHANNON_EMOTION_TIME.reactionHalfLifeMs, 60),
    passingHalfLifeMs: duration('SHANNON_EMOTION_PASSING_HALF_LIFE_MINUTES', MINUTE, SHANNON_EMOTION_TIME.passingHalfLifeMs, 240),
    moodHalfLifeMs: duration('SHANNON_EMOTION_MOOD_HALF_LIFE_MINUTES', MINUTE, SHANNON_EMOTION_TIME.moodHalfLifeMs, 1_440),
    moodValueHalfLifeMs: duration('SHANNON_EMOTION_MOOD_VALUE_HALF_LIFE_MINUTES', MINUTE, SHANNON_EMOTION_TIME.moodValueHalfLifeMs, 1_440),
    arousalHalfLifeMs: duration('SHANNON_EMOTION_AROUSAL_HALF_LIFE_MINUTES', MINUTE, SHANNON_EMOTION_TIME.arousalHalfLifeMs, 1_440),
    lingeringHalfLifeMs: duration('SHANNON_EMOTION_LINGERING_HALF_LIFE_HOURS', 60 * MINUTE, SHANNON_EMOTION_TIME.lingeringHalfLifeMs, 168),
  });
  cached = { key, timing };
  return timing;
}
