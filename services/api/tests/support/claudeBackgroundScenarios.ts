import { VOICE_SKILLS } from '../../src/contracts/voiceDecisionContract.js';
import { createAnthropicFcaModel, type AnthropicFcaUsage } from '../../src/infra/models/anthropic/anthropicFcaModel.js';
import { AnthropicSkillSleepModel } from '../../src/infra/models/anthropic/anthropicSkillModel.js';
import { OpenAITurnChecker } from '../../src/infra/models/turnChecker.js';
import { OpenAIOrganizeExtractor } from '../../src/integrations/voyager/organizeIntegrations.js';
import { OpenAIDailyMindModel } from '../../src/mind/action/respond/dailyMind.js';
import { AnthropicAutonomyTextModel } from '../../src/mind/action/ownTime/anthropicAutonomyTextModel.js';
import type { FcaModelInput } from '../../src/mind/action/fca/fcaPorts.js';
import { OpenAIReplaySummaryWriter } from '../../src/mind/memory/conversationReplaySummary.js';
import { OpenAIImpressionAnalyzer } from '../../src/mind/memory/impressionUpdater.js';
import { OpenAIPersonFactJudge } from '../../src/mind/memory/personFacts.js';
import { OpenAIMemoryModelGateway } from '../../src/mind/recall/memoryModels.js';
import { OpenAIVoiceDecisionGateway } from '../../src/mind/selectors/voiceDecision.js';
import { OpenAIKnowledgeAnalyzer } from '../../src/mind/sleep/knowledgeConsolidation.js';
import { OpenAISleepMemoryAnalyzer } from '../../src/mind/sleep/sleepConsolidation.js';
import { OpenAISkillSleepModel } from '../../src/mind/sleep/skillSleepModel.js';
import { shannonTool } from '../../src/mind/tools/shannonTools.js';
import { TASK_TOOLS } from '../../src/mind/tools/toolRunnerPorts.js';
import { OpenAIRoomLookViewer } from '../../src/surfaces/body/bodyLookVision.js';
import { OpenAIBodyReactionSpeaker } from '../../src/surfaces/body/bodyReactionModel.js';
import { OpenAIPlatformSummaryWriter } from '../../src/surfaces/platform/platformPeopleSummaries.js';
import { OpenAIVoiceVisionGateway } from '../../src/surfaces/voice/voiceVision.js';
import { message, type AnthropicMessage } from './anthropicFixtures.js';
import { providerError } from './claudeRequestRecorder.js';
import { cached, SCENARIO_TIME, type ClaudeScenario, type ScenarioContext } from './claudeForegroundScenarios.js';

/**
 * Background scenarios of the request goldens (Syzygy ADR-0009 stage 1, M2): the FCA step, her own time's text model, the
 * Sonnet skill proposer, and every caller of the background bridge (`responseModelFetcher`, `haikuResponses.ts`). Synthetic
 * data only.
 */
const HAIKU = 'claude-haiku-5-5';
const jpeg = Buffer.from(new Uint8Array([0xff, 0xd8, 0xff, ...Array(61).fill(7)]));

function oneShot(text: string, model = HAIKU): AnthropicMessage {
  return cached(message([{ type: 'text', text, citations: null }], 'end_turn', { id: 'msg_background' }), model, 600, 0);
}

function fcaTurn(content: Array<Record<string, unknown>>): AnthropicMessage {
  return cached(message(content, 'tool_use', { id: 'msg_fca' }), HAIKU, 700, 0);
}

const fcaTools = ['task.create', 'task.list', 'task.get'].map(name => shannonTool(name) ?? TASK_TOOLS.find(tool => tool.name === name)!);
const fcaInput: FcaModelInput = {
  task: { id: 'task-synthetic', title: '合成された調べもの', goal: '公開情報を一つ確かめる', completionCriteria: '情報源を一つ読んだ' },
  children: [{ id: 'child-synthetic', title: '下調べ', phase: 'completed', summary: '合成された結果' }],
  messages: [{ id: 'message-synthetic', text: '合成された指示', sourceTaskId: 'parent-synthetic' }], tools: fcaTools, history: [],
};
const call = (name: string, id: string, input: unknown = {}) => ({ type: 'tool_use', name, id, input });

