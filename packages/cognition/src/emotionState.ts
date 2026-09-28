import {
  SHANNON_EMOTION_KINDS,
  type ShannonEmotionKind,
  type ShannonExpressiveEmotion,
} from './types.js';

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

const FINAL_CUES: readonly { emotion: ShannonEmotionKind; pattern: RegExp }[] = [
  { emotion: 'bashful', pattern: /(?:えへへ|照れ|恥ずか|赤くな|そんなこと言われ)/u },
  { emotion: 'giggle', pattern: /(?:ふふ|くすっ|笑っちゃ|おかしい)/u },
  { emotion: 'mischievous', pattern: /(?:企ん|悪戯|いたずら|内緒です|さては)/u },
  { emotion: 'cuteAngry', pattern: /(?:もうっ|むー|ぷん|まったく|困ります)/u },
  { emotion: 'jealous', pattern: /(?:嫉妬|やきもち|ほかの子|他の子)/u },
  { emotion: 'sulky', pattern: /(?:拗ね|すね|別にいいですけど)/u },
  { emotion: 'surprised', pattern: /(?:えっ|まさか|びっくり|驚き)/u },
  { emotion: 'speechless', pattern: /(?:言葉が出|唖然|なんですって)/u },
  { emotion: 'apologetic', pattern: /(?:ごめん|申し訳|すみません)/u },
  { emotion: 'caring', pattern: /(?:大丈夫|無理しない|心配|そばにい)/u },
  { emotion: 'determined', pattern: /(?:任せて|やります|取りかか|書くぞ|進めます)/u },
  { emotion: 'triumphant', pattern: /(?:やった|成功|完成|できました|天才)/u },
  { emotion: 'excited', pattern: /(?:楽しみ|わくわく|最高|嬉しい|うれしい)/u },
  { emotion: 'sad', pattern: /(?:悲しい|寂しい|つらい|残念)/u },
  { emotion: 'confused', pattern: /(?:分からない|わからない|混乱|どういうこと)/u },
];

const EMERGENCY = /(?:死にたい|自殺|殺され|息ができない|意識がない|出血|火事|助けて|緊急|救急|危険)/u;
const GRIEF = /(?:亡くな|死んだ|死別|お葬式|重い病気|余命|喪失)/u;
const SENSITIVE_FACT = /(?:健康|病気|薬|金銭|お金|送金|支払|人物情報|個人情報|記憶|覚えて|進捗|完了|配布|デプロイ|安全)/u;

export const INITIAL_SHANNON_EXPRESSIVE_EMOTION: Readonly<ShannonExpressiveEmotion> = Object.freeze({
  primary: 'neutral', secondary: Object.freeze([]), intensity: 0.15,
  target: '会話', cause: '会話開始時の落ち着いた基準状態', arousal: 0.30, valence: 0,
  visibility: 'hidden', startedAt: new Date(0).toISOString(), decay: 0.48, carryover: 0,
});

export interface ResolveShannonEmotionInput {
  previous?: ShannonExpressiveEmotion;
  provisionalPrimary: ShannonEmotionKind | string;
  provisionalIntensity: number;
  transcript: string;
  reply?: string;
  now: string;
  target?: string;
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
    ...(overrideReason ? { overrideReason } : {}),
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
    ...(typeof row.overrideReason === 'string'
      ? { overrideReason: row.overrideReason as ShannonExpressiveEmotion['overrideReason'] } : {}),
  });
}

