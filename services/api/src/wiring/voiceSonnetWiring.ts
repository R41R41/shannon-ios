import { switchOn } from '@shannon/switches';
import { AnthropicChatModel } from '../infra/models/anthropic/anthropicChatModel.js';
import { anthropicApiKey, sonnetSettings } from '../infra/models/anthropic/anthropicConfig.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { VoiceReplyChatModel, VoiceSonnetDay } from '../infra/models/voiceReplyChatModel.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The day's cap of Sonnet voice replies (`SHANNON_VOICE_SONNET_DAILY_CAP`, a whole number from 0 to 10 000; default 800). A guard on
 * the day's cost, not a budget: about 800 spoken replies is a long day of calls (at about 1 yen a reply, some 800 yen at most).
 */
export const VOICE_SONNET_DAILY_CAP = 800;

export function voiceSonnetDailyCap(environment: Environment): number {
  const value = Number(environment.SHANNON_VOICE_SONNET_DAILY_CAP?.trim() || Number.NaN);
  return Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : VOICE_SONNET_DAILY_CAP;
}

/** The server's own day, in its time zone (`YYYY-MM-DD`). */
export function localDay(timeZone: string, now: () => string): () => string {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return () => format.format(new Date(now()));
}

/**
 * Owner 2026-10-21 (「声は全部 Sonnet」; `SHANNON_VOICE_SONNET`): the kernel's chat model with every spoken reply on Sonnet 5.5
 * (`VoiceReplyChatModel`), its prefix cached by the voice cache plan whatever `SHANNON_CLAUDE_CACHE_PLAN_VOICE` says. Off, or without
 * the Anthropic key: the model as it was.
 */
export function withVoiceSonnet(environment: Environment, model: ShannonChatModel, parts: {
  timeZone: string; now: () => string; usageStore?: LlmUsageStore;
  /** The web search her Sonnet uses, as the app's other Sonnet models are handed it (the conversation model's). */
  haiku?: Pick<ShannonChatModel, 'searchWeb'>;
}): ShannonChatModel {
  const apiKey = anthropicApiKey(environment);
  if (!switchOn(environment, 'SHANNON_VOICE_SONNET') || !apiKey) return model;
  const sonnet = new AnthropicChatModel({ apiKey, settings: sonnetSettings(environment), now: parts.now, voiceCachePlan: true,
    agentHostHint: environment.SHANNON_AGENT_DEFAULT_HOST?.trim() || 'shannon-mac', ...(parts.usageStore ? { usageStore: parts.usageStore } : {}),
    ...(parts.haiku?.searchWeb ? { webSearch: parts.haiku.searchWeb.bind(parts.haiku) } : {}) });
  const day = new VoiceSonnetDay(voiceSonnetDailyCap(environment), localDay(parts.timeZone, parts.now));
  return new VoiceReplyChatModel(model, { sonnet, day });
}