async function fcaDecide(context: ScenarioContext, input: FcaModelInput) {
  const receipts: AnthropicFcaUsage[] = [];
  const model = createAnthropicFcaModel({ apiKey: 'synthetic-fca-key', fetcher: context.fetcher, recordUsage: usage => { receipts.push(usage); } });
  try {
    return { output: await model.decide(input, new AbortController().signal), receipts };
  } catch (error) {
    // The usage the adapter reported before it failed is part of the parity contract.
    return { error: error instanceof Error ? error.message : String(error), receipts };
  }
}

const catalog = [...TASK_TOOLS, shannonTool('web.search')!];

const fcaScenarios: ClaudeScenario[] = [
  { name: 'fca-step-tools', script: [fcaTurn([call('task_list', 'call-list'), call('task_get', 'call-get', { taskId: 'child-synthetic' })])],
    run: c => fcaDecide(c, fcaInput) },
  { name: 'fca-step-complete', script: [fcaTurn([call('fca_complete', 'call-complete', { summary: '合成された完了' })])],
    run: c => fcaDecide(c, { ...fcaInput, skillIndex: '合成されたスキルの目次', history: [
      { role: 'user', content: '合成された前の入力' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'synthetic-signature' }, call('task_list', 'old-call')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: '合成された結果', is_error: false }] },
    ] }) },
  { name: 'fca-step-catalog', script: [fcaTurn([call('fca_wait', 'call-wait', { summary: '合成された待ち' })])],
    run: c => fcaDecide(c, { ...fcaInput, tools: catalog.filter(tool => tool.name === 'task.list'),
      catalog: catalog.map(({ name, description }) => ({ name, description })) }) },
  { name: 'fca-step-server-error', script: [providerError(500, 'api_error')], run: c => fcaDecide(c, fcaInput) },
];

function ownTime(context: ScenarioContext, model: string) {
  const text = new AnthropicAutonomyTextModel({ apiKey: 'synthetic-own-time-key', fetcher: context.fetcher });
  return text.generate({ model, system: '合成された自分の時間の指示', prompt: '合成された材料', maximumOutputTokens: 1_500 });
}

const ownTimeScenarios: ClaudeScenario[] = [
  { name: 'own-time-haiku', script: [oneShot('{"steps":[{"action":"rest"}]}')], run: c => ownTime(c, HAIKU) },
  { name: 'own-time-refused', script: [providerError(400, 'invalid_request_error')], run: c => ownTime(c, HAIKU) },
  { name: 'own-time-sonnet', script: [oneShot('{"steps":[{"action":"rest"}]}', 'claude-sonnet-5-5')], run: c => ownTime(c, 'claude-sonnet-5-5') },
];

const skillProposer: ClaudeScenario = {
  name: 'skill-proposer-sonnet', script: [oneShot('{"skills":[]}', 'claude-sonnet-5-5')],
  run: c => new AnthropicSkillSleepModel({ apiKey: 'synthetic-skill-key', model: 'claude-sonnet-5-5', fetch: c.fetcher, usageStore: c.store, now: c.now })
    .json('owner', 'skills', '合成されたスキル提案の指示', { notes: ['合成された記録'] },
      { type: 'object', additionalProperties: false, required: ['skills'], properties: { skills: { type: 'array', items: { type: 'string' } } } }),
};

type Options = { apiKey: string; model: string; fetcher: typeof fetch; usageStore: ScenarioContext['store'] };
const options = (context: ScenarioContext): Options => ({ apiKey: 'synthetic-background-key', model: HAIKU, fetcher: context.fetcher, usageStore: context.store });
const routerAnswer = { replyRequiredProbability: 0.99, solutionWantedProbability: 0.2, conversationClass: 'direct', latencyClass: 'under_3s',
  affect: 'bright', affectIntensity: 0.4, delivery: 'conversational', skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, 0.1])) };
const image = { mediaType: 'image/jpeg' as const, base64: jpeg.toString('base64'), width: 20, height: 20 };

function shim(name: string, answer: string, run: (options: Options) => Promise<unknown>): ClaudeScenario {
  return { name: `background-${name}`, script: [oneShot(answer)], run: context => run(options(context)) };
}

const memoryGateway = (o: Options) => new OpenAIMemoryModelGateway({ apiKey: 'synthetic-embedding-key', reasoningApiKey: o.apiKey, fetcher: o.fetcher,
  usageStore: o.usageStore });

