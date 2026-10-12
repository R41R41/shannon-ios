import { SHANNON_CAPABILITIES, withSkillsCapability } from '@shannon/cognition';
import { AnthropicChatModel } from '../../src/infra/models/anthropic/anthropicChatModel.js';
import type { ShannonChatModelRequest } from '../../src/infra/models/chatModel.js';
import { SKILL_INDEX_HEADER } from '../../src/mind/memory/skillDocument.js';
import { anthropicFixture, message } from './anthropicFixtures.js';
import { providerError } from './claudeRequestRecorder.js';
import {
  answer, cached, HAIKU, SONNET, text, toolCall, tools, webAnswer, type ClaudeScenario, type ScenarioContext, type Settings,
} from './claudeForegroundScenarios.js';

/**
 * Scenarios of the foreground cache plan (Syzygy ADR-0009 stage 1, M4; `SHANNON_CLAUDE_CACHE_PLAN` on): the request shapes of
 * text turns under the plan, and a Talk of three different turns whose requests share one prefix up to each turn's words.
 * The model is built with the plan on explicitly and a clock that stands still, so the receipts' first-token time is fixed.
 * Synthetic data only.
 */
const THREAD = 'synthetic-thread';
const ownStudy = SHANNON_CAPABILITIES.find(item => item.id === 'own_study')!;
/** An identity with the anchor her skills' capability line is inserted after. */
const identity = `合成された人格の層\n- ${ownStudy.text}\n- 合成された最後の能力\n`;
const skillIndex = `${SKILL_INDEX_HEADER} 1/20（目次。中身は skill_read で開く）]\n- 合成スキル: 合成された説明`;

export function planChat(context: ScenarioContext, settings: Settings): AnthropicChatModel {
  return new AnthropicChatModel({ apiKey: 'synthetic-chat-key', settings, fetch: context.fetcher, usageStore: context.store, now: context.now,
    retryWait: async () => {}, cachePlan: true, clock: () => 0 });
}

async function streamed(context: ScenarioContext, settings: Settings, request: ShannonChatModelRequest) {
  const parts: string[] = [];
  const result = await planChat(context, settings).generateStreaming(request, piece => { parts.push(piece); });
  return { result, parts };
}

const planText: ShannonChatModelRequest = { ...text, systemPrompt: identity, threadKey: THREAD };

const reply = (index: number) => `合成された返事${index}です。`;

function answerSaying(model: string, index: number, write: number, read: number) {
  const found = anthropicFixture('structured-answer');
  const said = { reply: reply(index), feeling: null, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: '合成' },
    taskProposal: null, intentPlan: null, artifacts: null, places: null, roomLook: null, appLook: null, minecraftIntent: null, webSearchNeedsInput: null };
  return cached({ ...found, content: [found.content[0]!, { type: 'text', text: JSON.stringify(said), citations: null }] }, model, write, read);
}

/** Turn n of the Talk: its history is every earlier turn's words and reply, as the conversation store replays them. */
function talkTurn(n: number, extra: Partial<ShannonChatModelRequest>): ShannonChatModelRequest {
  const words = ['こんにちは', '書斎を見て', '今日の天気は？'];
  const history = words.slice(0, n).flatMap((said, index) => [
    { role: 'user' as const, content: said }, { role: 'assistant' as const, content: reply(index + 1) },
  ]);
  return { ...planText, history, message: words[n]!, turnContext: `合成された${n + 1}ターン目の文脈`, ...extra };
}

/** Three turns of one Talk: no tools with her feeling; tools with a capability line and the skill index; a web search. */
async function talk(context: ScenarioContext) {
  const chat = planChat(context, HAIKU);
  const first = await chat.generateStreaming(talkTurn(0, { offerReplyFeeling: true }), () => {});
  const second = await chat.generateStreaming(talkTurn(1, { systemPrompt: withSkillsCapability(identity),
    profilePrompt: `合成された持ち主の層\n\n${skillIndex}`, tools: tools(['study.list', 'skill.read']) }), () => {});
  const third = await chat.generateStreaming(talkTurn(2, { useWebSearch: true }), () => {});
  return [first, second, third].map(turn => turn.reply);
}

const unofferedCall = () => cached(message([{ type: 'tool_use', id: 'toolu_unoffered', name: 'tool_open', input: { name: 'study_list' } }],
  'tool_use', { id: 'msg_unoffered' }), HAIKU.model, 0, 2_200);

export const PLAN_TALK_SCENARIO = 'plan-text-talk';

export const PLAN_SCENARIOS: readonly ClaudeScenario[] = [
  { name: 'plan-text-plain', script: [answer(HAIKU.model)], run: c => streamed(c, HAIKU, planText) },
  { name: 'plan-text-tools', script: [toolCall(HAIKU.model), answer(HAIKU.model, 0, 4_100)],
    run: c => streamed(c, HAIKU, { ...planText, tools: tools(['study.list', 'study.read']) }) },
  { name: 'plan-text-tools-withheld', script: [answer(HAIKU.model)], run: c => planChat(c, HAIKU).generate({ ...planText, toolsWithheld: true }) },
  { name: 'plan-text-offers', script: [answer(HAIKU.model)], run: c => planChat(c, HAIKU).generate({ ...planText, offerReplyFeeling: true,
    offerRoomLook: true, offerAppLook: true, offerMinecraftIntent: true, generateThreadTitle: true }) },
  { name: 'plan-text-place-search', script: [webAnswer(HAIKU.model), answer(HAIKU.model)],
    run: c => planChat(c, HAIKU).generate({ ...planText, message: '近くのカフェ', placeSearch: { latitude: 34.7, longitude: 137.7 } }) },
  { name: 'plan-text-unoffered-call', script: [unofferedCall(), answer(HAIKU.model, 0, 2_300)], run: c => streamed(c, HAIKU, planText) },
  { name: 'plan-sonnet-text-tools', script: [toolCall(SONNET.model), answer(SONNET.model, 0, 4_100)],
    run: c => streamed(c, SONNET, { ...planText, tier: 'sonnet', tools: tools(['study.list']) }) },
  { name: 'plan-text-rejected-fallback', script: [providerError(400, 'invalid_request_error', {}, 'The compiled grammar is too large'), answer(HAIKU.model)],
    run: c => streamed(c, HAIKU, planText) },
  { name: 'plan-text-tools-rejected', script: [providerError(400, 'invalid_request_error', {}, 'Too many strict tools'), answer(HAIKU.model)],
    run: c => streamed(c, HAIKU, { ...planText, tools: tools(['study.list']) }) },
  { name: PLAN_TALK_SCENARIO, script: [
    answerSaying(HAIKU.model, 1, 3_000, 0), toolCall(HAIKU.model), answerSaying(HAIKU.model, 2, 300, 3_100),
    webAnswer(HAIKU.model), answerSaying(HAIKU.model, 3, 200, 3_300),
  ], run: talk },
];
