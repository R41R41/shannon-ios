import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { OWNER_AUDIENCE, type CompanionStateSnapshot, type FeelingEvent } from '@shannon/cognition';
import { FeelingShadow } from '../mind/emotion/feelingShadow.js';
import { SQLiteFeelingShadowStore } from '../mind/emotion/store/feelingShadowStore.js';
import { FeelingEvents, type RepetitionSeed } from '../mind/emotion/feelingEvents.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { visibleReplayMessages } from '../mind/memory/memoryVisibility.js';
import { feelingEventsEnabled, feelingTurnEnabled, singleFaceEnabled, type FeelingPort } from '../mind/emotion/feelingPorts.js';
import { SQLiteFeelingEventStore } from '../mind/emotion/store/feelingEventStore.js';
import { BODY_TOUCH_PART_WORDS, bodyTouchPartWord, bodyTouchRegionWord, isBodyTouchPart, isBodyTouchRegion } from '../surfaces/body/bodyTouchWords.js';
import { configuredJevChooser } from './skillRoutingWiring.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import type { DatabaseSync } from 'node:sqlite';
import { switchOn } from '@shannon/switches';
import { AnthropicChatModel } from '../infra/models/anthropic/anthropicChatModel.js';
import { anthropicApiKey, sonnetSettings } from '../infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import { FeelingReplyChatModel } from '../infra/models/feelingStrongChatModel.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import type { WebSearchOperation } from '../infra/models/webSearch.js';
import { FEELING_TURN_JEV_INPUT, FEELING_TURN_JEV_INPUTS, type FeelingTurnJevInput } from '../contracts/feelingEventContract.js';
import { configuredFeelingSentenceWriter, type FeelingSentenceWriter } from '../infra/models/feelingSentenceModel.js';
import { FeelingDays, carriesAnything, type FeelingDayFeatures } from '../mind/emotion/feelingDays.js';
import { StreamFeeling } from '../mind/emotion/streamFeeling.js';
import { SQLiteFeelingDayStore } from '../mind/emotion/store/feelingDayStore.js';
import { SQLiteReplyDraftStore, type ReplyDraft } from '../mind/emotion/store/replyDraftStore.js';

export interface ConfiguredFeeling {
  port: FeelingPort;
  /** The kernel's chat model, with strong feeling turns on Sonnet while `SHANNON_FEELING_STRONG_REPLY_MODEL` is on; else as it was. */
  wrap(model: ShannonChatModel): ShannonChatModel;
  close(): void;
}

/** The day's cap of strong replies (`SHANNON_FEELING_STRONG_REPLY_DAILY_CAP`; owner decision 2026-10-14: a daily guard). */
export const FEELING_STRONG_REPLY_DAILY_CAP = 200;

/** Sonnet for strong feeling turns: the app's Sonnet settings and the shared Anthropic key; null when switched off or without the key. */
function strongReplyModel(environment: Readonly<Record<string, string | undefined>>, parts: { usageStore?: LlmUsageStore; now: () => string;
  webSearch?: WebSearchOperation })
  : AnthropicChatModel | null {
  const apiKey = anthropicApiKey(environment);
  if (!switchOn(environment, 'SHANNON_FEELING_STRONG_REPLY_MODEL') || !feelingTurnEnabled(environment) || !apiKey) return null;
  return new AnthropicChatModel({ apiKey, settings: sonnetSettings(environment), now: parts.now,
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac', ...(parts.usageStore ? { usageStore: parts.usageStore } : {}),
    ...(parts.webSearch ? { webSearch: parts.webSearch } : {}) });
}

/** Her feeling sentence's writer (`SHANNON_FEELING_SENTENCE`), only beside the turn and the shadow it reads; null otherwise. */
function sentenceWriter(environment: Readonly<Record<string, string | undefined>>, beside: boolean, parts: { usageStore?: LlmUsageStore; now: () => string })
  : FeelingSentenceWriter | null {
  if (!beside || !switchOn(environment, 'SHANNON_FEELING_SENTENCE')) return null;
  return configuredFeelingSentenceWriter(environment, { ...(parts.usageStore ? { usageStore: parts.usageStore } : {}), now: parts.now });
}

