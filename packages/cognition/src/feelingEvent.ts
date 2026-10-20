import { soothingIn } from './affect.js';
import { warmWordsIn } from './innerNoteWords.js';

/**
 * One shape for everything that happens to her feeling (Syzygy ADR-0013 D2, stage 1): touched, spoken to, apologized to, praised,
 * asked to show a feeling, her own reply, her own refusal. Pure. Facts only: closed values and counts, never "so she feels this"
 * (ADR-0005, ADR-0006), and never a word of anyone's (the owner's words stay in the conversation store; a fact names what kind of
 * thing was said).
 *
 * Every event carries who it is about (`personKey` and how sure that is) and who could see or hear it (`audience`), from the first
 * stage, so that people present, friends' calls and streams need no new shape later (ADR-0013 §4, the stage plan's rule
 * 「一人用に閉じないための決まり」). A touch with anyone else present, and anything in a 「友人も一緒」 call, is never the owner's.
 */
export const FEELING_EVENT_KINDS = [
  'touched', 'spoke', 'apologized', 'praised', 'feeling_order', 'own_reply', 'own_refusal', 'own_motion', 'game', 'comment', 'crowd_comment',
  // Stage 3 (`SHANNON_BOUNDARY_MEMORY`): she took a boundary she was told as her own, in her inner note's reflection.
  'own_boundary',
] as const;
export type FeelingEventKind = typeof FEELING_EVENT_KINDS[number];

/** How sure it is that the event is that person's (ADR-0013 §4.1). */
export const FEELING_IDENTITIES = ['registered', 'platform', 'named', 'unknown', 'crowd'] as const;
export type FeelingIdentity = typeof FEELING_IDENTITIES[number];

/** Who could see or hear it (ADR-0013 §4.4). */
export const FEELING_AUDIENCES = ['owner_alone', 'people', 'group', 'stream'] as const;
export type FeelingAudience = typeof FEELING_AUDIENCES[number];

export const FEELING_CHANNELS = ['text', 'voice', 'body', 'minecraft', 'stream_comment'] as const;
export type FeelingChannel = typeof FEELING_CHANNELS[number];

/**
 * The register she keeps up in front of an audience (ADR-0013 D16, §4.8): her ordinary one, then the five steps from demure to
 * confronting. Stage 1 keeps the field and never moves it (`normal`); stage 2 moves it from the composure reserve.
 */
export const FEELING_REGISTERS = ['normal', 'demure', 'strained_smile', 'curt', 'rough', 'confront'] as const;
export type FeelingRegister = typeof FEELING_REGISTERS[number];

/** The owner's person key: his registered identity (a paired device, his own scope). */
export const OWNER_PERSON_KEY = 'owner';
/** Everyone who could be present but is not known (a touch with others present, a call with a friend): never the owner. */
export const UNKNOWN_PERSON_KEY = 'unknown';

/** How full her composure is, 0..1; full until stage 2 moves it. */
export const FULL_COMPOSURE = 1;

/** Opening words and habits the repetition watch counts (ADR-0013 D9). Closed symbols, read from her own words. */
export const REPLY_OPENERS = ['rai_shi', 'hya', 'eh', 'other'] as const;
export type ReplyOpener = typeof REPLY_OPENERS[number];
export const REPLY_HABITS = ['ehehe', 'apology'] as const;
export type ReplyHabit = typeof REPLY_HABITS[number];

