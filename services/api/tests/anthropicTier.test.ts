import { describe, expect, it } from 'vitest';
import { decideTier } from '@shannon/learning';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { CONVERSATION_TOOL_CALLS, type ShannonModelToolSession } from '../src/infra/models/chatModelTools.js';
import { anthropicApiKey, haikuVoiceThinking, sonnetRoutingAvailable, sonnetSettings } from '../src/infra/models/anthropic/anthropicConfig.js';
import { estimatedAnthropicCostUsd } from '../src/infra/models/claude/claudeUsage.js';
import { AnthropicChatModel, FirstTokenLatency } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { CLAUDE_TEXT_LINES, CLAUDE_WEB_LINE, claudeTextBody, claudeTool, claudeVoiceBody, structuredSchema } from '../src/infra/models/anthropic/anthropicRequest.js';
import { TieredChatModel } from '../src/infra/models/tieredChatModel.js';
import type { LlmUsageEvent } from '../src/infra/models/llmUsage.js';
import { TEXT_TURN_DEADLINE, TURN_OUT_OF_TIME_LINE, TurnDeadline, VOICE_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { routeTurn, tierRequest } from '../src/mind/action/respond/turnRouting.js';
import { SHANNON_TOOLS, shannonTool } from '../src/mind/tools/shannonTools.js';
import { configuredSkillProposer, configuredSonnet, tieredChatModel } from '../src/wiring/sonnetWiring.js';
import { AnthropicSkillSleepModel } from '../src/infra/models/anthropic/anthropicSkillModel.js';
import { createConfiguredSkillSleepModels } from '../src/mind/sleep/skillSleepModel.js';
import { configuredTurnRouting } from '../src/wiring/turnRoutingWiring.js';
import { anthropicFixture, message, scriptedAnthropic } from './support/anthropicFixtures.js';

/** Syzygy ADR-0008 stage 2, step 5: the Sonnet tier (docs/skill-and-routing-contract.md), model-free over recorded response shapes. */
const settings = sonnetSettings({});
const base: ShannonChatModelRequest = { scopeKey: 'owner', systemPrompt: '[シャノン]', profilePrompt: '[ライ氏のこと]', turnContext: '[いまの文脈]',
  history: [{ role: 'assistant', content: 'おかえりなさい。' }, { role: 'user', content: 'ただいま' }, { role: 'user', content: 'つづき' }], message: '書斎に何がある？' };

function session(names = ['study.list', 'study.read']) {
  const calls: string[] = [];
  const value: ShannonModelToolSession = {
    definitions: names.map(name => shannonTool(name)!), maximumCalls: CONVERSATION_TOOL_CALLS, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
    async call(name) { calls.push(name); return JSON.stringify({ ok: true, text: '- id: x｜メモ「雨」', retryable: false }); },
  };
  return { value, calls };
}

function sonnet(script: Parameters<typeof scriptedAnthropic>[0], clock?: () => number) {
  const { fetcher, bodies } = scriptedAnthropic(script);
  const usage: LlmUsageEvent[] = [];
  const model = new AnthropicChatModel({ apiKey: 'test-only', settings, fetch: fetcher, usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 },
    now: () => '2026-10-07T03:00:00.000Z', ...(clock ? { clock } : {}) });
  return { model, bodies, usage };
}

class Luna implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'gpt-5.6-luna';
  readonly seen: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  async generate(request: ShannonChatModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'luna' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.seen.push(request); return { mode: this.mode, model: this.model, reply: 'luna' }; }
}