/**
 * `SHANNON_INNER_NARRATOR` with the inner note it changes (the fast layer it reads is checked where the port is composed), and
 * `SHANNON_TEXT_REGISTER` with the feeling turn it reads.
 */
function presentationFlags(environment: Readonly<Record<string, string | undefined>>, turn: boolean)
  : { narrator: boolean; textRegister: boolean; meaning: boolean } {
  const narrator = switchOn(environment, 'SHANNON_INNER_NARRATOR') && switchOn(environment, 'SHANNON_INNER_NOTE');
  return { narrator, textRegister: turn && switchOn(environment, 'SHANNON_TEXT_REGISTER'), meaning: turn && switchOn(environment, 'SHANNON_FEELING_MEANING') };
}

/** The cap, from the environment: a whole number from 0 (none) to 10 000; anything else is the default. */
export function strongReplyDailyCap(environment: Readonly<Record<string, string | undefined>>): number {
  const value = Number(environment.SHANNON_FEELING_STRONG_REPLY_DAILY_CAP?.trim() || Number.NaN);
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : FEELING_STRONG_REPLY_DAILY_CAP;
}

/** A touch without a part is named by what was done (the ledger line's 「今日のつつかれた件」 reads 「今日の体（つつく）の件」). */
const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ pet: 'なでる', poke: 'つつく', tickle: 'くすぐる', carry: '運ぶ', holdHand: '手をにぎる' });

/** A subject of the ledger in her words: a part (胸), a region (頭), or the body with what was done. */
export function feelingPartWord(subject: string): string {
  if (isBodyTouchPart(subject)) return bodyTouchPartWord(subject);
  if (isBodyTouchRegion(subject)) return bodyTouchRegionWord(subject);
  return KIND_WORDS[subject] ? `体（${KIND_WORDS[subject]}）` : '体';
}

/**
 * Her feeling events, the feeling turn and the one face (Syzygy ADR-0013 stage 1), composed for the API process: the table (schema
 * step `emotion/004_feeling_events`), the service, and Jev for the text feeling turn (the stage-2 Jev client with its trace writer;
 * none without `TYPESAFE_API_KEY`). `SHANNON_FEELING_EVENTS` off (the default): null, nothing is opened, no table is created, and
 * every prompt and face is what it was.
 */
export function configuredFeeling(environment: Readonly<Record<string, string | undefined>>, parts: {
  databasePath: string; timeZone: string; now: () => string; trace: DecisionTraceWriter | null; salt?: string; jevFetch?: typeof fetch;
  /** The conversation, for seeding the repetition watch with today's replies of the owner's Talk. */
  conversation?: ConversationStore;
  usageStore?: LlmUsageStore;
  /** Her state now, for the stage-2 shadow (`SHANNON_CORE_AFFECT`). */
  state?: (scopeKey: string) => CompanionStateSnapshot;
  /** The web search her Sonnet uses, as the app's Sonnet tier is handed it (the conversation model's). */
  webSearch?: WebSearchOperation;
}): ConfiguredFeeling | null {
  if (!feelingEventsEnabled(environment)) return null;
  const turn = feelingTurnEnabled(environment);
  const chooser = turn ? configuredJevChooser(environment, { trace: parts.trace, now: parts.now, ...(parts.salt ? { salt: parts.salt } : {}),
    ...(parts.jevFetch ? { jevFetch: parts.jevFetch } : {}) }) : null;
  const singleFace = singleFaceEnabled(environment);
  const shadow = switchOn(environment, 'SHANNON_CORE_AFFECT') && parts.state ? { shadow: { database: parts.databasePath, snapshot: parts.state } } : {};
  const jevInput = feelingTurnJevInput(environment);
  // Her replies of the day (the repetition watch) and his words of the last days (the topics to follow up on), from his Talk.
  const seeds = parts.conversation ? { seed: talkSeed(parts.conversation), talk: talkSeed(parts.conversation, 'user') } : {};
  const sonnet = strongReplyModel(environment, parts);
  const strong = sonnet ? { strong: { cap: strongReplyDailyCap(environment), model: sonnet } } : {};
  const check = turn && switchOn(environment, 'SHANNON_REPLY_CHECK');
  const writer = sentenceWriter(environment, turn && 'shadow' in shadow, parts);
  return composedFeeling({ database: parts.databasePath, now: parts.now, timeZone: parts.timeZone, chooser, turn, singleFace, jevInput,
    ...seeds, ...strong, ...shadow, check, ...(writer ? { sentence: writer } : {}), ...presentationFlags(environment, turn),
    days: spaceGuarded(feelingDayFeatures(environment), turn, check), audience: switchOn(environment, 'SHANNON_FEELING_AUDIENCE'),
    stream: switchOn(environment, 'SHANNON_FEELING_STREAM') });
}

