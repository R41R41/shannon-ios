import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import type { LlmUsageEvent, LlmUsageStore } from '../src/infra/models/llmUsage.js';
import { OpenAITurnChecker } from '../src/infra/models/turnChecker.js';
import { OpenAIReplaySummaryWriter, createConfiguredReplaySummaryWriter } from '../src/mind/memory/conversationReplaySummary.js';
import { OpenAIImpressionAnalyzer, createConfiguredImpressionAnalyzer } from '../src/mind/memory/impressionUpdater.js';
import { OpenAIPersonFactJudge, createConfiguredPersonFactJudge } from '../src/mind/memory/personFacts.js';
import { OpenAIPlatformSummaryWriter, createConfiguredPlatformSummaryWriter } from '../src/surfaces/platform/platformPeopleSummaries.js';
import { OpenAISleepMemoryAnalyzer, createConfiguredSleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { OpenAIDailyMindModel, createConfiguredDailyMindModel } from '../src/mind/action/respond/dailyMind.js';
import { OpenAIOrganizeExtractor, createConfiguredOrganizeExtractor } from '../src/integrations/voyager/organizeIntegrations.js';
import { OpenAIRoomLookViewer, createConfiguredRoomLookViewer } from '../src/surfaces/body/bodyLookVision.js';
import { OpenAIBodyReactionSpeaker, createConfiguredBodyReactionSpeaker } from '../src/surfaces/body/bodyReactionModel.js';
import { OpenAIVoiceVisionGateway, createConfiguredVoiceVisionGateway } from '../src/surfaces/voice/voiceVision.js';
import { OpenAIVoiceDecisionGateway, createConfiguredVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { VOICE_SKILLS } from '../src/contracts/voiceDecisionContract.js';
import { configuredMemoryModelGateway } from '../src/mind/recall/turnMemoryRecall.js';
import { OpenAIMemoryModelGateway } from '../src/mind/recall/memoryModels.js';
import { TracedVoiceDecisionGateway } from '../src/mind/inhibition/tracedVoiceDecision.js';
import { checkedTrace, type DecisionTraceDraft } from '../src/contracts/decisionTraceContract.js';
import { configuredTurnRouting } from '../src/wiring/turnRoutingWiring.js';

afterEach(() => vi.unstubAllGlobals());
const AT = '2026-10-08T03:00:00.000Z';
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, ...Array(125).fill(7)]);
const input = { scopeKey: 'owner', transcript: 'こんにちは', participantMode: 'owner' as const, requestedLocation: false, hasFreshLocation: false };
const routerAnswer = { replyRequiredProbability: 0.99, solutionWantedProbability: 0.2, conversationClass: 'direct', latencyClass: 'under_3s',
  affect: 'bright', affectIntensity: 0.4, delivery: 'conversational', skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, 0.1])) };
