import { AnthropicChatModel } from '../../src/infra/models/anthropic/anthropicChatModel.js';
import type { ShannonChatModelRequest, ShannonVoiceModelRequest } from '../../src/infra/models/chatModel.js';
import type { ShannonModelToolSession } from '../../src/infra/models/chatModelTools.js';
import type { LlmUsageStore } from '../../src/infra/models/llmUsage.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../../src/mind/action/respond/turnDeadline.js';
import { shannonTool } from '../../src/mind/tools/shannonTools.js';
import { anthropicFixture, message, type AnthropicMessage } from './anthropicFixtures.js';
import { providerError, type ScriptedReply } from './claudeRequestRecorder.js';

/**
 * Foreground scenarios of the request goldens (Syzygy ADR-0009 stage 1, M2): the conversation model's text and voice turns,
 * Sonnet mode, the native web search and the one transient retry. Synthetic data only.
 */
export interface ScenarioContext {
  fetcher: typeof fetch;
  store: LlmUsageStore;
  now: () => string;
}

export interface ClaudeScenario {
  name: string;
  script: readonly ScriptedReply[];
  run(context: ScenarioContext): Promise<unknown>;
}

export const SCENARIO_TIME = '2026-10-12T03:00:00.000Z';
const HAIKU = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } as const;
const SONNET = { model: 'claude-sonnet-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'between_tools' } as const;

type Settings = typeof HAIKU | typeof SONNET;

/** A recorded response with complete one-hour cache usage (the shape a Haiku or Sonnet 5.5 request requires). */
export function cached(value: AnthropicMessage, model: string, write = 1_800, read = 0): AnthropicMessage {
  const usage = { ...value.usage, cache_creation_input_tokens: write, cache_read_input_tokens: read,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } };
  return { ...value, id: `msg_${model}_${write}_${read}`, model, usage };
}

const answer = (model: string, write?: number, read?: number) => cached(anthropicFixture('structured-answer'), model, write, read);
const toolCall = (model: string) => cached(anthropicFixture('tool-call'), model, 4_100, 0);
const spoken = (model: string, text = 'こんにちは、ライ氏。今日も来てくれてうれしいです。') =>
  cached(message([{ type: 'text', text }], 'end_turn', { id: 'msg_spoken' }), model, 0, 2_400);

/** A structured answer that asks for the missing place instead of claiming a search. */
function needsInput(model: string): AnthropicMessage {
  const reply = { reply: 'どの地域の天気ですか？', feeling: null, threadSummary: null, threadTitle: null,
    taskDecision: { disposition: 'none', reason: '地域が不明' }, taskProposal: null, intentPlan: null, artifacts: null, webSearchNeedsInput: true };
  return cached(message([{ type: 'text', text: JSON.stringify(reply), citations: null }], 'end_turn', { id: 'msg_needs_input' }), model, 0, 4_100);
}

function webAnswer(model: string): AnthropicMessage {
  return cached(anthropicFixture('web-search-answer'), model, 300, 3_000);
}

function webSpoken(model: string): AnthropicMessage {
  const found = anthropicFixture('web-search-answer');
  const blocks = found.content.filter(block => block.type !== 'text');
  return cached({ ...found, content: [...blocks, { type: 'text', text: '今日は晴れです。', citations: null }] }, model, 300, 3_000);
}

function chat(context: ScenarioContext, settings: Settings): AnthropicChatModel {
  return new AnthropicChatModel({ apiKey: 'synthetic-chat-key', settings, fetch: context.fetcher, usageStore: context.store, now: context.now,
    retryWait: async () => {} });
}

function tools(names: readonly string[]): ShannonModelToolSession {
  return {
    definitions: names.map(name => shannonTool(name)!), maximumCalls: 4, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name: string) { return JSON.stringify({ ok: true, text: `合成結果: ${name}` }); },
  };
}

const text: ShannonChatModelRequest = {
  scopeKey: 'owner', systemPrompt: '合成された人格の層', profilePrompt: '合成された持ち主の層', history: [], message: 'こんにちは',
  turnContext: '合成された今のターンの文脈',
};
const voice: ShannonVoiceModelRequest = {
  scopeKey: 'owner', systemPrompt: '合成された人格の層', profilePrompt: '合成された持ち主の層', history: [], message: 'おはよう',
  turnContext: '合成された声のターンの文脈', useWebSearch: false, conversationClass: 'direct',
};
const history = [
  { role: 'user' as const, content: '昨日の話の続きをしたい' },
  { role: 'assistant' as const, content: 'はい、覚えています。' },
];

async function streamedText(context: ScenarioContext, settings: Settings, request: ShannonChatModelRequest) {
  const parts: string[] = [];
  const result = await chat(context, settings).generateStreaming(request, piece => { parts.push(piece); });
  return { result, parts };
}

async function streamedVoice(context: ScenarioContext, settings: Settings, request: ShannonVoiceModelRequest) {
  const parts: string[] = [];
  const result = await chat(context, settings).generateVoiceStreaming(request, piece => { parts.push(piece); });
  return { result, parts };
}