/**
 * Today's replies of hers in the owner's newest Talk, through the replay's own forgetting filter (what the owner alone may be shown), for
 * the repetition watch's first turns of the day.
 */
export function talkSeed(conversation: ConversationStore, role: 'assistant' | 'user' = 'assistant'): RepetitionSeed {
  // Owner 2026-10-19: the day's phrases are counted over the day (`watchPhrases`), and a day of his spans several Talks: every Talk
  // that moved since then (the newest always), oldest first. `user`: his words, for the topics to follow up on (`followUpTopics`).
  const limit = role === 'user' ? TALK_WORDS_MESSAGES : TALK_SEED_MESSAGES;
  return (scopeKey, since, at, snapshot) => conversation.listThreads(scopeKey)
    .filter((thread, index) => index === 0 || thread.updatedAt >= since).slice(0, TALK_SEED_THREADS)
    .flatMap(thread => visibleReplayMessages(snapshot, conversation, scopeKey, thread.threadId, OWNER_AUDIENCE, limit).messages
      .filter(entry => entry.item.role === role && entry.message.observedAt >= since && entry.message.observedAt <= at)
      .map(entry => ({ text: entry.item.content, at: entry.message.observedAt,
        ...(entry.message.sourceExperienceId ? { sourceId: entry.message.sourceExperienceId } : {}) })))
    .sort((left, right) => left.at.localeCompare(right.at));
}
/** The Talk readers handed in, as the options of `FeelingEvents`. */
function talkSeeds(parts: { seed?: RepetitionSeed; talk?: RepetitionSeed }): { seed?: RepetitionSeed; talk?: RepetitionSeed } {
  return { ...(parts.seed ? { seed: parts.seed } : {}), ...(parts.talk ? { talk: parts.talk } : {}) };
}
const TALK_SEED_MESSAGES = 48;
const TALK_WORDS_MESSAGES = 96;
const TALK_SEED_THREADS = 4;

/**
 * `SHANNON_FEELING_TURN_JEV_INPUT` (`utterance` | `summary`; unset or anything else: `FEELING_TURN_JEV_INPUT`, `utterance` by the owner's
 * decision of 2026-10-14): whether Jev is handed the turn's words or only the closed facts.
 */
export function feelingTurnJevInput(environment: Readonly<Record<string, string | undefined>>): FeelingTurnJevInput {
  const value = environment.SHANNON_FEELING_TURN_JEV_INPUT?.trim().toLowerCase();
  return FEELING_TURN_JEV_INPUTS.find(input => input === value) ?? FEELING_TURN_JEV_INPUT;
}

/** The port's stage-2 flags: each only with what it reads (the shadow, the turn). */
function portFlags(parts: { check?: boolean; shadow?: unknown; sentence?: FeelingSentenceWriter; narrator?: boolean; textRegister?: boolean; turn: boolean;
  meaning?: boolean; audience?: boolean }) {
  return { ...(parts.check ? { check: true } : {}), ...(parts.shadow ? { coreAffect: true } : {}), ...(parts.audience ? { audience: true } : {}),
    ...(parts.meaning && parts.shadow && parts.turn ? { meaning: true } : {}),
    ...(parts.sentence && parts.shadow ? { sentence: parts.sentence } : {}), ...(parts.narrator && parts.shadow ? { narrator: true } : {}),
    ...(parts.textRegister && parts.turn ? { textRegister: true } : {}) };
}