const coldUsage = { input_tokens: 40, output_tokens: 20, cache_creation_input_tokens: 600, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 600 } };
function message(text: string, usage = coldUsage, stop = 'end_turn') {
  return new Response(JSON.stringify({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL,
    content: [{ type: 'text', text }], stop_reason: stop, stop_sequence: null, usage }), { headers: { 'content-type': 'application/json' } });
}
function ledger() {
  const rows: LlmUsageEvent[] = [];
  const store: LlmUsageStore = { recordLlmUsage: row => rows.push(row), backgroundLlmCostUsd: () => 0 };
  return { rows, store };
}
type Options = { apiKey: string; model?: string; fetcher: typeof fetch; usageStore: LlmUsageStore };
type Example = { name: string; answer: string; lane: string; call: (options: Options) => Promise<unknown> };
const examples: Example[] = [
  { name: 'replay text', answer: '会話の要約。', lane: 'memory_background', call: o => new OpenAIReplaySummaryWriter(o).update('owner', { previousSummary: null, lines: ['ライ氏: 話を続けたい'] }) },
  { name: 'replay template', answer: '{}', lane: 'memory_background', call: o => new OpenAIReplaySummaryWriter(o).updateTemplate('owner', { previous: null, messages: [] }) },
  { name: 'impressions', answer: '{"observations":[],"candidates":[]}', lane: 'memory_background', call: o => new OpenAIImpressionAnalyzer(o).analyze('owner', { person: 'ミキさん', localDate: '2026-10-08', lines: ['こんにちは'], impressions: [], maximumNew: 2 }) },
  { name: 'person facts', answer: '{"judgements":[]}', lane: 'memory_background', call: o => new OpenAIPersonFactJudge(o).judge('owner', { newFacts: [{ key: 'n1', text: '猫が好き' }], facts: [] }) },
  { name: 'platform summary', answer: '猫の話をした。', lane: 'memory_background', call: o => new OpenAIPlatformSummaryWriter(o).summarize('owner', { place: 'グループ', names: ['ミキ'], lines: ['猫が好き'] }) },
  { name: 'sleep', answer: '{"facts":[],"relationships":[],"interests":[],"selfInterests":[]}', lane: 'sleep', call: o => new OpenAISleepMemoryAnalyzer(o).analyze([{ content: '猫が好き', observedAt: AT }], { scopeKey: 'owner', occurredAt: AT, stage5: true, selfInterests: [] }) },
  { name: 'daily focus', answer: '{"topic":"記憶","reason":"興味がある","openingLine":"気になります。"}', lane: 'sleep', call: o => new OpenAIDailyMindModel(o).generate({ scopeKey: 'owner', recentInterests: ['記憶'], candidate: null }) },
  { name: 'organize', answer: '{"tasks":[]}', lane: 'chat', call: o => new OpenAIOrganizeExtractor({ ...o, model: o.model ?? DEFAULT_HAIKU_MODEL }).extract('owner', [{ role: 'user', content: '来週の準備をしたい' }]) },
  { name: 'room look', answer: '案内板が見えます。', lane: 'chat', call: o => new OpenAIRoomLookViewer(o).see({ scopeKey: 'owner', image: { mediaType: 'image/jpeg', base64: Buffer.from(jpeg).toString('base64'), width: 20, height: 20 }, context: [] }) },
  { name: 'touch', answer: '{"say":true,"text":"くすぐったいです。","feeling":"giggle"}', lane: 'chat', call: o => new OpenAIBodyReactionSpeaker(o).decide({ scopeKey: 'owner', prompt: '触れられた事実。', signal: new AbortController().signal }) },
  { name: 'voice photo', answer: '案内板が見えます。', lane: 'chat', call: o => new OpenAIVoiceVisionGateway(o).analyze({ scopeKey: 'owner', image: jpeg, mimeType: 'image/jpeg', conversationContext: '旅行中です。' }) },
  { name: 'voice router', answer: JSON.stringify(routerAnswer), lane: 'voice', call: o => new OpenAIVoiceDecisionGateway(o).decide(input) },
  { name: 'turn checker', answer: '{"verdict":"claims_unsupported"}', lane: 'chat', call: o => new OpenAITurnChecker(o).check('owner', '保存しました。', [{ name: 'write', effect: 'write', ok: false }]) },
];
type Environment = Readonly<Record<string, string | undefined>>;
const configuredCalls: Record<string, { setting: string; call: (env: Environment, store: LlmUsageStore) => Promise<unknown> }> = {
  'replay text': { setting: 'SHANNON_CONVERSATION_SUMMARY_MODEL', call: (env, store) => createConfiguredReplaySummaryWriter(env, store)!.update('owner', { previousSummary: null, lines: ['話を続けたい'] }) },
  impressions: { setting: 'SHANNON_IMPRESSIONS_MODEL', call: (env, store) => createConfiguredImpressionAnalyzer(env, store)!.analyze('owner', { person: 'ミキ', localDate: '2026-10-08', lines: ['猫が好き'], impressions: [], maximumNew: 2 }) },
  'person facts': { setting: 'SHANNON_PEOPLE_FACTS_MODEL', call: (env, store) => createConfiguredPersonFactJudge(env, store)!.judge('owner', { newFacts: [], facts: [] }) },
  'platform summary': { setting: 'SHANNON_PEOPLE_SUMMARY_MODEL', call: (env, store) => createConfiguredPlatformSummaryWriter(env, store)!.summarize('owner', { place: 'グループ', names: [], lines: ['こんにちは'] }) },
  sleep: { setting: 'SHANNON_SLEEP_MODEL', call: (env, store) => createConfiguredSleepMemoryAnalyzer(env, store).analyze([{ content: '猫が好き', observedAt: AT }], { scopeKey: 'owner', occurredAt: AT, stage5: true, selfInterests: [] }) },
  'daily focus': { setting: 'SHANNON_BACKGROUND_LLM_MODEL', call: (env, store) => createConfiguredDailyMindModel(env, store).generate({ scopeKey: 'owner', recentInterests: ['記憶'], candidate: null }) },
  organize: { setting: 'SHANNON_ORGANIZE_MODEL', call: (env, store) => createConfiguredOrganizeExtractor(env, store).extract('owner', [{ role: 'user', content: '準備したい' }]) },
  'room look': { setting: 'SHANNON_LLM_MODEL', call: (env, store) => createConfiguredRoomLookViewer(env, store)!.see({ scopeKey: 'owner', image: { mediaType: 'image/jpeg', base64: Buffer.from(jpeg).toString('base64'), width: 20, height: 20 }, context: [] }) },
  touch: { setting: 'SHANNON_LLM_MODEL', call: (env, store) => createConfiguredBodyReactionSpeaker(env, store)!.decide({ scopeKey: 'owner', prompt: '触れられた事実', signal: new AbortController().signal }) },
  'voice photo': { setting: 'SHANNON_VISION_MODEL', call: (env, store) => createConfiguredVoiceVisionGateway(env, store)!.analyze({ scopeKey: 'owner', image: jpeg, mimeType: 'image/jpeg', conversationContext: '' }) },
  'voice router': { setting: 'SHANNON_VOICE_ROUTER_MODEL', call: (env, store) => createConfiguredVoiceDecisionGateway(env, store).decide(input) },
  'turn checker': { setting: 'SHANNON_LLM_MODEL', call: async (env, store) => {
    const routing = configuredTurnRouting(env, { databasePath: null, choices: null, usageStore: store })!;
    try { return await routing.routing.checker!.check('owner', '保存しました。', []); } finally { routing.close(); }
  } },
};

