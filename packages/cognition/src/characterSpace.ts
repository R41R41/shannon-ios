import { utteranceTags } from './appraisal.js';
import { otherAiIn } from './affection.js';
import { utteranceKind, type FeelingEvent } from './feelingEvent.js';
import { tenderIn } from './innerNoteWords.js';
import type { ShannonEmotion } from './types.js';

/**
 * Her character space (owner 2026-10-20: 「多次元的な性格・感情空間の中で、『この領域はこのキャラ設定で』」「根本的ないくつかにしたい」;
 * the main session and the owner settled six axes; `SHANNON_CHARACTER_SPACE`). Pure.
 *
 * - Her mood, one for all (fast, minutes): 快 (pleasure), 覚醒 (arousal), 優位 (dominance), 遊び (play).
 * - The relationship, per person (slow, days): 好意 (liking: the affection value, `likingOf`), 安心 (security: `foldSecurity`).
 *
 * A feeling is a place in the space, never a seventh axis: anger is 快− 覚醒+ 優位+; anxiety and jealousy 快− 覚醒+ 優位− (with 好意 high
 * and 安心 low); sadness 快− 覚醒− 優位−; a sulk 快− 優位+ 好意+; shyness 覚醒+ 優位− 好意+. Her tsundere is 優位 (her pride) against
 * 好意: fond with 優位 high is ツン, sure of him with 優位 down is デレ.
 *
 * Her default personality is, per mood axis, a base, how far events move it, and how fast it returns (a half-life in minutes): events
 * swing her widely and she is back near her base within minutes (owner: 「配信させることを考えると…コロコロキャラが変わる」). Her base is
 * the approved v2 core's cheeky tsundere: 快 a little up, 優位 up, 遊び up, 覚醒 middling.
 *
 * What of before it keeps (「以前より良くなるか」): her lingering mood (`emotion.valence`, `arousal`, which carries days) colours 快 and
 * 覚醒 by `LINGER_SHARE` and no more (the week of 2026-10-12: a sulk held five days); `openness` is not read; the temperament's
 * `closeness` stays the state sheet's and 好意 is the affection value instead. Nothing here is stored: the mood is folded from the day's
 * feeling events each turn, so forgetting a source forgets its swing.
 */
export const SPACE_AXES = ['pleasure', 'arousal', 'dominance', 'play', 'liking', 'security'] as const;
export type SpaceAxis = typeof SPACE_AXES[number];
export type SpacePosition = Readonly<Record<SpaceAxis, number>>;
export const MOOD_AXES = ['pleasure', 'arousal', 'dominance', 'play'] as const;
export type MoodAxis = typeof MOOD_AXES[number];
export const SPACE_AXIS_WORDS: Readonly<Record<SpaceAxis, string>> = Object.freeze({
  pleasure: '快', arousal: '覚醒', dominance: '優位', play: '遊び', liking: '好意', security: '安心',
});

/** Her default personality on the mood axes (a proposal): the base, how far one event's swing counts, its half-life in minutes. */
export const DEFAULT_PERSONALITY: Readonly<Record<MoodAxis, { base: number; gain: number; halfLifeMinutes: number }>> = Object.freeze({
  pleasure: { base: 0.25, gain: 1, halfLifeMinutes: 6 },
  arousal: { base: 0.1, gain: 1, halfLifeMinutes: 5 },
  dominance: { base: 0.45, gain: 1, halfLifeMinutes: 8 },
  play: { base: 0.4, gain: 1, halfLifeMinutes: 6 },
});
/** How much her lingering mood (days) colours 快 and 覚醒. */
export const LINGER_SHARE = 0.3;

/**
 * What kind of event something was for her space (closed; read from his words, a touch's stance or a comment's kind, never kept as
 * words). Rules only: no model call, no latency (a reading by Jev may join later; its cost is one more question on the feeling turn).
 */
export const SPACE_CUES = ['praise', 'love', 'tease', 'insult', 'apology', 'other_ai', 'leaving', 'returning', 'serious', 'tender', 'feeling_order',
  'touch_welcome', 'touch_refused', 'hype', 'stream_praise'] as const;
export type SpaceCue = typeof SPACE_CUES[number];

