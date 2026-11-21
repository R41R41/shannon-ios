/**
 * Live commentary (session dc-live, owner 2026-10-20: 「エンドラ討伐をしながら、Discord で会話し、今何をしているか・どういう状況かを込みで実況」).
 * A moment is a closed fact about her Minecraft body that is worth a word (a diamond found, an armour complete, a near death, a night
 * fallen). This file holds what is pure: the kinds and how much each weighs, the fact line a moment is told in, and the governor that
 * decides whether she speaks of one now, from how loud it is and how long ago she last spoke. It holds no timer, no network and no
 * database; the service hands it the moment, the time and what the room is doing.
 *
 * Attention orders what happened; this governor is the only thing here that holds her back, and it never holds back a word that is an
 * answer (a reply to someone is not commentary). Spacing is its own, by the minute (one or two a minute at most), unlike the
 * proactive gate of the app, whose spacing is five minutes: a live commentary is a different thing from a message to the owner.
 */
export interface LiveCommentaryLimits {
  version: 'live_commentary.v1'; threshold: number; urgent: number; perMinute: number; perTenMinutes: number;
  gapSeconds: Readonly<{ ordinary: number; urgent: number }>; topicSeconds: number; kindSeconds: number;
  quietAfterHumanSeconds: Readonly<{ ordinary: number; important: number }>; maximumAgeSeconds: number; noveltyFloor: number; remembered: number;
}
export const LIVE_COMMENTARY_V1: LiveCommentaryLimits = Object.freeze({
  version: 'live_commentary.v1',
  /** A moment speaks at or above this salience. */
  threshold: 0.55,
  /** At or above this a moment is urgent: it breaks the quiet after someone's words and the topic spacing, and needs a shorter gap. */
  urgent: 0.9,
  /**
   * At most this many words of hers in a minute and in ten minutes (spoken or posted, as delivered). While she works with people in a call
   * a word every fifteen seconds is company, not noise; the body's own mouth holds six a minute (`voiceMouthCore.ts`), above this.
   * `liveCommentaryLimits` takes other numbers from the environment.
   */
  perMinute: 4,
  perTenMinutes: 28,
  /** The least time between two of her live words, in seconds: ordinary and urgent. */
  gapSeconds: Object.freeze({ ordinary: 12, urgent: 5 }),
  /** The same topic (the kind of thing) is not spoken of again within this many seconds; the same kind of moment within `kindSeconds`. */
  topicSeconds: 90,
  kindSeconds: 240,
  /** After someone's words (typed or spoken) she keeps quiet this long; an important moment breaks into a conversation after the shorter time. */
  quietAfterHumanSeconds: Object.freeze({ ordinary: 8, important: 3 }),
  /** A moment older than its own lifetime, or this many seconds, is only something that happened. */
  maximumAgeSeconds: 60,
  /** A line must be at least this unlike her last lines (1 − the highest trigram similarity). */
  noveltyFloor: 0.4,
  /** How many of her last live lines are remembered for that comparison. */
  remembered: 6,
});

/**
 * The numbers of a public stream's commentary: what the commentary had before she worked with people in a call (two words a minute, a gap
 * of eighteen seconds). A stream's room is many people who did not ask for anything, so it is not made busier by the call's numbers.
 */
export const LIVE_COMMENTARY_STREAM: LiveCommentaryLimits = Object.freeze({
  ...LIVE_COMMENTARY_V1, perMinute: 2, perTenMinutes: 7, gapSeconds: Object.freeze({ ordinary: 18, urgent: 6 }),
});

export const LIVE_MOMENT_KINDS = Object.freeze([
  'died', 'near_death', 'diamond_found', 'armor_complete', 'tool_made', 'dimension_entered', 'night_fell', 'morning', 'slept',
  'lava_escape', 'lava_near', 'structure_found', 'blaze_seen', 'item_got', 'dragon_stage', 'milestone_passed', 'milestone_late', 'hungry', 'stuck',
  // Her work as she does it: the plan she keeps, what a step needs, what she thinks as she acts, and the request ending.
  'plan_changed', 'plan_step', 'material_needed', 'material_got', 'thinking', 'task_done',
] as const);
export type LiveMomentKind = typeof LIVE_MOMENT_KINDS[number];

