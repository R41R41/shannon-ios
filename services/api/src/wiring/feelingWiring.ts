import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { FeelingEvents, type RepetitionSeed } from '../mind/emotion/feelingEvents.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { visibleReplayMessages } from '../mind/memory/memoryVisibility.js';
import { feelingEventsEnabled, feelingTurnEnabled, singleFaceEnabled, type FeelingPort } from '../mind/emotion/feelingPorts.js';
import { SQLiteFeelingEventStore } from '../mind/emotion/store/feelingEventStore.js';
import { bodyTouchPartWord, bodyTouchRegionWord, isBodyTouchPart, isBodyTouchRegion } from '../surfaces/body/bodyTouchWords.js';
import { configuredJevChooser } from './skillRoutingWiring.js';
import type { JevChooser } from '../infra/models/jev/jevChoice.js';
import type { DatabaseSync } from 'node:sqlite';
import { switchOn } from '@shannon/switches';
import { AnthropicChatModel } from '../infra/models/anthropic/anthropicChatModel.js';
import { anthropicApiKey, sonnetSettings } from '../infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import { FeelingStrongChatModel } from '../infra/models/feelingStrongChatModel.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import type { WebSearchOperation } from '../infra/models/webSearch.js';
import { FEELING_TURN_JEV_INPUT, FEELING_TURN_JEV_INPUTS, type FeelingTurnJevInput } from '../contracts/feelingEventContract.js';

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

/** The cap, from the environment: a whole number from 0 (none) to 10 000; anything else is the default. */
export function strongReplyDailyCap(environment: Readonly<Record<string, string | undefined>>): number {
  const value = Number(environment.SHANNON_FEELING_STRONG_REPLY_DAILY_CAP?.trim() || Number.NaN);
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : FEELING_STRONG_REPLY_DAILY_CAP;
}

/** A touch without a part is named by what was done (the ledger line's 「今日のつつかれた件」 reads 「今日の体（つつく）の件」). */
const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({ pet: 'なでる', poke: 'つつく', tickle: 'くすぐる', carry: '持ち上げる', holdHand: '手をにぎる' });

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
  /** The web search her Sonnet uses, as the app's Sonnet tier is handed it (the conversation model's). */
  webSearch?: WebSearchOperation;
}): ConfiguredFeeling | null {
  if (!feelingEventsEnabled(environment)) return null;
  const turn = feelingTurnEnabled(environment);
  const chooser = turn ? configuredJevChooser(environment, { trace: parts.trace, now: parts.now, ...(parts.salt ? { salt: parts.salt } : {}),
    ...(parts.jevFetch ? { jevFetch: parts.jevFetch } : {}) }) : null;
  const singleFace = singleFaceEnabled(environment);
  const jevInput = feelingTurnJevInput(environment);
  const seed = parts.conversation ? talkSeed(parts.conversation) : undefined;
  const sonnet = strongReplyModel(environment, parts);
  const strong = sonnet ? { strong: { cap: strongReplyDailyCap(environment), model: sonnet } } : {};
  return composedFeeling({ database: parts.databasePath, now: parts.now, timeZone: parts.timeZone, chooser, turn, singleFace, jevInput,
    ...(seed ? { seed } : {}), ...strong });
}

/**
 * Today's replies of hers in the owner's newest Talk, through the replay's own forgetting filter (what the owner alone may be shown), for
 * the repetition watch's first turns of the day.
 */
export function talkSeed(conversation: ConversationStore): RepetitionSeed {
  return (scopeKey, since, at, snapshot) => {
    const thread = conversation.listThreads(scopeKey)[0];
    if (!thread) return [];
    return visibleReplayMessages(snapshot, conversation, scopeKey, thread.threadId, OWNER_AUDIENCE, TALK_SEED_MESSAGES).messages
      .filter(entry => entry.item.role === 'assistant' && entry.message.observedAt >= since && entry.message.observedAt <= at)
      .map(entry => ({ text: entry.item.content, at: entry.message.observedAt,
        ...(entry.message.sourceExperienceId ? { sourceId: entry.message.sourceExperienceId } : {}) }));
  };
}
const TALK_SEED_MESSAGES = 24;

/**
 * `SHANNON_FEELING_TURN_JEV_INPUT` (`utterance` | `summary`; unset or anything else: `FEELING_TURN_JEV_INPUT`, `utterance` by the owner's
 * decision of 2026-10-14): whether Jev is handed the turn's words or only the closed facts.
 */
export function feelingTurnJevInput(environment: Readonly<Record<string, string | undefined>>): FeelingTurnJevInput {
  const value = environment.SHANNON_FEELING_TURN_JEV_INPUT?.trim().toLowerCase();
  return FEELING_TURN_JEV_INPUTS.find(input => input === value) ?? FEELING_TURN_JEV_INPUT;
}

/** The composition itself (tests and the replay hand their own parts: an in-memory table, a fake or real chooser). */
export function composedFeeling(parts: { database: string | DatabaseSync; now: () => string; timeZone: string; chooser: JevChooser | null; turn: boolean;
  singleFace: boolean; jevInput?: FeelingTurnJevInput; seed?: RepetitionSeed; strong?: { cap: number; model: AnthropicChatModel } }): ConfiguredFeeling {
  const store = new SQLiteFeelingEventStore(parts.database);
  const seed = parts.seed ? { seed: parts.seed } : {};
  const events = new FeelingEvents({ store, now: parts.now, timeZone: parts.timeZone, partWord: feelingPartWord, ...seed });
  const strong = parts.strong ? { strong: { cap: parts.strong.cap } } : {};
  const jevInput = parts.jevInput ?? FEELING_TURN_JEV_INPUT;
  const port = { events, chooser: parts.chooser, turn: parts.turn, singleFace: parts.singleFace, jevInput, ...strong };
  const sonnet = parts.strong?.model;
  const released = (scopeKey: string) => events.releaseStrong(scopeKey, parts.now());
  return { port, wrap: model => (sonnet ? new FeelingStrongChatModel(model, sonnet, { released }) : model), close: () => store.close() };
}
