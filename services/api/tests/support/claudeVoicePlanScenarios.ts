import { SHANNON_CAPABILITIES, withSkillsCapability } from '@shannon/cognition';
import { AnthropicChatModel } from '../../src/infra/models/anthropic/anthropicChatModel.js';
import type { ShannonVoiceModelRequest } from '../../src/infra/models/chatModel.js';
import { SKILL_INDEX_HEADER } from '../../src/mind/memory/skillDocument.js';
import { message } from './anthropicFixtures.js';
import { providerError } from './claudeRequestRecorder.js';
import {
  answer, cached, HAIKU, HAIKU_PRODUCTION, SONNET, spoken, text, toolCall, tools, voice, webSpoken, type ClaudeScenario, type ScenarioContext, type Settings,
} from './claudeForegroundScenarios.js';
import { planChat } from './claudePlanScenarios.js';
import { voiceSummaryItem } from '../../src/mind/recall/voiceHistory.js';

/**
 * Scenarios of the voice cache plan (Syzygy ADR-0009 stage 1, M6; `SHANNON_CLAUDE_CACHE_PLAN_VOICE` on): the spoken request
 * shapes under the plan, the web search it leaves in its own shape, and a Talk of three voice turns whose requests share one
 * prefix up to each turn's words. Also the text plan with rich chat's lines. Synthetic data only.
 */
const THREAD = 'synthetic-voice-thread';
const ownStudy = SHANNON_CAPABILITIES.find(item => item.id === 'own_study')!;
const identity = `合成された人格の層\n- ${ownStudy.text}\n- 合成された最後の能力\n`;
const skillIndex = `${SKILL_INDEX_HEADER} 1/20（目次。中身は skill_read で開く）]\n- 合成スキル: 合成された説明`;

function voicePlanChat(context: ScenarioContext, settings: Settings): AnthropicChatModel {
  return new AnthropicChatModel({ apiKey: 'synthetic-chat-key', settings, fetch: context.fetcher, usageStore: context.store, now: context.now,
    retryWait: async () => {}, voiceCachePlan: true, clock: () => 0 });
}

async function said(context: ScenarioContext, settings: Settings, request: ShannonVoiceModelRequest) {
  const parts: string[] = [];
  const result = await voicePlanChat(context, settings).generateVoiceStreaming(request, piece => { parts.push(piece); });
  return { result, parts };
}

const planVoice: ShannonVoiceModelRequest = { ...voice, systemPrompt: identity, threadKey: THREAD };
const reply = (index: number) => `合成された声の返事${index}です。`;

/** Turn n of the voice Talk: its history is every earlier turn's words and reply, as the conversation store replays them. */
function talkTurn(n: number, extra: Partial<ShannonVoiceModelRequest>): ShannonVoiceModelRequest {
  const words = ['おはよう', '書斎を見て', 'ありがとう'];
  const history = words.slice(0, n).flatMap((heard, index) => [
    { role: 'user' as const, content: heard }, { role: 'assistant' as const, content: reply(index + 1) },
  ]);
  return { ...planVoice, history, message: words[n]!, turnContext: `合成された声の${n + 1}ターン目の文脈`, ...extra };
}

/** Three voice turns: plain; tools with a capability line, what she knows of the owner and the skill index; a touch reaction. */
async function talk(context: ScenarioContext) {
  const chat = voicePlanChat(context, HAIKU);
  const replies: string[] = [];
  const turns = [
    talkTurn(0, {}),
    talkTurn(1, { systemPrompt: withSkillsCapability(identity), profilePrompt: `合成された持ち主の層\n\n${skillIndex}`,
      tools: tools(['study.list', 'skill.read']), conversationClass: 'skill_simple' }),
    talkTurn(2, { precedingReply: 'くすぐったいです。' }),
  ];
  for (const turn of turns) replies.push((await chat.generateVoiceStreaming(turn, () => {})).reply);
  return replies;
}

/**
 * Three voice turns of one epoch under the voice history's summary (owner decision 2026-10-14, `voiceHistory.ts`): each history
 * begins with the epoch's frozen summary as a marked user turn, followed by the exchanges, so every request repeats the one before
 * it up to its words, summary included. The model layer is unchanged: the summary arrives as the first history item.
 */