describe('the Sonnet request', () => {
  it('offers her registry tools as strict tools with the same names and descriptions, the unsupported limits in words', () => {
    for (const tool of SHANNON_TOOLS) {
      const strict = claudeTool(tool);
      expect(strict.strict).toBe(true);
      expect(strict.name).toBe(tool.name.replace('.', '_'));
      expect(strict.description).toBe(tool.description);
      expect(strict.input_schema.required).toEqual([...tool.input.required]);
      expect(JSON.stringify(strict.input_schema)).not.toMatch(/"(?:minLength|maxLength|minimum|maximum)"/u);
      expect((strict.input_schema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
    expect(JSON.stringify(claudeTool(shannonTool('study.search')!).input_schema)).toContain('1〜100字');
    // Luna's registry text is untouched.
    expect(shannonTool('study.search')!.input.properties.query).toMatchObject({ maxLength: 100, minLength: 1 });
  });

  it('turns the structured reply\'s schema into the subset Anthropic supports', () => {
    expect(structuredSchema({ type: 'object', properties: { a: { type: ['string', 'null'], description: 'x' }, b: { type: 'array', maxItems: 2, items: { type: 'string' } } }, required: ['a', 'b'], additionalProperties: false }))
      .toEqual({ type: 'object', properties: { a: { description: 'x', anyOf: [{ type: 'string' }, { type: 'null' }] }, b: { type: 'array', items: { type: 'string' }, description: '（0〜2件）' } }, required: ['a', 'b'], additionalProperties: false });
  });

  it('caches her prompt layers, puts the turn\'s context after his words, and starts with a user turn', () => {
    const tools = session();
    const body = claudeTextBody(settings, { ...base, tools: tools.value }, 'shannon-mac');
    expect(body.model).toBe('claude-sonnet-5-5');
    const system = body.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[0]!.text.startsWith('[シャノン]')).toBe(true);
    expect(system[0]!.text).toContain('[ライ氏のこと]');
    expect(system[0]!.text.endsWith(CLAUDE_TEXT_LINES)).toBe(true);
    expect(body.messages.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'system']);
    expect(body.messages.at(-1)!.content).toBe('[いまの文脈]');
    // His two turns in a row are one user turn.
    expect((body.messages[2]!.content as Array<{ text: string }>).map(part => part.text)).toEqual(['ただいま', 'つづき', '書斎に何がある？']);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools!.map(tool => (tool as { name: string }).name)).toEqual(['study_list', 'study_read']);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(JSON.stringify(body.output_config!.format)).not.toContain('"type":["string","null"]');
  });

  it('never mixes native web citations with the structured final answer', () => {
    const body = claudeTextBody(settings, { ...base, useWebSearch: true, tools: session().value }, undefined);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.output_config).toHaveProperty('format');
    expect((body.system as Array<{ text: string }>)[0]!.text).toContain('[Web検索の回答]');
  });

  it('lets Haiku speak without thinking first unless SHANNON_HAIKU_VOICE_THINKING is on (2026-10-13 latency probe)', () => {
    expect(haikuVoiceThinking({})).toBe('disabled');
    expect(haikuVoiceThinking({ SHANNON_HAIKU_VOICE_THINKING: 'on' })).toBe('adaptive');
    expect(haikuVoiceThinking({ SHANNON_HAIKU_VOICE_THINKING: 'off' })).toBe('disabled');
    const haiku = { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: haikuVoiceThinking({}) } as const;
    const body = claudeVoiceBody(haiku, { ...base, useWebSearch: false, conversationClass: 'direct' }, 1_200);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(2_200);
    expect(claudeTextBody(haiku, base, undefined).thinking).toEqual({ type: 'adaptive' });
  });

  it('speaks on voice with between_tools thinking at low effort and room for it', () => {
    const body = claudeVoiceBody(settings, { ...base, useWebSearch: false, conversationClass: 'direct' }, 1_200);
    expect(body.thinking).toEqual({ type: 'between_tools' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens).toBe(2_200);
    expect(body.tools).toBeUndefined();
  });
});