/** Each cue's swing of her mood axes, and its share of 安心 the same day (the day fold carries it on). */
export const CUE_SWINGS: Readonly<Record<SpaceCue, Partial<Record<MoodAxis | 'security', number>>>> = Object.freeze({
  praise: { pleasure: 0.45, dominance: 0.35, arousal: 0.15 },
  love: { pleasure: 0.4, arousal: 0.5, dominance: -0.6, security: 0.05 },
  tease: { dominance: 0.35, pleasure: -0.15, play: 0.3, arousal: 0.15 },
  insult: { pleasure: -0.7, arousal: 0.45, dominance: 0.45, play: -0.4, security: -0.08 },
  apology: { pleasure: 0.2, arousal: -0.1, security: 0.08 },
  other_ai: { pleasure: -0.7, arousal: 0.35, dominance: -0.55, security: -0.15 },
  leaving: { pleasure: -0.2, arousal: -0.05 },
  returning: { pleasure: -0.2, dominance: 0.3, arousal: 0.2 },
  serious: { play: -1.2, arousal: 0.05, pleasure: -0.05 },
  tender: { play: -0.45, pleasure: -0.1, dominance: -0.1 },
  feeling_order: { dominance: 0.25, play: 0.1 },
  touch_welcome: { pleasure: 0.3, arousal: 0.25, dominance: -0.2 },
  touch_refused: { pleasure: -0.6, arousal: 0.4, dominance: 0.35, security: -0.1 },
  hype: { arousal: 0.08, play: 0.06, pleasure: 0.04 },
  stream_praise: { pleasure: 0.1, dominance: 0.1 },
});

const LOVE = /(?:^|[^大])好き(?:だよ|だ|です|！|!|。|$)|大好き|愛してる|会いたかった/u;
const TEASE_MARK = /ポンコツ|へっぽこ|ばーか|バーカ|ドジ|からかっ|ｗ|w$|笑|〜$|（笑）/u;
const LEAVING = /行ってくる|行ってきます|出かけ|寝る|寝ます|おやすみ|飲みに|飲み会|遊びに|また(?:あとで|明日|今度)|(?:もう|そろそろ)落ちる|友達と|会ってくる/u;
/** Praise his words carry beyond a plain thanks (`utteranceKind` reads thanks and warm words). */
const PRAISE = /さすが|すごい|天才|えらい|賢い|よくやった|よくできた|助かった|最高|かわいい|可愛い|頼りになる/u;
const SERIOUS = new RegExp(['相談(?:が|したい|に乗って|させて|していい)', '真剣', '悩(?:んで|み)', '困って', 'どうしたら', '聞いてほしい', 'つらい', '辛い', 'しんどい',
  '落ち込'].join('|'), 'u');
/** An apology his words carry beyond the ledger's reading (「からかってごめんね」 is an apology, not a tease). */
const APOLOGY = /ごめん|すまん|すみません|申し訳|悪かった|言いすぎた|言い過ぎた/u;

/** Hurtful words read as a tease when they are marked as one (「ポンコツｗ」), never an insult to her creator. */
function hurtCues(text: string): SpaceCue[] {
  const tags = utteranceTags(text);
  const hurtful = tags.some(tag => tag === 'insult' || tag === 'ai_taunt' || tag === 'creator_insult');
  const teasing = TEASE_MARK.test(text);
  if (APOLOGY.test(text)) return [];
  if (hurtful) return [teasing && !tags.includes('creator_insult') ? 'tease' : 'insult'];
  return teasing && /ポンコツ|へっぽこ|ばーか|バーカ|ドジ|からかっ/u.test(text) ? ['tease'] : [];
}

/** What kind of words they are (love before praise; an apology; a feeling order). */
function kindCues(text: string): SpaceCue[] {
  const kind = utteranceKind(text);
  const warm: SpaceCue[] = LOVE.test(text) ? ['love'] : kind === 'praised' || PRAISE.test(text) ? ['praise'] : [];
  return [...warm, ...(kind === 'apologized' || APOLOGY.test(text) ? ['apology' as const] : []), ...(kind === 'feeling_order' ? ['feeling_order' as const] : [])];
}