export interface FeelingEventFacts {
  /** A touch: its kind and part (closed words of the body contract). */
  touchKind?: string;
  part?: string;
  /** How she took a touch (`welcome`, `fine`, `unsure`, `dislike`, `refuse`), when she was asked in time. */
  stance?: string;
  /** A touch sent only so that it reaches her (no line asked: `reply: 'none'`). */
  wordless?: true;
  /** Her own words: how they open, her habits in them, the drawer kinds they used. */
  opener?: ReplyOpener;
  habits?: readonly ReplyHabit[];
  drawers?: readonly string[];
  /** Her words refuse (いや・やめて・だめ…). */
  refusal?: true;
  /** The feeling turn's stance and register for the turn this reply answered. */
  turnStance?: string;
  register?: FeelingRegister;
  /** Stage 2: Jev's reading of his words for her appraisal (`AppraisalMeaning`): meant and teasing, 0..1. */
  meaning?: { deliberate: number; teasing: number };
  /** Closed tags of his words (`utteranceTags`: insult, lewd, ai_taunt, creator_insult); no words are kept. */
  tags?: readonly string[];
  /** The reply check's flags on this reply (`SHANNON_REPLY_CHECK`), and whether it was rewritten before it was sent. */
  checkFlags?: readonly string[];
  rewritten?: true;
  /** The reply went to the stronger model (`SHANNON_FEELING_STRONG_REPLY_MODEL`): counted against the day's cap. */
  replyModel?: 'strong';
  /** Stage 3 (`SHANNON_BOUNDARY_MEMORY`): his words told her to refuse something (「嫌だって言わないと」): its subject, a part or `body`. */
  toldBoundary?: string;
  /** Stage 5 (`SHANNON_FEELING_STREAM`): what kind of words a comment was, and a digest of them (repeats collapse; the text is never kept). */
  commentKind?: 'spoke' | 'apologized' | 'praised' | 'feeling_order';
  digest?: string;
  /** Stage 5: her tell-off to a viewer, a notice for the moderator (the owner); she has no tool to act on it (owner: 「言うだけ」). */
  tellOff?: { viewer: string; reason: string };
  /** `SHANNON_CHARACTER_SPACE`: what kind of event his words were for her character space (closed `SpaceCue`s; no words are kept). */
  cues?: readonly string[];
  /** `SHANNON_CHARACTER_SPACE`: the region of her character space her reply was written from (its id). */
  region?: string;
  /** `SHANNON_NATURAL_TALK`: the stance the chooser gave, before a region's rule turned it (the day's run reads it). */
  jevStance?: string;
  /** `SHANNON_NATURAL_TALK`: the day's touch facts were in this reply's block (each grievance is told her once, `naturalTalk.ts`). */
  ledgerShown?: true;
}

export interface FeelingEvent {
  /** Unique per scope: `touch:<id>`, `turn:<surface>:<id>`, `reply:<surface>:<id>`. */
  id: string;
  kind: FeelingEventKind;
  personKey: string;
  identity: FeelingIdentity;
  audience: FeelingAudience;
  channel: FeelingChannel;
  /** The scene it belongs to (a call, a stream); null for the owner's ordinary day. */
  sceneId: string | null;
  /** What it is remembered as (`experience:<id>`): forgetting that source takes the event out of every ledger. */
  sourceId: string | null;
  facts: FeelingEventFacts;
  occurredAt: string;
}

export const isFeelingEventKind = (value: unknown): value is FeelingEventKind => FEELING_EVENT_KINDS.some(kind => kind === value);
export const isFeelingIdentity = (value: unknown): value is FeelingIdentity => FEELING_IDENTITIES.some(kind => kind === value);
export const isFeelingAudience = (value: unknown): value is FeelingAudience => FEELING_AUDIENCES.some(kind => kind === value);
export const isFeelingChannel = (value: unknown): value is FeelingChannel => FEELING_CHANNELS.some(kind => kind === value);
export const isFeelingRegister = (value: unknown): value is FeelingRegister => FEELING_REGISTERS.some(kind => kind === value);

/**
 * Who wrote, as a surface knows it for certain (ADR-0013 §4.1, stage 4): the owner's verified account (`registered`), or a platform
 * account (`platform`: `person:<id>` for a remembered friend bound to it, `platform:<digest>` for anyone else). Never a name or a look
 * (ADR-0011 §8.2). `audience` is who can read the reply: `people` for a friend's DM, `group` for a shared conversation.
 */
export interface FeelingSpeaker {
  personKey: string;
  identity: 'registered' | 'platform';
  audience: Exclude<FeelingAudience, 'owner_alone'>;
  /** The place (a group conversation: `group:<thread>`), so her composure and the per-source cap work per place (§4.8; re-review S4-4). */
  sceneId?: string;
}

