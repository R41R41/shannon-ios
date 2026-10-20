import { novelty } from './salience.js';
import {
  LIVE_COMMENTARY_V1, itemWords, liveLifetimeSeconds, liveSalience, liveTopicOf, type LiveMoment, type LiveMomentKind, type LiveScalar,
} from './liveCommentary.js';

/**
 * The governor of one run's live commentary (`liveCommentary.ts`): whether a moment may be told now, from how loud it is, how long ago
 * she last spoke, and what the room is doing. It remembers what she told and nothing else, and holds no timer: the service asks again a
 * little later when a hold is not final.
 */
export type LiveHold = 'salience' | 'stale' | 'rate' | 'gap' | 'topic' | 'kind' | 'human' | 'replying';
export type LiveVerdict = { speak: true; salience: number } | { speak: false; reason: LiveHold; salience: number };

/** What the room is doing when a moment is weighed. */
export interface LiveRoom {
  /** Milliseconds since the epoch. */
  now: number;
  /** Milliseconds since someone last wrote or spoke in the conversation she would speak into, or null when no one has. */
  sinceHumanMilliseconds: number | null;
  /** Someone is speaking in the voice channel right now: her commentary waits. */
  humanSpeaking?: boolean;
  /** She is writing a reply to someone now. */
  replying?: boolean;
  /** She is in danger now (low health, a hostile at her): a moment that comes then weighs more. */
  danger?: boolean;
}

interface Told { kind: LiveMomentKind; topic: string; at: number; text: string }

const text = (value: LiveScalar | undefined): string => (value === undefined ? '' : String(value)).slice(0, 60);
const DIMENSIONS: Readonly<Record<string, string>> = { the_nether: 'ネザー', the_end: 'ジ・エンド', overworld: 'オーバーワールド' };

type FactWriter = (facts: LiveMoment['facts']) => string;
const FACT_LINES: Readonly<Record<LiveMomentKind, FactWriter>> = Object.freeze({
  died: f => `体が倒れた（原因: ${text(f.cause) || '不明'}）。`,
  near_death: f => `体力が${text(f.health)}/20まで減った（${text(f.from) ? `${text(f.from)}に襲われている` : '危ない状態'}）。`,
  diamond_found: f => (f.carried === true ? `ダイヤモンドを手に入れた（${text(f.count)}個）。` : `ダイヤモンドの鉱石を見つけた（${text(f.count)}か所）。`),
  armor_complete: () => '鉄以上の防具が頭から足までそろい、着ている。',
  tool_made: f => `${itemWords(text(f.item))}ができた。`,
  dimension_entered: f => `${DIMENSIONS[text(f.dimension)] ?? text(f.dimension)}に入った。`,
  night_fell: () => '夜になった。',
  morning: () => '夜が明けた。',
  slept: () => 'ベッドで寝て、朝になった。',
  lava_escape: () => '溶岩に落ちかけて、反射で抜け出した。',
  structure_found: f => `${text(f.name)}を見つけた（${text(f.distance)}mほど先）。`,
  blaze_seen: () => 'ブレイズが近くにいる。',
  item_got: f => `${itemWords(text(f.item))}を手に入れた（いま${text(f.count)}個）。`,
  dragon_stage: f => (text(f.stage) === 'seen' ? 'エンダードラゴンが見えた。' : `エンドクリスタルが残り${text(f.crystals)}個になった。`),
  milestone_passed: f => `「${text(f.name)}」の段が済んだ（開始から${text(f.seconds)}秒）。`,
  milestone_late: f => `「${text(f.name)}」は目安の${text(f.target)}秒を${text(f.over)}秒すぎている。`,
  hungry: f => `満腹度が${text(f.food)}/20まで下がった。`,
  stuck: f => `${text(f.what) || '作業'}が${text(f.seconds)}秒ほど進んでいない。`,
});

/**
 * The fact line a moment is told in: what happened, in fixed words with its closed values. It reports; it never says what to do or
 * what to say (the model that writes her line reads it as data).
 */
export const liveFactLine = (moment: LiveMoment): string => FACT_LINES[moment.kind](moment.facts);

export class LiveGovernor {
  private readonly told: Told[] = [];
  private readonly kinds = new Set<LiveMomentKind>();
  private readonly spent = new Set<string>();

  constructor(private readonly limits: typeof LIVE_COMMENTARY_V1 = LIVE_COMMENTARY_V1) {}