async function summaryTalk(context: ScenarioContext) {
  const chat = voicePlanChat(context, HAIKU);
  const summary = voiceSummaryItem('話題: 合成された前の話題\n気持ち: 落ち着いていた', '');
  const exchanges = [['おはよう', reply(11)], ['書斎を見て', reply(12)]] as const;
  const replies: string[] = [];
  for (let n = 0; n < 3; n++) {
    const history = [summary, ...exchanges.slice(0, n).flatMap(([heard, said]) => [
      { role: 'user' as const, content: heard }, { role: 'assistant' as const, content: said },
    ])];
    const turn = { ...planVoice, history, message: ['おはよう', '書斎を見て', 'ありがとう'][n]!, turnContext: `合成された声の${n + 1}ターン目の文脈` };
    replies.push((await chat.generateVoiceStreaming(turn, () => {})).reply);
  }
  return replies;
}

const unofferedCall = () => cached(message([{ type: 'tool_use', id: 'toolu_unoffered', name: 'tool_open', input: { name: 'study_list' } }],
  'tool_use', { id: 'msg_voice_unoffered' }), HAIKU.model, 0, 2_200);

export const VOICE_PLAN_TALK_SCENARIO = 'plan-voice-talk';

export const VOICE_PLAN_SCENARIOS: readonly ClaudeScenario[] = [
  { name: 'plan-voice-plain', script: [spoken(HAIKU.model)], run: c => said(c, HAIKU, planVoice) },
  { name: 'plan-voice-not-streamed', script: [spoken(HAIKU.model)], run: c => voicePlanChat(c, HAIKU).generateVoice(planVoice) },
  { name: 'plan-voice-tools', script: [toolCall(HAIKU.model), spoken(HAIKU.model)],
    run: c => said(c, HAIKU, { ...planVoice, conversationClass: 'skill_simple', tools: tools(['study.list']) }) },
  { name: 'plan-voice-tools-withheld', script: [spoken(HAIKU.model)], run: c => said(c, HAIKU, { ...planVoice, toolsWithheld: true }) },
  { name: 'plan-voice-web-search', script: [webSpoken(HAIKU.model)],
    run: c => said(c, HAIKU, { ...planVoice, message: '今日の天気は？', useWebSearch: true }) },
  { name: 'plan-voice-unoffered-call', script: [unofferedCall(), spoken(HAIKU.model)], run: c => said(c, HAIKU, planVoice) },
  { name: 'plan-voice-rejected-fallback', script: [providerError(400, 'invalid_request_error', {}, 'The compiled grammar is too large'),
    spoken(HAIKU.model)], run: c => said(c, HAIKU, planVoice) },
  { name: 'plan-sonnet-voice', script: [spoken(SONNET.model)], run: c => said(c, SONNET, { ...planVoice, tier: 'sonnet' }) },
  // The production voice body (2026-10-13): no thinking, non-strict tools, the plan's waiting phrase already heard.
  { name: 'plan-voice-production', script: [toolCall(HAIKU_PRODUCTION.model), spoken(HAIKU_PRODUCTION.model)],
    run: c => said(c, HAIKU_PRODUCTION, { ...planVoice, conversationClass: 'skill_simple', tools: tools(['study.list']), waitingSaid: true }) },
  { name: VOICE_PLAN_TALK_SCENARIO, script: [
    spoken(HAIKU.model, reply(1)), toolCall(HAIKU.model), spoken(HAIKU.model, reply(2)), spoken(HAIKU.model, reply(3)),
  ], run: talk },
  { name: 'plan-voice-summary-talk', script: [spoken(HAIKU.model, reply(11)), spoken(HAIKU.model, reply(12)), spoken(HAIKU.model, reply(13))],
    run: summaryTalk },
  // Rich chat's lines under the text plan: in the system, where the plan-off request has them (they depend on the surface).
  { name: 'plan-text-rich-blocks', script: [answer(HAIKU.model)],
    run: c => planChat(c, HAIKU).generate({ ...text, richBlocks: true }) },
];