const shimScenarios: ClaudeScenario[] = [
  shim('replay-summary', '合成された要約。', o => new OpenAIReplaySummaryWriter(o).update('owner', { previousSummary: null, lines: ['ライ氏: 合成された一行'] })),
  shim('replay-template', '{}', o => new OpenAIReplaySummaryWriter(o).updateTemplate('owner', { previous: null, messages: [] })),
  shim('impressions', '{"observations":[],"candidates":[]}', o => new OpenAIImpressionAnalyzer(o).analyze('owner',
    { person: '合成さん', localDate: '2026-10-12', lines: ['合成された発言'], impressions: [], maximumNew: 2 })),
  shim('person-facts', '{"judgements":[]}', o => new OpenAIPersonFactJudge(o).judge('owner', { newFacts: [{ key: 'n1', text: '合成された事実' }], facts: [] })),
  shim('platform-summary', '合成された集まりの要約。', o => new OpenAIPlatformSummaryWriter(o).summarize('owner',
    { place: '合成の集まり', names: ['合成さん'], lines: ['合成された発言'] })),
  shim('sleep', '{"facts":[],"relationships":[],"interests":[],"selfInterests":[]}', o => new OpenAISleepMemoryAnalyzer(o).analyze(
    [{ content: '合成された記憶', observedAt: SCENARIO_TIME }], { scopeKey: 'owner', occurredAt: SCENARIO_TIME, stage5: true, selfInterests: [] })),
  shim('daily-mind', '{"topic":"合成","reason":"合成された理由","openingLine":"合成された一言。"}', o => new OpenAIDailyMindModel(o).generate(
    { scopeKey: 'owner', recentInterests: ['合成された興味'], candidate: null })),
  shim('organize', '{"tasks":[]}', o => new OpenAIOrganizeExtractor(o).extract('owner',
    [{ role: 'user', content: '合成された依頼' }, { role: 'assistant', content: '合成された返事' }])),
  shim('room-look', '合成された部屋の様子。', o => new OpenAIRoomLookViewer(o).see({ scopeKey: 'owner', image, context: [] })),
  shim('touch', '{"say":true,"text":"合成された反応。","feeling":"giggle"}', o => new OpenAIBodyReactionSpeaker(o).decide(
    { scopeKey: 'owner', prompt: '合成された触れられた事実。', signal: new AbortController().signal })),
  { name: 'background-touch-server-error', script: [providerError(500, 'api_error')], run: c => new OpenAIBodyReactionSpeaker(options(c)).decide(
    { scopeKey: 'owner', prompt: '合成された触れられた事実。', signal: new AbortController().signal }) },
  shim('voice-photo', '合成された写真の説明。', o => new OpenAIVoiceVisionGateway(o).analyze(
    { scopeKey: 'owner', image: new Uint8Array(jpeg), mimeType: 'image/jpeg', conversationContext: '合成された会話。' })),
  shim('voice-router', JSON.stringify(routerAnswer), o => new OpenAIVoiceDecisionGateway(o).decide(
    { scopeKey: 'owner', transcript: '合成された発話', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false })),
  shim('turn-checker', '{"verdict":"claims_unsupported"}', o => new OpenAITurnChecker(o).check('owner', '合成された保存の報告。',
    [{ name: 'write', effect: 'write', ok: false }])),
  shim('knowledge', '{"operations":[]}', o => new OpenAIKnowledgeAnalyzer(o).analyze('owner', {
    experiences: [{ id: 'experience-synthetic', observedAt: SCENARIO_TIME, summary: '合成された経験' }], knowledge: [] })),
  shim('skill-sleep', '{"skills":[]}', o => new OpenAISkillSleepModel(o).json('owner', 'skills', '合成された指示', { notes: ['合成'] },
    { type: 'object', additionalProperties: false, required: ['skills'], properties: { skills: { type: 'array', items: { type: 'string' } } } })),
  shim('memory-rewrite', '{"queries":["合成された問い"]}', o => memoryGateway(o).rewriteQuery('owner', '合成された質問')),
  shim('memory-rerank', '{"scores":[{"key":"c1","relevance":0.9}]}', o => memoryGateway(o).rerank('owner', '合成',
    [{ id: 'memory-synthetic', text: '合成された記憶' }])),
  shim('memory-sections', '{"nodeIds":["node-synthetic"]}', o => memoryGateway(o).selectSections('owner', '合成',
    [{ id: 'node-synthetic', path: '合成の見出し', preview: '合成された抜粋' }])),
];

export const BACKGROUND_SCENARIOS: readonly ClaudeScenario[] = [...fcaScenarios, ...ownTimeScenarios, skillProposer, ...shimScenarios];