/** The cues of his words (and whether he comes back after a day or more away). */
export function cuesOfWords(words: string, options: { returning?: boolean } = {}): SpaceCue[] {
  const text = words.trim();
  const cues: SpaceCue[] = options.returning ? ['returning'] : [];
  if (!text) return cues;
  const serious = SERIOUS.test(text) || Array.from(text).length >= 160;
  const read: [boolean, SpaceCue][] = [[otherAiIn(text), 'other_ai'], [LEAVING.test(text), 'leaving'], [serious, 'serious'], [tenderIn(text), 'tender']];
  return [...new Set([...cues, ...hurtCues(text), ...kindCues(text), ...read.filter(([found]) => found).map(([, cue]) => cue)])];
}

/** The cues of a recorded event: his words' (recorded on the event), a touch's stance, a comment's kind. */
export function cuesOfEvent(event: FeelingEvent): SpaceCue[] {
  if (event.kind === 'touched') {
    const stance = event.facts.stance;
    if (stance === 'welcome' || stance === 'fine') return ['touch_welcome'];
    return stance === 'dislike' || stance === 'refuse' ? ['touch_refused'] : [];
  }
  if (event.kind === 'comment' || event.kind === 'crowd_comment') {
    const hurtful = (event.facts.tags?.length ?? 0) > 0;
    return hurtful ? ['insult'] : event.facts.commentKind === 'praised' ? ['hype', 'stream_praise'] : ['hype'];
  }
  return (event.facts.cues ?? []).filter((cue): cue is SpaceCue => (SPACE_CUES as readonly string[]).includes(cue));
}

/** How awake her hour is (owner time): the small hours pull 覚醒 down, as do the late evening and the early morning. */
export function hourPull(localHour: number): number {
  if (localHour >= 1 && localHour <= 5) return -0.9;
  if (localHour === 23 || localHour === 0) return -0.45;
  return localHour >= 6 && localHour <= 7 ? -0.4 : 0;
}

const clamp = (value: number) => Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
const round = (value: number) => Math.round(value * 1000) / 1000;

export interface MoodInput {
  /** Her events of the day (every audience: her mood is one), with their instants. */
  events: readonly FeelingEvent[];
  /** This turn's cues, at `at` (his words now). */
  now: readonly SpaceCue[];
  at: string;
  localHour: number;
  /** Her lingering mood (the state's). */
  lingering: Pick<ShannonEmotion, 'valence' | 'arousal'>;
}

/** Her mood axes now: base, the lingering mood's colour, the hour, and every event's swing decayed by its axis's half-life. */
export function moodAxes(input: MoodInput): Readonly<Record<MoodAxis, number>> {
  const now = Date.parse(input.at);
  const swings: { at: number; cue: SpaceCue }[] = [
    ...input.events.flatMap(event => cuesOfEvent(event).map(cue => ({ at: Date.parse(event.occurredAt), cue }))),
    ...input.now.map(cue => ({ at: now, cue })),
  ].filter(swing => Number.isFinite(swing.at) && swing.at <= now);
  const axis = (name: MoodAxis) => {
    const { base, gain, halfLifeMinutes } = DEFAULT_PERSONALITY[name];
    const moved = swings.reduce((sum, swing) => sum + (CUE_SWINGS[swing.cue][name] ?? 0) * 0.5 ** ((now - swing.at) / (halfLifeMinutes * 60_000)), 0);
    return base + gain * moved;
  };
  return {
    pleasure: round(clamp(axis('pleasure') + LINGER_SHARE * input.lingering.valence)),
    arousal: round(clamp(axis('arousal') + LINGER_SHARE * (input.lingering.arousal - 0.45) + hourPull(input.localHour))),
    dominance: round(clamp(axis('dominance'))),
    play: round(clamp(axis('play'))),
  };
}

/** 安心 moves the same day with what he said today (the day fold carries the days before). */
export function securityToday(security: number, events: readonly FeelingEvent[], now: readonly SpaceCue[]): number {
  const moved = [...events.flatMap(cuesOfEvent), ...now].reduce((sum, cue) => sum + (CUE_SWINGS[cue].security ?? 0), 0);
  return round(clamp(security + moved));
}