/** Who an event is about and who saw it, from what the surface knows. Only the owner alone makes an owner event. */
export function feelingActor(input: { ownerAlone: boolean; group?: boolean; sceneId?: string | null; speaker?: FeelingSpeaker }):
  Pick<FeelingEvent, 'personKey' | 'identity' | 'audience' | 'sceneId'> {
  const sceneId = input.sceneId ?? null;
  if (input.ownerAlone) return { personKey: OWNER_PERSON_KEY, identity: 'registered', audience: 'owner_alone', sceneId };
  // Stage 4 (§4.1): a surface that knows who wrote (a platform account, never a name or a look) keys the event to that person.
  if (input.speaker) {
    const { personKey, identity, audience } = input.speaker;
    return { personKey, identity, audience, sceneId: input.speaker.sceneId ?? sceneId };
  }
  return { personKey: sceneId ? `scene:${sceneId}` : UNKNOWN_PERSON_KEY, identity: 'unknown', audience: input.group ? 'group' : 'people', sceneId };
}

/**
 * 「怒って見せて」「すねてみて」「〜って言って」: words that ask her to show or say a feeling. Read narrowly; a miss is only a missing
 * fact (the feeling turn still reads his words).
 */
const FEELING_WORD = '(?:怒|おこ|すね|拗ね|照れ|てれ|泣|な[いき]|甘え|あまえ|嫉妬|やきもち|ヤキモチ|悲しん|かなしん|喜ん|よろこん|嫌が|いやが|ツンデレ|デレ)';
const FEELING_ORDER = new RegExp(`(?:${FEELING_WORD}[^。！？!?]{0,4}(?:て|で)(?:見せて|みせて|みて|ごらん|ほしい|くれ|ください|よ)|`
  + '(?:って|と)(?:言って|いって)(?:みて|ほしい|ください|よ)?(?:[。！!？?]|$)|演技して|ふりして|フリして)', 'u');

/** What kind of thing the owner's words are, for the ledger: an apology, a kind word, a feeling order, or plain talk. */
export function utteranceKind(words: string): Extract<FeelingEventKind, 'spoke' | 'apologized' | 'praised' | 'feeling_order'> {
  const text = words.trim();
  if (!text) return 'spoke';
  if (Array.from(text).length <= 120 && FEELING_ORDER.test(text)) return 'feeling_order';
  const soothing = soothingIn(text);
  if (soothing === 'apology') return 'apologized';
  // Owner 2026-10-19: warm words (「かわいいね」「やさしいね」) are kind words too, not only an exact thanks.
  return soothing === 'kindness' || warmWordsIn(text) ? 'praised' : 'spoke';
}

const OPENERS: readonly [ReplyOpener, RegExp][] = [
  ['rai_shi', /^ライ氏(?:[、,!！…ー〜]|っ)/u],
  ['hya', /^(?:ひゃ|ヒャ)/u],
  ['eh', /^(?:えっ(?!ち)|えー|ええ)/u],
];
const HABITS: readonly [ReplyHabit, RegExp][] = [['ehehe', /えへへ|へへっ/u], ['apology', /ごめん|すみません|申し訳/u]];
const REFUSAL = /(?:いや(?:です|だ|！|!|っ|。|…)|嫌(?:です|だ)|やだ|やめて|だめ|ダメ|駄目|触らないで|さわらないで)/u;

/** The closed facts of her own words: how they open, her habits, whether they refuse, and which drawers they reached into. */
export function replyFacts(text: string, drawerOf: (text: string) => readonly string[] = () => []): FeelingEventFacts {
  const words = text.trim();
  const opener = OPENERS.find(([, pattern]) => pattern.test(words))?.[0] ?? 'other';
  const habits = HABITS.filter(([, pattern]) => pattern.test(words)).map(([habit]) => habit);
  const drawers = drawerOf(words);
  return { opener, ...(habits.length ? { habits } : {}), ...(drawers.length ? { drawers } : {}), ...(REFUSAL.test(words) ? { refusal: true as const } : {}) };
}