describe('a Sonnet turn', () => {
  it('runs her tools at parity with luna and reads the structured turn; usage priced with the cache', async () => {
    const tools = session();
    const { model, bodies, usage } = sonnet([anthropicFixture('tool-call'), anthropicFixture('structured-answer')]);
    const result = await model.generate({ ...base, tools: tools.value });
    expect(result).toMatchObject({ mode: 'anthropic', model: 'claude-sonnet-5-5', reply: '書斎にはメモが1つあります。', threadSummary: '書斎の中身を確かめた' });
    expect(tools.calls).toEqual(['study_list']);
    // The second request appends her whole turn (its thinking block unchanged) and every result in one user turn.
    const second = bodies[1]!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(second.at(-2)!.role).toBe('assistant');
    expect(second.at(-2)!.content.map(block => block.type)).toEqual(['thinking', 'tool_use']);
    expect(second.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01' }] });
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ lane: 'chat', model: 'claude-sonnet-5-5', inputTokens: 312 + 4_100, cachedInputTokens: 0, outputTokens: 58 });
    expect(usage[1]!.cachedInputTokens).toBe(4_100);
    expect(usage[1]!.estimatedCostUsd).toBeCloseTo(estimatedAnthropicCostUsd('claude-sonnet-5-5', { input: 420, cacheWrite: 0, cacheRead: 4_100, output: 96, searches: 0 }), 9);
    expect(estimatedAnthropicCostUsd('claude-sonnet-5-5', { input: 1_000_000, cacheWrite: 0, cacheRead: 1_000_000, output: 1_000_000, searches: 1 })).toBeCloseTo(2 + 0.2 + 10 + 0.01, 9);
  });

  it('reads the web search\'s pages as her sources', async () => {
    const web = anthropicFixture('web-search-answer');
    const { model } = sonnet([web, message(web.content.filter(block => block.type === 'text'), 'end_turn')]);
    const result = await model.generate({ ...base, useWebSearch: true });
    expect(result.reply).toBe('今日は晴れです。');
    expect(result.webSources).toEqual([{ title: '今日の天気', url: 'https://example.com/weather' }]);
  });

  it('streams the reply of a text turn as it is written, and measures the first word', async () => {
    let tick = 0;
    const { model } = sonnet([anthropicFixture('structured-answer')], () => (tick += 100));
    const pieces: string[] = [];
    const result = await model.generateStreaming(base, text => { pieces.push(text); });
    expect(pieces.join('')).toBe(result.reply);
    expect(pieces.length).toBeGreaterThan(1);
    expect(model.firstTokenLatency.estimate()).toBeNull();
  });

  it('says her waiting phrase on voice before a tool runs, then her answer, and keeps a rolling first-token measure', async () => {
    const tools = session(['study.list']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const { model } = sonnet([anthropicFixture('tool-call'), message([{ type: 'text', text: 'メモが1つありますよ。' }], 'end_turn')]);
    const heard: string[] = [];
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools }, delta => { heard.push(delta); });
    expect(heard[0]).toBe('ちょっと見てみますね。');
    expect(result.reply).toBe('ちょっと見てみますね。メモが1つありますよ。');
    expect(tools.calls).toEqual(['study_list']);
    const latency = new FirstTokenLatency(5, 3);
    for (const value of [900, 1_200, 800]) latency.record(value);
    expect(latency.estimate()).toBe(1_200);
    for (const value of [600, 700, 650, 640]) latency.record(value);
    expect(latency.estimate()).toBe(700);
  });

  it('says one waiting phrase a turn: her own announcement after the call is not said again (2026-10-13)', async () => {
    const tools = session(['study.list']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const { model } = sonnet([anthropicFixture('tool-call'), message([{ type: 'text', text: 'ちょっと調べてみますね、ライ氏。メモが1つありますよ。' }], 'end_turn')]);
    const heard: string[] = [];
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('ちょっと見てみますね。メモが1つありますよ。');
    expect(result.reply).toBe('ちょっと見てみますね。メモが1つありますよ。');
  });

  it('says no announcement written before the first call when the plan\'s waiting phrase was already heard (review 2026-10-13)', async () => {
    const tools = session(['study.list']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const call = anthropicFixture('tool-call');
    const announced = message([{ type: 'text', text: '確認しますね。' }, ...call.content.filter(block => block.type === 'tool_use')], 'tool_use');
    const { model } = sonnet([announced, message([{ type: 'text', text: 'メモが1つありますよ。' }], 'end_turn')]);
    const heard: string[] = [];
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools, waitingSaid: true }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('メモが1つありますよ。');
    expect(result.reply).toBe('メモが1つありますよ。');
    expect(tools.calls).toEqual(['study_list']);
  });

  it('says her own announcement when the plan\'s waiting phrase is still unsaid at her first words, and then no second phrase', async () => {
    const tools = session(['study.list']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const call = anthropicFixture('tool-call');
    const announced = message([{ type: 'text', text: '確認しますね。' }, ...call.content.filter(block => block.type === 'tool_use')], 'tool_use');
    const { model } = sonnet([announced, message([{ type: 'text', text: 'メモが1つありますよ。' }], 'end_turn')]);
    const heard: string[] = [];
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools, waitingSaid: () => false }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('確認しますね。メモが1つありますよ。');
    expect(result.reply).toBe('確認しますね。メモが1つありますよ。');
  });

  it('leaves the silence before an external call to the plan\'s own cue while it is still pending', async () => {
    const tools = session(['study.list']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const { model } = sonnet([anthropicFixture('tool-call'), message([{ type: 'text', text: 'メモが1つありますよ。' }], 'end_turn')]);
    const heard: string[] = [];
    await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools, waitingSaid: () => false }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('メモが1つありますよ。');
  });

  it('adds no fixed phrase before a call to her own memory', async () => {
    const tools = session(['memory.search']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const call = anthropicFixture('tool-call');
    const toMemory = message(call.content.filter(block => block.type === 'tool_use').map(block => ({ ...block, name: 'memory_search', input: { query: '旅行' } })), 'tool_use');
    const { model } = sonnet([toMemory, message([{ type: 'text', text: '沖縄の話でしたね。' }], 'end_turn')]);
    const heard: string[] = [];
    await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('沖縄の話でしたね。');
  });

  it('says a reply that was only an announcement after all, never an empty one', async () => {
    const { model } = sonnet([message([{ type: 'text', text: '調べてみますね。' }], 'end_turn')]);
    const heard: string[] = [];
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'direct', waitingSaid: true }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('調べてみますね。');
    expect(result.reply).toBe('調べてみますね。');
  });

  it('adds no fixed phrase when the plan\'s waiting phrase was already heard, and keeps a sentence that is an answer', async () => {
    const tools = session(['study.list']);
    const voiceTools = { ...tools.value, deadline: new TurnDeadline(VOICE_TURN_DEADLINE) };
    const { model } = sonnet([anthropicFixture('tool-call'), message([{ type: 'text', text: 'メモが1つありますよ。見てみますね、と言ったのはこれです。' }], 'end_turn')]);
    const heard: string[] = [];
    const result = await model.generateVoiceStreaming({ ...base, useWebSearch: false, conversationClass: 'skill_simple', tools: voiceTools, waitingSaid: true }, delta => { heard.push(delta); });
    expect(heard.join('')).toBe('メモが1つありますよ。見てみますね、と言ったのはこれです。');
    expect(result.reply).toBe('メモが1つありますよ。見てみますね、と言ったのはこれです。');
  });

  it('ends with her fixed line, never a second answer, when it fails after a tool ran', async () => {
    const tools = session();
    const { model } = sonnet((_body, index) => (index === 0 ? anthropicFixture('tool-call') : anthropicFixture('refusal')));
    const result = await model.generate({ ...base, tools: tools.value });
    expect(result.outOfTime).toBe(true);
    expect(result.reply).toBe(TURN_OUT_OF_TIME_LINE);
  });
});

