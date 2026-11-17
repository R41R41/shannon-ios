import { COMPACTION_BODY_ITEM_CHARACTERS, COMPACTION_SECTIONS } from '@shannon/mind';
import type { FcaHistorySummarizer } from '../../../mind/action/fca/fcaHistoryPorts.js';
import { finishedSummary, summaryGoal } from '../anthropic/anthropicFcaSummary.js';
import type { AnthropicFcaUsage } from '../anthropic/anthropicFcaModel.js';
import { minecraftProfile } from '../anthropic/anthropicFcaMinecraftSystem.js';
import { openAiStructured } from './openAiStructured.js';
import type { OpenAiEffort } from './openAiModels.js';

/** The summary's answer as a JSON object: one list of short texts for each section of the compaction (ASCII keys, the section named in the description). */
const KEYS = COMPACTION_SECTIONS.map((section, index) => ({ section, key: `section_${index + 1}` }));
const SUMMARY_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: KEYS.map(item => item.key),
  properties: Object.fromEntries(KEYS.map(item => [item.key, { type: 'array', description: item.section, items: { type: 'string' } }])),
});

export interface OpenAiSummarizerOptions {
  model: string;
  apiKey: string;
  effort: OpenAiEffort;
  fetcher?: typeof fetch;
  endpoint?: string;
  timeoutMilliseconds?: number;
  maximumOutputTokens: number;
  recordUsage(usage: AnthropicFcaUsage): void | Promise<void>;
}

/**
 * The history summary of a Minecraft body task by an OpenAI model (the mode's facts-only summary, `anthropicFcaSummary.ts`): one structured
 * request whose answer is the eight sections, read by the same rule as the call of the Anthropic summarizer (`finishedSummary`: checked,
 * merged into the previous summary, the tool names the mode does not offer scrubbed). Nothing continues the request: no history, no
 * hidden retry.
 */
export function createOpenAiFcaSummarizer(options: OpenAiSummarizerOptions): FcaHistorySummarizer {
  const own = minecraftProfile({ minecraftOwnPrompt: true, minecraftSummaryFacts: true })!;
  const system = `${own.protocol}\n\n${own.summary}`;
  return { async summarize(input, signal) {
    const text = `${summaryGoal(true, true)}\n\nA complete factual JSON template was submitted; original transcript coverage is assigned by the caller.\n\n${JSON.stringify(input)}`;
    const raw = await openAiStructured({ model: options.model, apiKey: options.apiKey, effort: options.effort, maximumOutputTokens: options.maximumOutputTokens,
      label: 'history summary', recordUsage: options.recordUsage, ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.endpoint ? { endpoint: options.endpoint } : {}), ...(options.timeoutMilliseconds ? { timeoutMilliseconds: options.timeoutMilliseconds } : {}) },
    { system, input: text, schema: SUMMARY_SCHEMA, signal });
    const answer = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return finishedSummary(Object.fromEntries(KEYS.map(item => [item.section, answer[item.key]])), input, COMPACTION_BODY_ITEM_CHARACTERS, true);
  } };
}