export type LiveScalar = string | number | boolean;
export interface LiveMoment {
  kind: LiveMomentKind;
  /** The same moment from one reading to the next has the same key; it is told once. */
  key: string;
  /** Milliseconds since the epoch, when it was seen. */
  at: number;
  /** Closed values only (an item id, a count, a place's name in the game's words); never a player's words. */
  facts: Readonly<Record<string, LiveScalar>>;
}

interface KindRow {
  /** The weight of the kind alone, in [0, 1]. */
  weight: number;
  /** What it is about: two moments of one topic are not spoken of within `topicSeconds`. */
  topic: string;
  /** How long the moment stays worth a word, in seconds. */
  lifetime: number;
  /** Own spacing, in seconds, where the common `topicSeconds` / `kindSeconds` are too long for a thing that comes often in her work. */
  topicSeconds?: number;
  kindSeconds?: number;
}

const KINDS: Readonly<Record<LiveMomentKind, KindRow>> = Object.freeze({
  died: { weight: 1, topic: 'life', lifetime: 45 },
  near_death: { weight: 0.9, topic: 'life', lifetime: 20 },
  diamond_found: { weight: 0.82, topic: 'diamond', lifetime: 60 },
  armor_complete: { weight: 0.78, topic: 'armor', lifetime: 60 },
  tool_made: { weight: 0.5, topic: 'tools', lifetime: 60 },
  dimension_entered: { weight: 0.93, topic: 'dimension', lifetime: 60 },
  night_fell: { weight: 0.45, topic: 'time', lifetime: 40 },
  morning: { weight: 0.35, topic: 'time', lifetime: 40 },
  slept: { weight: 0.6, topic: 'time', lifetime: 40 },
  lava_escape: { weight: 0.7, topic: 'hazard', lifetime: 20 },
  lava_near: { weight: 0.55, topic: 'hazard', lifetime: 25 },
  structure_found: { weight: 0.6, topic: 'structure', lifetime: 60 },
  blaze_seen: { weight: 0.65, topic: 'mob', lifetime: 30 },
  item_got: { weight: 0.55, topic: 'item', lifetime: 60 },
  dragon_stage: { weight: 0.88, topic: 'dragon', lifetime: 40 },
  milestone_passed: { weight: 0.5, topic: 'progress', lifetime: 60 },
  milestone_late: { weight: 0.5, topic: 'progress', lifetime: 90 },
  hungry: { weight: 0.4, topic: 'body', lifetime: 45 },
  stuck: { weight: 0.4, topic: 'progress', lifetime: 40 },
  // Her work, said as it goes. They come often and each is short-lived: a thought about a step that is over is not said.
  plan_changed: { weight: 0.62, topic: 'plan', lifetime: 20, topicSeconds: 20, kindSeconds: 30 },
  plan_step: { weight: 0.58, topic: 'plan', lifetime: 15, topicSeconds: 20, kindSeconds: 30 },
  material_needed: { weight: 0.6, topic: 'material', lifetime: 20, topicSeconds: 25, kindSeconds: 20 },
  material_got: { weight: 0.66, topic: 'material', lifetime: 15, topicSeconds: 25, kindSeconds: 20 },
  thinking: { weight: 0.56, topic: 'thought', lifetime: 15, topicSeconds: 30, kindSeconds: 30 },
  // The request ending is the loudest word of her work: urgent, so it breaks the quiet after someone's words and the spacing. Two short
  // requests can end a minute apart and each end is its own word, so the same-kind spacing is only a few seconds.
  task_done: { weight: 0.92, topic: 'done', lifetime: 90, kindSeconds: 5 },
});

export const liveTopicOf = (kind: LiveMomentKind): string => KINDS[kind].topic;
export const liveLifetimeSeconds = (kind: LiveMomentKind): number => KINDS[kind].lifetime;
/** The spacing a kind has of its own, when it has one: the topic's and the kind's, in seconds. */
export const liveOwnSpacing = (kind: LiveMomentKind): { topicSeconds?: number; kindSeconds?: number } => {
  const row = KINDS[kind];
  return { ...(row.topicSeconds !== undefined ? { topicSeconds: row.topicSeconds } : {}),
    ...(row.kindSeconds !== undefined ? { kindSeconds: row.kindSeconds } : {}) };
};