  /** Whether this kind has not been told yet in this run (the first of a kind weighs more). */
  firstOf(kind: LiveMomentKind): boolean { return !this.kinds.has(kind); }

  /** The moment's own salience now, with the first-of-kind and danger terms. */
  salienceOf(moment: LiveMoment, room: Pick<LiveRoom, 'danger'>): number {
    return liveSalience(moment.kind, { first: this.firstOf(moment.kind), ...(room.danger ? { danger: true } : {}) });
  }

  verdict(moment: LiveMoment, room: LiveRoom): LiveVerdict {
    const salience = this.salienceOf(moment, room);
    const reason = this.holdReason(moment, room, salience);
    return reason ? { speak: false, reason, salience } : { speak: true, salience };
  }

  private holdReason(moment: LiveMoment, room: LiveRoom, salience: number): LiveHold | null {
    const age = (room.now - moment.at) / 1000;
    if (age > Math.min(this.limits.maximumAgeSeconds, liveLifetimeSeconds(moment.kind)) || this.spent.has(moment.key)) return 'stale';
    if (salience < this.limits.threshold) return 'salience';
    return this.roomHold(room, salience) ?? this.spacingHold(moment, room.now, salience);
  }

  /** What the room says: a reply being written, someone's words just now. */
  private roomHold(room: LiveRoom, salience: number): LiveHold | null {
    if (room.replying) return 'replying';
    const quiet = this.limits.quietAfterHumanSeconds[salience >= 0.75 ? 'important' : 'ordinary'] * 1000;
    const since = room.sinceHumanMilliseconds;
    return room.humanSpeaking || (since !== null && since < quiet) ? 'human' : null;
  }

  /** What her own earlier words say: the minute's budget, the gap, the same topic and the same kind. */
  private spacingHold(moment: LiveMoment, now: number, salience: number): LiveHold | null {
    const { limits } = this;
    const urgent = salience >= limits.urgent;
    const within = (seconds: number) => this.told.filter(item => now - item.at < seconds * 1000);
    if (within(60).length >= limits.perMinute || within(600).length >= limits.perTenMinutes) return 'rate';
    const last = this.told.at(-1);
    if (last && (now - last.at) / 1000 < limits.gapSeconds[urgent ? 'urgent' : 'ordinary']) return 'gap';
    if (!urgent && within(limits.topicSeconds).some(item => item.topic === liveTopicOf(moment.kind))) return 'topic';
    const life = moment.kind === 'died' || moment.kind === 'near_death';
    return within(life ? 30 : limits.kindSeconds).some(item => item.kind === moment.kind) ? 'kind' : null;
  }

  /** The moment will not be weighed again (it was told, or it went stale and was dropped). */
  spend(moment: LiveMoment): void {
    this.spent.add(moment.key);
    if (this.spent.size > 400) this.spent.delete(this.spent.values().next().value as string);
  }

  /** Her line was delivered: it counts toward the spacing and is remembered for the comparison. */
  delivered(moment: LiveMoment, words: string, at: number): void {
    this.spend(moment);
    this.kinds.add(moment.kind);
    this.told.push({ kind: moment.kind, topic: liveTopicOf(moment.kind), at, text: words });
    if (this.told.length > 64) this.told.shift();
  }

  /** The last lines she told, newest last (for the model: not to say it again). */
  recentWords(count = this.limits.remembered): string[] { return this.told.slice(-count).map(item => item.text); }

  /** Whether a written line is unlike her recent ones. */
  fresh(words: string): boolean { return novelty(words, this.recentWords()) >= this.limits.noveltyFloor; }

  /** Counts for the journal, closed values only. */
  stats(now: number): { told: number; lastMinute: number; last10Minutes: number } {
    const within = (seconds: number) => this.told.filter(item => now - item.at < seconds * 1000).length;
    return { told: this.told.length, lastMinute: within(60), last10Minutes: within(600) };
  }
}

/**
 * Of the moments waiting, the one to tell and the ones folded into its telling: the loudest first (a tie goes to the newer), then up to two
 * others of other kinds as "also happened". The rest are told by the main one's telling.
 */
export function pickMoments<T extends { moment: LiveMoment; salience: number }>(waiting: readonly T[]): { main: T; also: T[] } | null {
  const ordered = [...waiting].sort((a, b) => b.salience - a.salience || b.moment.at - a.moment.at);
  const main = ordered[0];
  return main ? { main, also: ordered.slice(1).filter(item => item.moment.kind !== main.moment.kind).slice(0, 2) } : null;
}