describe('all background small-model paths use native Haiku', () => {
  it.each(examples)('$name preserves its result contract, lane and cache usage', async example => {
    const { rows, store } = ledger();
    const calls: Array<{ url: string; body: Record<string, any>; headers: Headers }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return message(example.answer);
    };
    const result = await example.call({ apiKey: 'anthropic-synthetic', fetcher, usageStore: store });
    const expected: Record<string, unknown> = {
      'replay text': '会話の要約。', 'replay template': '{}', impressions: { observations: [], candidates: [] },
      'person facts': { judgements: [] }, 'platform summary': '猫の話をした。', sleep: [],
      'daily focus': { topic: '記憶', reason: '興味がある', openingLine: '気になります。' }, organize: [],
      'room look': '案内板が見えます。', touch: { say: true, text: 'くすぐったいです。', feeling: 'giggle' },
      'voice photo': { description: '案内板が見えます。', model: DEFAULT_HAIKU_MODEL }, 'turn checker': 'claims_unsupported',
    };
    if (example.name === 'voice router') expect(result).toMatchObject({ source: 'anthropic', shouldRespond: true });
    else expect(result).toEqual(expected[example.name]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers.get('x-api-key')).toBe('anthropic-synthetic');
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(calls[0]!.body.model).toBe(DEFAULT_HAIKU_MODEL);
    expect(calls[0]!.body.system[0]).toEqual({ type: 'text', text: HAIKU_PROTOCOL_PREFIX, cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(calls[0]!.body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKey: 'owner', lane: example.lane, model: DEFAULT_HAIKU_MODEL, inputTokens: 640, cachedInputTokens: 0, outputTokens: 20 });
    expect(rows[0]!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('uses Anthropic credentials for every default and legacy Luna factory, with original gates', () => {
    const { store } = ledger();
    const env = { SHANNON_ANTHROPIC_API_KEY: 'haiku-key', OPENAI_API_KEY: 'embedding-only', SHANNON_ADR8_STAGE3: 'on', SHANNON_IMPRESSIONS: 'on' };
    const readers = [createConfiguredReplaySummaryWriter(env, store), createConfiguredImpressionAnalyzer(env, store), createConfiguredPersonFactJudge(env, store),
      createConfiguredPlatformSummaryWriter(env, store), createConfiguredRoomLookViewer(env, store), createConfiguredBodyReactionSpeaker(env, store), createConfiguredVoiceVisionGateway(env, store)];
    expect(readers.every(Boolean)).toBe(true);
    expect(createConfiguredSleepMemoryAnalyzer(env, store).mode).toBe('anthropic');
    expect(createConfiguredOrganizeExtractor(env, store).mode).toBe('anthropic');
    expect(createConfiguredVoiceDecisionGateway(env, store).mode).toBe('anthropic');
    expect(createConfiguredDailyMindModel(env, store)).toBeInstanceOf(OpenAIDailyMindModel);
    expect(createConfiguredVoiceDecisionGateway({ ...env, SHANNON_VOICE_ROUTER_MODEL: 'gpt-5.6-luna' }, store).model).toBe(DEFAULT_HAIKU_MODEL);
    expect(createConfiguredSleepMemoryAnalyzer({ OPENAI_API_KEY: 'embedding-only' }, store).mode).toBe('local-rules');
    expect(createConfiguredVoiceDecisionGateway({ OPENAI_API_KEY: 'embedding-only' }, store).mode).toBe('fallback');
    expect(createConfiguredImpressionAnalyzer({ ...env, SHANNON_IMPRESSIONS: 'off' }, store)).toBeNull();
  });

  it('each production factory migrates an explicit Luna setting and uses the selected provider credential', async () => {
    for (const [name, factory] of Object.entries(configuredCalls)) {
      const { rows, store } = ledger();
      const example = examples.find(item => item.name === name)!;
      const calls: Array<{ url: string; body: Record<string, any>; key: string | null }> = [];
      vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('x-api-key') });
        return message(example.answer);
      });
      await factory.call({ SHANNON_ANTHROPIC_API_KEY: 'actual-haiku-key', ANTHROPIC_API_KEY: 'fallback-key', OPENAI_API_KEY: 'unrelated-openai-key',
        SHANNON_ADR8_STAGE2: 'on', SHANNON_DIFFICULTY: 'on', SHANNON_TURN_VERIFY: 'on', SHANNON_ADR8_STAGE3: 'on', SHANNON_IMPRESSIONS: 'on',
        [factory.setting]: 'gpt-5.6-luna' }, store);
      expect(calls, name).toHaveLength(1);
      expect(calls[0], name).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', key: 'actual-haiku-key', body: { model: DEFAULT_HAIKU_MODEL } });
      expect(rows, name).toMatchObject([{ model: DEFAULT_HAIKU_MODEL, lane: example.lane }]);
      expect(JSON.stringify(calls[0]!.body), name).not.toContain('unrelated-openai-key');
    }
  });

  it('records paid cache failures before rejecting output and never retries', async () => {
    const { rows, store } = ledger();
    const fetcher = vi.fn(async () => message('見えます。', { ...coldUsage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }));
    const writer = new OpenAIReplaySummaryWriter({ apiKey: 'haiku-synthetic', fetcher, usageStore: store });
    await expect(writer.update('owner', { previousSummary: null, lines: ['入力'] })).rejects.toThrow('HAIKU_CACHE');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows).toMatchObject([{ model: DEFAULT_HAIKU_MODEL, inputTokens: 40, outputTokens: 20 }]);
  });

  it.each(['refusal', 'max_tokens'])('charges the %s response once without adopting its partial answer', async stop => {
    const { rows, store } = ledger();
    const fetcher = vi.fn(async () => message('途中の要約を成功として保存しない。', coldUsage, stop));
    await expect(new OpenAIReplaySummaryWriter({ apiKey: 'haiku-synthetic', fetcher, usageStore: store })
      .update('owner', { previousSummary: '保存済み', lines: ['続き'] })).rejects.toThrow('HAIKU_RESPONSE');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(rows).toMatchObject([{ inputTokens: 640, outputTokens: 20, lane: 'memory_background' }]);
  });

  it('honors the original touch cancellation before native provider dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async () => message('{"say":true,"text":"遅い返事","feeling":"neutral"}'));
    await expect(new OpenAIBodyReactionSpeaker({ apiKey: 'haiku-synthetic', fetcher })
      .decide({ scopeKey: 'owner', prompt: '触れられた事実', signal: controller.signal })).rejects.toThrow('BODY_REACTION_UPSTREAM_FAILED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('extracts a task from complete conversation history without treating a last assistant message as prefill', async () => {
    const calls: Record<string, any>[] = [];
    const extractor = new OpenAIOrganizeExtractor({ apiKey: 'haiku-synthetic', model: DEFAULT_HAIKU_MODEL, fetcher: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return message('{"tasks":[{"operation":"create","targetQuery":"","title":"準備する","details":"来週まで","updateFields":[],"projectSelectionRequired":false}]}');
    } });
    expect(await extractor.extract('owner', [{ role: 'user', content: '来週までに準備したい' }, { role: 'assistant', content: '準備を整理しましょう。' }]))
      .toEqual([{ operation: 'create', title: '準備する', details: '来週まで' }]);
    expect(calls[0]!.messages.slice(0, 2)).toEqual([{ role: 'user', content: '来週までに準備したい' }, { role: 'assistant', content: '準備を整理しましょう。' }]);
    expect(calls[0]!.messages.at(-1).role).toBe('user');
  });

  it('retains a stable cached prefix for changing touch input and records a warm read', async () => {
    const { rows, store } = ledger();
    const bodies: Record<string, any>[] = [];
    const speaker = new OpenAIBodyReactionSpeaker({ apiKey: 'haiku-synthetic', usageStore: store, fetcher: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return message('{"say":false,"text":"","feeling":"neutral"}', bodies.length === 1 ? coldUsage : { ...coldUsage, cache_creation_input_tokens: 0, cache_read_input_tokens: 600,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    } });
    await speaker.decide({ scopeKey: 'owner', prompt: 'ライ氏と二人だけ。首をつつかれた。', signal: new AbortController().signal });
    await speaker.decide({ scopeKey: 'owner', prompt: 'ほかの人もいる。手に触れられた。', signal: new AbortController().signal });
    expect(bodies[0]!.system[0]).toEqual(bodies[1]!.system[0]);
    expect(JSON.stringify(bodies[1])).not.toContain('首をつつかれた');
    expect(rows[1]).toMatchObject({ cachedInputTokens: 600, inputTokens: 640 });
    expect(rows[1]!.estimatedCostUsd).toBeLessThan(rows[0]!.estimatedCostUsd);
  });

  it('keeps embedding and Haiku reasoning credentials separate and never routes images to OpenAI', async () => {
    const { store, rows } = ledger();
    const calls: Array<{ url: string; key: string | null; body: Record<string, any> }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), key: headers.get('authorization') ?? headers.get('x-api-key'), body });
      if (String(url).endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2 } }));
      return message('{"queries":["猫の好み"]}');
    };
    const gateway = new OpenAIMemoryModelGateway({ apiKey: 'embedding-key', reasoningApiKey: 'haiku-key', fetcher, usageStore: store });
    await gateway.embed('owner', ['猫'], 'memory');
    expect(await gateway.rewriteQuery('owner', '何が好き？')).toEqual(['猫の好み']);
    expect(calls.map(call => [call.url, call.key])).toEqual([['https://api.openai.com/v1/embeddings', 'Bearer embedding-key'], ['https://api.anthropic.com/v1/messages', 'haiku-key']]);
    expect(rows.map(row => row.model)).toEqual(['text-embedding-3-small', DEFAULT_HAIKU_MODEL]);
    calls.length = 0;
    await new OpenAIVoiceVisionGateway({ apiKey: 'haiku-key', fetcher }).analyze({ scopeKey: 'owner', image: jpeg, mimeType: 'image/jpeg', conversationContext: '' });
    expect(calls[0]!.body.messages[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') } });
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    vi.stubGlobal('fetch', fetcher);
    const onlyEmbedding = configuredMemoryModelGateway({ OPENAI_API_KEY: 'embedding-key' }, store)!;
    await onlyEmbedding.embed('owner', ['猫'], 'memory');
    await expect(onlyEmbedding.rewriteQuery('owner', '猫')).rejects.toThrow('MEMORY_REASONING_NOT_CONFIGURED');
    expect(configuredMemoryModelGateway({ ANTHROPIC_API_KEY: 'haiku-key' }, store)).toBeNull();
  });

  it('records the actual Haiku decider without replacing historical trace labels or leaking content', async () => {
    const drafts: DecisionTraceDraft[] = [];
    const gateway = new OpenAIVoiceDecisionGateway({ apiKey: 'haiku-synthetic', fetcher: async () => message(JSON.stringify(routerAnswer)) });
    const result = await new TracedVoiceDecisionGateway(gateway, (_scope, trace) => drafts.push(checkedTrace(trace)), { usdPerJevCall: null, now: () => AT }).decide({ ...input, transcript: '秘密のひとこと' });
    expect(result.source).toBe('anthropic');
    expect(drafts[0]).toMatchObject({ decider: 'anthropic', model: DEFAULT_HAIKU_MODEL, outcome: 'ok', fallbackDecider: null });
    expect(JSON.stringify(drafts)).not.toContain('秘密のひとこと');
    expect(checkedTrace({ ...drafts[0]!, decider: 'openai', model: 'gpt-5.6-luna' }).decider).toBe('openai');
  });

  it('keeps native Haiku reranking and heading navigation bounded to the supplied original IDs', async () => {
    const { rows, store } = ledger();
    const responses = ['{"scores":[{"key":"c1","relevance":0.9},{"key":"unknown","relevance":1}]}', '{"nodeIds":["node-1","foreign"]}'];
    const gateway = new OpenAIMemoryModelGateway({ apiKey: 'embedding-key', reasoningApiKey: 'haiku-key', usageStore: store,
      fetcher: async () => message(responses.shift()!) });
    expect(await gateway.rerank('owner', '猫', [{ id: 'original-memory', text: '猫が好き' }])).toEqual([{ id: 'original-memory', relevance: 0.9 }]);
    expect(await gateway.selectSections('owner', '猫', [{ id: 'node-1', path: '動物', preview: '猫の話' }])).toEqual(['node-1']);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.lane === 'memory' && row.model === DEFAULT_HAIKU_MODEL)).toBe(true);
  });
});