describe('the tiered model', () => {
  it('sends only a `sonnet` request to Sonnet; luna gets every other request unchanged', async () => {
    const luna = new Luna();
    const { model, bodies } = sonnet([anthropicFixture('structured-answer')]);
    const tiered = new TieredChatModel(luna, model, () => undefined);
    expect(tiered.mode).toBe('openai');
    expect((await tiered.generate(base)).reply).toBe('luna');
    expect(luna.seen.at(-1)).toBe(base);
    expect(bodies).toHaveLength(0);
    expect((await tiered.generate({ ...base, tier: 'sonnet' })).model).toBe('claude-sonnet-5-5');
    expect(bodies).toHaveLength(1);
  });

  it('answers with plain luna when Sonnet refuses or fails before any word', async () => {
    for (const script of [[anthropicFixture('refusal')], () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529 })]) {
      const luna = new Luna();
      const lines: string[] = [];
      const { model } = sonnet(script as never);
      const tiered = new TieredChatModel(luna, model, line => lines.push(line));
      const result = await tiered.generate({ ...base, tier: 'sonnet', escalation: true });
      expect(result.reply).toBe('luna');
      expect(luna.seen.at(-1)).not.toHaveProperty('tier');
      expect(luna.seen.at(-1)).not.toHaveProperty('escalation');
      expect(lines[0]).toMatch(/^Shannon sonnet tier fell back to luna/u);
      // The voice turn falls back the same way.
      const voice = await tiered.generateVoice({ ...base, useWebSearch: false, conversationClass: 'direct', tier: 'sonnet' });
      expect(voice.reply).toBe('luna');
    }
  });
});