const textScenarios: ClaudeScenario[] = [
  { name: 'text-plain', script: [answer(HAIKU.model)], run: c => chat(c, HAIKU).generate(text) },
  { name: 'text-plain-streamed', script: [answer(HAIKU.model, 0, 1_800)], run: c => streamedText(c, HAIKU, text) },
  { name: 'text-history-attachment', script: [answer(HAIKU.model)], run: c => chat(c, HAIKU).generate({ ...text, history,
    attachments: [{ name: 'memo.txt', mimeType: 'text/plain', text: '合成された添付の本文' }], priorThreadSummary: '合成された前の要約',
    generateThreadTitle: true }) },
  { name: 'text-tools', script: [toolCall(HAIKU.model), answer(HAIKU.model, 0, 4_100)],
    run: c => chat(c, HAIKU).generate({ ...text, tools: tools(['study.list', 'study.read']) }) },
  { name: 'text-tools-streamed', script: [toolCall(HAIKU.model), answer(HAIKU.model, 0, 4_100)],
    run: c => streamedText(c, HAIKU, { ...text, tools: tools(['study.list']) }) },
  { name: 'text-tools-withheld', script: [answer(HAIKU.model)], run: c => chat(c, HAIKU).generate({ ...text, toolsWithheld: true }) },
  { name: 'text-web-search', script: [webAnswer(HAIKU.model), answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, message: '今日の天気は？', useWebSearch: true }) },
  { name: 'text-place-search', script: [webAnswer(HAIKU.model), answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, message: '近くのカフェ', placeSearch: { latitude: 34.7, longitude: 137.7 } }) },
  { name: 'text-required-web-search', script: [toolCall(HAIKU.model), answer(HAIKU.model, 0, 4_100), needsInput(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, message: '調べて', useWebSearch: true, tools: tools(['web.search', 'study.list']) }) },
  { name: 'text-looks', script: [answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, offerRoomLook: true, offerAppLook: true, offerReplyFeeling: true }) },
  { name: 'text-minecraft-intent', script: [answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, message: '木を集めて', offerMinecraftIntent: true }) },
  { name: 'text-preceding-reply', script: [answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, precedingReply: 'くすぐったいです。' }) },
  { name: 'text-plus-tier', script: [answer(HAIKU.model)], run: c => chat(c, HAIKU).generate({ ...text, tier: 'luna_plus', escalation: true }) },
];

const voiceScenarios: ClaudeScenario[] = [
  { name: 'voice-plain', script: [spoken(HAIKU.model)], run: c => chat(c, HAIKU).generateVoice(voice) },
  { name: 'voice-plain-streamed', script: [spoken(HAIKU.model)], run: c => streamedVoice(c, HAIKU, voice) },
  { name: 'voice-greeting-history', script: [spoken(HAIKU.model)],
    run: c => streamedVoice(c, HAIKU, { ...voice, conversationClass: 'greeting', history, precedingReply: 'わっ。' }) },
  { name: 'voice-tools', script: [toolCall(HAIKU.model), spoken(HAIKU.model)],
    run: c => streamedVoice(c, HAIKU, { ...voice, conversationClass: 'skill_simple', tools: tools(['study.list']) }) },
  { name: 'voice-tools-withheld', script: [spoken(HAIKU.model)], run: c => streamedVoice(c, HAIKU, { ...voice, toolsWithheld: true }) },
  { name: 'voice-web-search', script: [webSpoken(HAIKU.model)],
    run: c => streamedVoice(c, HAIKU, { ...voice, message: '今日の天気は？', useWebSearch: true }) },
  { name: 'voice-web-search-complex', script: [webSpoken(HAIKU.model)],
    run: c => chat(c, HAIKU).generateVoice({ ...voice, message: '天気を詳しく', useWebSearch: true, conversationClass: 'skill_complex' }) },
];

const sonnetScenarios: ClaudeScenario[] = [
  { name: 'sonnet-text', script: [answer(SONNET.model)], run: c => chat(c, SONNET).generate({ ...text, tier: 'sonnet' }) },
  { name: 'sonnet-text-streamed-tools', script: [toolCall(SONNET.model), answer(SONNET.model, 0, 4_100)],
    run: c => streamedText(c, SONNET, { ...text, tier: 'sonnet', tools: tools(['study.list']) }) },
  { name: 'sonnet-voice', script: [spoken(SONNET.model)], run: c => streamedVoice(c, SONNET, { ...voice, tier: 'sonnet' }) },
];

function pausedSearch(model: string): AnthropicMessage {
  const found = anthropicFixture('web-search-answer');
  return cached({ ...found, content: found.content.slice(0, 2), stop_reason: 'pause_turn' }, model, 300, 3_000);
}

function resumedSearch(model: string): AnthropicMessage {
  const usage = { ...message([], 'end_turn').usage, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } };
  const content = [{ type: 'text', text: '浜松は今日は晴れです。', citations: null }];
  return cached(message(content, 'end_turn', { id: 'msg_resumed', usage }), model, 0, 3_300);
}

const transportScenarios: ClaudeScenario[] = [
  { name: 'web-search-paused', script: [pausedSearch(HAIKU.model), resumedSearch(HAIKU.model)],
    run: c => chat(c, HAIKU).searchWeb({ scopeKey: 'owner', query: '浜松の天気', maxUses: 2 }) },
  { name: 'text-transient-retry', script: [providerError(529, 'overloaded_error', { 'retry-after': '0' }), answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate(text) },
  { name: 'text-cache-unconfirmed', script: [answer(HAIKU.model, 0, 0)], run: c => streamedText(c, HAIKU, text) },
  { name: 'text-rejected-plain-recovery', script: [providerError(400, 'invalid_request_error'), answer(HAIKU.model)],
    run: c => chat(c, HAIKU).generate({ ...text, tools: tools(['study.list']) }) },
];

export const FOREGROUND_SCENARIOS: readonly ClaudeScenario[] = [...textScenarios, ...voiceScenarios, ...sonnetScenarios, ...transportScenarios];
