import { switchOn } from '@shannon/switches';
import { AnthropicChatModel } from '../infra/models/anthropic/anthropicChatModel.js';
import { anthropicApiKey, sonnetSettings } from '../infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { ReplySonnetChatModel } from '../infra/models/replySonnetChatModel.js';
import { configuredDatabasePath } from '../infra/sqlite/sqliteStore.js';
import { SQLiteReplySonnetDays } from '../mind/emotion/store/replySonnetDayStore.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The day's cap of her Sonnet replies, voice and text together (`SHANNON_REPLY_SONNET_DAILY_CAP`, a whole number from 0 to 10 000;
 * default 800). A guard on the day's cost, not a budget: at about 1 yen a reply, some 800 yen a day at most.
 */
export const REPLY_SONNET_DAILY_CAP = 800;

export function replySonnetDailyCap(environment: Environment): number {
  const value = Number(environment.SHANNON_REPLY_SONNET_DAILY_CAP?.trim() || Number.NaN);
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : REPLY_SONNET_DAILY_CAP;
}

/** Whether her replies are Sonnet's: the switch and the Anthropic key (the feeling turn's own Sonnet then stands aside). */
export function repliesOnSonnet(environment: Environment): boolean {
  return switchOn(environment, 'SHANNON_REPLY_SONNET') && anthropicApiKey(environment) !== null;
}

/** The server's own day, in its time zone (`YYYY-MM-DD`). */
export function localDay(timeZone: string, now: () => string): () => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return () => format.format(new Date(now()));
}

const opened = new Set<SQLiteReplySonnetDays>();

/** Closes the day's count (the server's shutdown). */
export function closeReplySonnet(): void {
  for (const days of opened) days.close();
  opened.clear();
}

/**
 * Owner 2026-10-21 (「声は全部 Sonnet」, 「文字も全部 Sonnet」; `SHANNON_REPLY_SONNET`): the kernel's chat model with every reply of hers on
 * Sonnet 5.5 (`ReplySonnetChatModel`), its prefix cached by the cache plans whatever their canary switches say, and the day's count kept
 * in the database (`emotion/008_reply_sonnet_days`). Off, or without the Anthropic key: the model as it was, and nothing is opened.
 */
export function withReplySonnet(environment: Environment, model: ShannonChatModel, parts: {
  timeZone: string; now: () => string; usageStore?: LlmUsageStore;
  /** The database (default: the server's); tests hand their own. */
  database?: string;
  /** The web search her Sonnet uses, as the app's other Sonnet models are handed it (the conversation model's). */
  haiku?: Pick<ShannonChatModel, 'searchWeb'>;
}): ShannonChatModel {
  const apiKey = anthropicApiKey(environment);
  if (!repliesOnSonnet(environment) || !apiKey) return model;
  const sonnet = new AnthropicChatModel({ apiKey, settings: sonnetSettings(environment), now: parts.now, cachePlan: true, voiceCachePlan: true,
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac', ...(parts.usageStore ? { usageStore: parts.usageStore } : {}),
    ...(parts.haiku?.searchWeb ? { webSearch: parts.haiku.searchWeb.bind(parts.haiku) } : {}) });
  const day = new SQLiteReplySonnetDays(parts.database ?? configuredDatabasePath(), replySonnetDailyCap(environment), localDay(parts.timeZone, parts.now),
    parts.now);
  opened.add(day);
  return new ReplySonnetChatModel(model, { sonnet, day });
}