/**
 * The commentary's numbers with the ones the environment sets over them (`SHANNON_MINECRAFT_LIVE_PER_MINUTE`, `_PER_TEN_MINUTES`,
 * `_GAP_SECONDS`): how many words a minute she may say is a number to tune, not a switch. A value that is not a whole number in its
 * range is ignored.
 */
export function liveCommentaryLimits(values: Readonly<Record<string, string | undefined>>): LiveCommentaryLimits {
  const number = (name: string, least: number, most: number): number | null => {
    const raw = values[name]?.trim();
    const value = raw && /^\d{1,4}$/u.test(raw) ? Number(raw) : Number.NaN;
    return value >= least && value <= most ? value : null;
  };
  const perMinute = number('SHANNON_MINECRAFT_LIVE_PER_MINUTE', 1, 20), perTenMinutes = number('SHANNON_MINECRAFT_LIVE_PER_TEN_MINUTES', 1, 200);
  const gap = number('SHANNON_MINECRAFT_LIVE_GAP_SECONDS', 1, 120);
  return Object.freeze({ ...LIVE_COMMENTARY_V1, perMinute: perMinute ?? LIVE_COMMENTARY_V1.perMinute,
    perTenMinutes: perTenMinutes ?? Math.max(LIVE_COMMENTARY_V1.perTenMinutes, (perMinute ?? 0) * 7),
    gapSeconds: Object.freeze({ ordinary: gap ?? LIVE_COMMENTARY_V1.gapSeconds.ordinary,
      urgent: Math.min(gap ?? LIVE_COMMENTARY_V1.gapSeconds.urgent, LIVE_COMMENTARY_V1.gapSeconds.urgent) }) });
}

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * How loud a moment is, in [0, 1]: a noisy-OR (the shape of `SALIENCE_V1`) of the kind's weight, a bonus for the first of its kind, and a
 * bonus for a moment that comes while she is in danger. `first`: this kind has not been told yet in this run.
 */
export function liveSalience(kind: LiveMomentKind, context: { first: boolean; danger?: boolean }): number {
  const terms = [KINDS[kind].weight, context.first ? 0.2 : 0, context.danger ? 0.25 : 0];
  return unit(1 - terms.reduce((product, term) => product * (1 - unit(term)), 1));
}

const ITEM_WORDS: Readonly<Record<string, string>> = Object.freeze({
  diamond: 'ダイヤモンド', blaze_rod: 'ブレイズロッド', ender_pearl: 'エンダーパール', ender_eye: 'エンダーアイ', obsidian: '黒曜石',
  iron_pickaxe: '鉄のツルハシ', diamond_pickaxe: 'ダイヤのツルハシ', flint_and_steel: '火打石と打ち金', bucket: 'バケツ', bed: 'ベッド',
  carved_pumpkin: 'くり抜いたカボチャ', bow: '弓', water_bucket: '水入りのバケツ', lava_bucket: '溶岩入りのバケツ',
  // What her ordinary work asks for (a cake, a farm, a tool): the words she would say them in.
  cake: 'ケーキ', egg: '卵', sugar: '砂糖', sugar_cane: 'サトウキビ', milk_bucket: '牛乳入りのバケツ', wheat: '小麦', wheat_seeds: '小麦の種', bone_meal: '骨粉',
  iron_ingot: '鉄インゴット', raw_iron: '鉄の原石', planks: '板材', oak_planks: 'オークの板材', oak_log: 'オークの原木', crafting_table: '作業台',
  cobblestone: '丸石', coal: '石炭', stick: '棒', furnace: 'かまど', bread: 'パン', carrot: 'ニンジン', potato: 'ジャガイモ',
});
export const itemWords = (id: string): string => ITEM_WORDS[id] ?? (/^[a-z]+(?:_[a-z]+)*_bed$/u.test(id) ? 'ベッド' : id.replace(/_/gu, ' '));