/** Stage 3's closed days, when any of what they carry is on; else nothing is opened and no table is made. */
function closedDays(parts: { database: string | DatabaseSync; now: () => string; timeZone: string; days?: FeelingDayFeatures; talk?: RepetitionSeed },
  events: SQLiteFeelingEventStore): { days: { days?: FeelingDays }; store: SQLiteFeelingDayStore | null } {
  const features = parts.days;
  if (!features || !carriesAnything(features)) return { days: {}, store: null };
  const store = new SQLiteFeelingDayStore(parts.database);
  const subjects = Object.entries(BODY_TOUCH_PART_WORDS).filter(([subject]) => subject !== 'other').map(([subject, { word }]) => ({ subject, word }));
  const talk = features.space && parts.talk ? { talk: parts.talk } : {};
  return { days: { days: new FeelingDays({ events, store, timeZone: parts.timeZone, now: parts.now, features, partWord: feelingPartWord, subjects,
    ...talk }) }, store };
}

/** The stage-3 switches (each needs `SHANNON_FEELING_EVENTS`, checked before this is read), and her character space with 好意 held at the top. */
export function feelingDayFeatures(environment: Readonly<Record<string, string | undefined>>): FeelingDayFeatures {
  const natural = switchOn(environment, 'SHANNON_NATURAL_TALK') ? { natural: true } : {};
  const space = switchOn(environment, 'SHANNON_CHARACTER_SPACE') ? { space: { max: switchOn(environment, 'SHANNON_AFFECTION_MAX'), ...natural } } : {};
  return { relationship: switchOn(environment, 'SHANNON_RELATIONSHIP_LEDGER'), episodes: switchOn(environment, 'SHANNON_EPISODE_MEMORY'),
    boundaries: switchOn(environment, 'SHANNON_BOUNDARY_MEMORY'), ...space };
}

/**
 * Her character space only with the feeling turn it leans and the reply check that guards it (a switch's `requires` only warns at start;
 * review 8: the regions that pull toward the lines no region crosses are checked before sending, so without the check the space stays
 * off, and the log says so).
 */
export function spaceGuarded(features: FeelingDayFeatures, turn: boolean, check: boolean): FeelingDayFeatures {
  if (!features.space) return features;
  const { space: _space, ...rest } = features;
  if (turn && check) return features;
  if (turn) console.warn('Shannon character space: SHANNON_CHARACTER_SPACE needs SHANNON_REPLY_CHECK; it stays off');
  return rest;
}

/** Her character space needs her closed days (the relation's folds): it is on only with them. */
function spaceOption(days: FeelingDayFeatures | undefined, closed: FeelingDays | undefined): { space?: { max: boolean; natural?: boolean } } {
  return days?.space && closed ? { space: days.space } : {};
}

/** `SHANNON_NATURAL_TALK` (with her space and the check): the owner's rewritten drafts are kept a few days (`replyDraftStore.ts`); else none. */
function draftKeeping(parts: { database: string | DatabaseSync; now: () => string; check?: boolean }, space: { space?: { natural?: boolean } })
  : { drafts: SQLiteReplyDraftStore | null; drafted: { drafted?: (scopeKey: string, draft: ReplyDraft) => void } } {
  if (!space.space?.natural || !parts.check) return { drafts: null, drafted: {} };
  const drafts = new SQLiteReplyDraftStore(parts.database, parts.now);
  return { drafts, drafted: { drafted: (scopeKey, draft) => drafts.keep(scopeKey, draft) } };
}