export function resolveShannonEmotionState(
  input: ResolveShannonEmotionInput,
): ShannonExpressiveEmotion {
  const transcript = compact(input.transcript, 2_000);
  const reply = compact(input.reply ?? '', 2_000);
  const combined = `${transcript}\n${reply}`;
  const previous = decayedPrevious(input.previous, input.now);
  let primary = isShannonEmotionKind(input.provisionalPrimary) ? input.provisionalPrimary : 'neutral';
  let intensity = clamp(input.provisionalIntensity, 0, 1);
  let overrideReason: ShannonExpressiveEmotion['overrideReason'];
  let cause = reply ? '生成した応答の内容と会話文脈' : 'Jevの暫定判断と会話文脈';

  if (EMERGENCY.test(combined)) {
    primary = 'protective';
    intensity = Math.max(0.78, intensity);
    overrideReason = 'emergency';
    cause = '相手の安全を最優先する必要がある';
  } else if (GRIEF.test(combined)) {
    primary = 'caring';
    intensity = Math.max(0.68, intensity);
    overrideReason = 'grief';
    cause = '深い悲しみや喪失へ静かに寄り添う';
  } else {
    const finalCue = FINAL_CUES.find(rule => rule.pattern.test(reply));
    if (finalCue) {
      primary = finalCue.emotion;
      intensity = Math.max(intensity, 0.52);
    } else if (primary === 'neutral' && previous && previous.carryover >= 0.28) {
      primary = previous.primary;
      intensity = Math.max(intensity, previous.intensity * previous.carryover);
      cause = '直前の感情が自然に続いている';
    }
  }

  if (SENSITIVE_FACT.test(combined) && (PLAYFUL.has(primary) || ATTACHMENT.has(primary))) {
    primary = /(?:ごめん|申し訳|失敗)/u.test(combined) ? 'apologetic' : 'focused';
    intensity = Math.min(0.72, Math.max(0.45, intensity));
    overrideReason = 'safety';
    cause = '事実・安全・記憶・進捗では遊びより正確さを優先する';
  }

  const secondary = previous && previous.primary !== primary && previous.carryover >= 0.24
    && !unsafeCombination(primary, previous.primary)
    ? [previous.primary]
    : [];
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
    visibility: intensity < 0.3 ? 'hidden' : intensity < 0.62 ? 'subtle' : 'expressed',
    startedAt: sameEpisode ? previous.startedAt : validTimestamp(input.now),
    decay,
    carryover,
    ...(overrideReason ? { overrideReason } : {}),
  });
}

export function buildExpressiveEmotionPrompt(emotion: ShannonExpressiveEmotion): string {
  return [
    '[Current expressive emotion — guidance, never a reason to fake facts]',
    `primary=${emotion.primary}; secondary=${emotion.secondary.join(',') || 'none'}; intensity=${emotion.intensity.toFixed(2)}; visibility=${emotion.visibility}`,
    `target=${emotion.target}; cause=${emotion.cause}; carryover=${emotion.carryover.toFixed(2)}; decay=${emotion.decay.toFixed(2)}`,
    'Keep first person as ボク and address the owner as ライ氏 when natural. Let emotion shape wording and rhythm without naming the label.',
    'Do not force advice when companionship is wanted. Jealousy, sulking, anger, and teasing must stay light, non-controlling, and never induce guilt.',
    'A harmless falsehood is allowed only as an obvious joke with immediate reveal; never use it for facts, people, memory, progress, safety, health, or money.',
  ].join('\n');
}

function decayedPrevious(
  previous: ShannonExpressiveEmotion | undefined,
  now: string,
): ShannonExpressiveEmotion | undefined {
  if (!previous) return undefined;
  const elapsed = Math.max(0, Date.parse(now) - Date.parse(previous.startedAt));
  if (!Number.isFinite(elapsed)) return previous;
  const timeDecay = Math.min(0.85, elapsed / 1_800_000 * previous.decay);
  return { ...previous, carryover: clamp(previous.carryover - timeDecay, 0, 1) };
}

function emotionProfile(primary: ShannonEmotionKind, intensity: number): { valence: number; arousal: number } {
  const valence = NEGATIVE.has(primary) ? -0.25 - intensity * 0.55
    : primary === 'neutral' || primary === 'focused' || primary === 'cautious' ? 0
      : 0.18 + intensity * 0.62;
  const arousal = HIGH_ENERGY.has(primary) ? 0.55 + intensity * 0.45
    : LOW_ENERGY.has(primary) ? 0.38 - intensity * 0.2
      : 0.28 + intensity * 0.44;
  return { valence: clamp(valence, -1, 1), arousal: clamp(arousal, 0, 1) };
}

function decayFor(primary: ShannonEmotionKind): number {
  if (['panic', 'scream', 'shocked', 'surprised', 'giggle'].includes(primary)) return 0.82;
  if (['hurt', 'sad', 'lonely', 'affectionate', 'tender', 'quietCompanion'].includes(primary)) return 0.24;
  return 0.48;
}

function unsafeCombination(primary: ShannonEmotionKind, secondary: ShannonEmotionKind): boolean {
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