describe('Sonnet routing (owner answers I-1, I-2)', () => {
  it('is built only with the key, SHANNON_SONNET_ROUTING=on and the difficulty policy; the key never shows', () => {
    expect(configuredSonnet({}, {})).toBeNull();
    expect(configuredSonnet({ ANTHROPIC_API_KEY: 'k' }, {})).toBeNull();
    expect(configuredSonnet({ SHANNON_SONNET_ROUTING: 'on' }, {})).toBeNull();
    expect(configuredSonnet({ ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'on', SHANNON_DIFFICULTY: 'off' }, {})).toBeNull();
    expect(configuredSonnet({ ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'on', SHANNON_ADR8_STAGE2: 'off' }, {})).toBeNull();
    expect(configuredSonnet({ SHANNON_ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'on' }, {})).toBeInstanceOf(AnthropicChatModel);
    expect(anthropicApiKey({ SHANNON_ANTHROPIC_API_KEY: ' a ', ANTHROPIC_API_KEY: 'b' })).toBe('a');
    expect(sonnetRoutingAvailable({ ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'yes' })).toBe(true);
    const luna = new Luna();
    expect(tieredChatModel(luna, null)).toBe(luna);
    expect(configuredSonnet({ ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'on', SHANNON_SONNET_MODEL: 'claude-sonnet-5-5' }, {})!.model).toBe('claude-sonnet-5-5');
    expect(sonnetSettings({ SHANNON_SONNET_EFFORT: 'max', SHANNON_SONNET_TEXT_THINKING: 'between_tools' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', textThinking: 'between_tools', voiceThinking: 'between_tools' });
  });

  it('serves Sonnet on text when difficulty is high, and on voice only when the turn can absorb its measured first token', () => {
    const sonnetModel = { firstTokenLatency: { estimate: () => 9_000 } };
    const routing = configuredTurnRouting({}, { databasePath: null, choices: null, sonnet: sonnetModel })!.routing;
    expect(routing.sonnetAvailable).toBe(true);
    expect(routing.sonnetFirstTokenMs()).toBe(9_000);
    const answer = { difficulty: { taskKind: 'analysis', needsStrongModel: 0.9, needsVerification: 0.1, multiStep: 0.1 }, retry: null };
    const text = routeTurn(routing, { scopeKey: 'owner', surface: 'text', threadId: 't', answer, at: '2026-10-07T03:00:00.000Z' });
    expect(tierRequest(text)).toEqual({ tier: 'sonnet' });
    // 9 s measured + 6 s margin does not fit 12 s left: luna.
    const voice = routeTurn(routing, { scopeKey: 'owner', surface: 'voice', threadId: 't', answer, remainingMs: 12_000, at: '2026-10-07T03:00:00.000Z' });
    expect(voice).toMatchObject({ served: 'luna', mappedDown: 'voice_time' });
    expect(tierRequest(voice)).toEqual({});
    const roomy = routeTurn(routing, { scopeKey: 'owner', surface: 'voice', threadId: 't', answer, remainingMs: 30_000, at: '2026-10-07T03:00:00.000Z' });
    expect(tierRequest(roomy)).toEqual({ tier: 'sonnet' });
    // Without Sonnet, the same turn is luna_plus, as in step 4.
    const none = configuredTurnRouting({}, { databasePath: null, choices: null })!.routing;
    expect(tierRequest(routeTurn(none, { scopeKey: 'owner', surface: 'text', threadId: 't', answer, at: '2026-10-07T03:00:00.000Z' }))).toEqual({ tier: 'luna_plus' });
    expect(decideTier({ surface: 'text', answers: null, lunaCompetence: null, sonnetAvailable: true }).served).toBe('luna');
  });
});

describe('the skill proposer of her sleep (the strongest hook)', () => {
  it('is Sonnet whenever the key is present, routing on or off, and terra otherwise; the maintainer stays OpenAI', () => {
    expect(configuredSkillProposer({}, {})).toBeNull();
    expect(configuredSkillProposer({ ANTHROPIC_API_KEY: 'k' }, {})).toBeInstanceOf(AnthropicSkillSleepModel);
    expect(configuredSkillProposer({ ANTHROPIC_API_KEY: 'k', SHANNON_SONNET_ROUTING: 'off' }, {})!.model).toBe('claude-sonnet-5-5');
    // Review M4: only while her skills are on.
    expect(configuredSkillProposer({ ANTHROPIC_API_KEY: 'k', SHANNON_ADR8_STAGE2: 'off' }, {})).toBeNull();
    expect(configuredSkillProposer({ ANTHROPIC_API_KEY: 'k', SHANNON_SKILLS: 'off' }, {})).toBeNull();
    const strongest = () => configuredSkillProposer({ ANTHROPIC_API_KEY: 'k' }, {});
    const both = createConfiguredSkillSleepModels({ OPENAI_API_KEY: 'o' }, undefined, strongest);
    expect(both.maintainer?.model).toBe('gpt-5.6-terra');
    expect(both.proposer?.model).toBe('claude-sonnet-5-5');
    expect(createConfiguredSkillSleepModels({ OPENAI_API_KEY: 'o' }, undefined, () => configuredSkillProposer({}, {})).proposer?.model).toBe('gpt-5.6-terra');
    // Review M4: without the knowledge sleep (no model key, or switched off) there is no proposer, Sonnet included.
    expect(createConfiguredSkillSleepModels({}, undefined, strongest)).toEqual({ maintainer: null, proposer: null });
    expect(createConfiguredSkillSleepModels({ OPENAI_API_KEY: 'o', SHANNON_KNOWLEDGE_ENABLED: 'false' }, undefined, strongest)).toEqual({ maintainer: null, proposer: null });
  });

  it('answers one structured object, its cost on the background lane, and throws on a refusal', async () => {
    const { fetcher, bodies } = scriptedAnthropic([message([{ type: 'text', text: '{"skills":[]}', citations: null }], 'end_turn'), anthropicFixture('refusal')]);
    const usage: LlmUsageEvent[] = [];
    const proposer = configuredSkillProposer({ ANTHROPIC_API_KEY: 'k' }, { fetch: fetcher, usageStore: { recordLlmUsage: event => { usage.push(event); }, backgroundLlmCostUsd: () => 0 } })!;
    const schema = { type: 'object', properties: { skills: { type: 'array', maxItems: 2, items: { type: 'string' } } }, required: ['skills'], additionalProperties: false };
    expect(await proposer.json('owner', 'skill_proposals', '[手順]', { seeds: [] }, schema)).toEqual({ skills: [] });
    expect(bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4_000, thinking: { type: 'adaptive' }, output_config: { effort: 'medium', format: { type: 'json_schema' } } });
    expect(JSON.stringify(bodies[0]!.output_config)).not.toContain('maxItems');
    expect(usage[0]).toMatchObject({ lane: 'memory_background', model: 'claude-sonnet-5-5', cachedInputTokens: 2_000 });
    await expect(proposer.json('owner', 'skill_proposals', '[手順]', {}, schema)).rejects.toThrow('ANTHROPIC_SKILLS_REFUSAL');
  });
});