/** The composition itself (tests and the replay hand their own parts: an in-memory table, a fake or real chooser). */
export function composedFeeling(parts: { database: string | DatabaseSync; now: () => string; timeZone: string; chooser: JevChooser | null; turn: boolean;
  singleFace: boolean; jevInput?: FeelingTurnJevInput; seed?: RepetitionSeed; talk?: RepetitionSeed; strong?: { cap: number; model: AnthropicChatModel };
  /** Stage 2 (`SHANNON_REPLY_CHECK`): her replies are checked. */
  check?: boolean;
  /** Item 10 (`SHANNON_TEXT_REGISTER`): her text reply's form and pacing (only with the turn). */
  textRegister?: boolean;
  /** Review M4 (`SHANNON_FEELING_MEANING`): Jev reads the meaning of his words (only with the shadow and the turn). */
  meaning?: boolean;
  /** Stage 2 (`SHANNON_INNER_NARRATOR`): her inner note reads the fast layer (only with the shadow). */
  narrator?: boolean;
  /** Stage 2 (`SHANNON_FEELING_SENTENCE`): her feeling sentence's writer (used only with the shadow and the turn). */
  sentence?: FeelingSentenceWriter;
  /** Stage 2 (`SHANNON_CORE_AFFECT`): the shadow's table and her state now (for the comparison and the forgetting filter). */
  shadow?: { database: string | DatabaseSync; snapshot: (scopeKey: string) => CompanionStateSnapshot };
  /** Stage 3: what is carried across days (the closed-day table opens only when one of them is on). */
  days?: FeelingDayFeatures;
  /** Stage 4 (`SHANNON_FEELING_AUDIENCE`): keys by who wrote, light ledgers, audience layers, the source cap and the audience checks. */
  audience?: boolean;
  /** Stage 5 (`SHANNON_FEELING_STREAM`, with the audience layers): her feeling on a stream. */
  stream?: boolean }): ConfiguredFeeling {
  // Review R1: the audience layers only with the reply check and the turn they rely on (a switch's `requires` only warns at start);
  // without the check, no marked line of the owner's reaches a turn with others present.
  const audience = parts.audience === true && parts.check === true && parts.turn;
  const store = new SQLiteFeelingEventStore(parts.database);
  const seed = talkSeeds(parts);
  const shadowStore = parts.shadow ? new SQLiteFeelingShadowStore(parts.shadow.database) : null;
  let events: FeelingEvents | null = null;
  const shadow = shadowStore && parts.shadow
    ? new FeelingShadow({ events: () => events, store: shadowStore, snapshot: parts.shadow.snapshot, now: parts.now, sourceCap: audience })
    : null;
  const onRecorded = shadow ? { onRecorded: (scopeKey: string, event: FeelingEvent) => shadow.recorded(scopeKey, event) } : {};
  const closed = closedDays({ ...parts, ...(parts.days ? { days: { ...parts.days, audience } } : {}) }, store);
  const space = spaceOption(parts.days, closed.days.days);
  events = new FeelingEvents({ store, now: parts.now, timeZone: parts.timeZone, partWord: feelingPartWord, ...seed, ...onRecorded, ...closed.days, ...space });
  const strong = parts.strong ? { strong: { cap: parts.strong.cap } } : {};
  const jevInput = parts.jevInput ?? FEELING_TURN_JEV_INPUT;
  const flags = portFlags({ ...parts, audience });
  // The stream port only with the audience layers, which hold only with the reply check (review T2: a stream reply is checked before sending).
  const stream = parts.stream && audience ? { stream: new StreamFeeling({ events, days: closed.days.days ?? null, replyCheck: parts.check === true }) } : {};
  const port = { events, chooser: parts.chooser, turn: parts.turn, singleFace: parts.singleFace, jevInput, ...strong, ...flags, ...closed.days,
    ...stream };
  const sonnet = parts.strong?.model ?? null;
  const checked = (scopeKey: string, found: readonly string[], rewritten: boolean, turn?: string) => events?.noteCheck(scopeKey, found, rewritten, turn);
  const released = (scopeKey: string) => events?.releaseStrong(scopeKey, parts.now());
  const { drafts, drafted } = draftKeeping(parts, space);
  const wrap = (model: ShannonChatModel) => (sonnet || parts.check ? new FeelingReplyChatModel(model, { sonnet, checked, released, ...drafted }) : model);
  const close = () => {
    store.close();
    drafts?.close();
    shadowStore?.close();
    closed.store?.close();
  };
  return { port, wrap, close };
}
