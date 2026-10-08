import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PrimaryModeChatModel } from '../src/infra/models/primaryModeChatModel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { LocalStubChatModel } from '../src/infra/models/chatModel.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { SQLiteModelModeStore } from '../src/infra/sqlite/modelModeStore.js';
import { createModelModeWiring } from '../src/wiring/modelModeWiring.js';
import { configuredSonnet } from '../src/wiring/sonnetWiring.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/mind/action/respond/turnDeadline.js';
import { finishTurn } from '../src/mind/action/respond/turnRouting.js';
import type { TurnRouting } from '../src/contracts/turnRoutingContract.js';
import { shannonTool } from '../src/mind/tools/shannonTools.js';
import { conversationTools } from '../src/mind/tools/shannonToolSession.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { scriptedAnthropic, message } from './support/anthropicFixtures.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function path() { const directory = mkdtempSync(join(tmpdir(), 'shannon-primary-mode-')); directories.push(directory); return join(directory, 'state.db'); }
const environment = { SHANNON_ANTHROPIC_API_KEY: 'synthetic-primary', SHANNON_ADR8_STAGE2: 'on', SHANNON_SONNET_ROUTING: 'on' };
const request: ShannonChatModelRequest = { scopeKey: 'owner', message: '一緒に考えて', history: [], systemPrompt: '合成試験', generateThreadTitle: false };
const voice: ShannonVoiceModelRequest = { ...request, useWebSearch: false, conversationClass: 'direct' };
const answerText = JSON.stringify({ reply: '合成の返事です。', threadSummary: null, threadTitle: null,
  taskDecision: { disposition: 'none', reason: 'synthetic' }, taskProposal: null, intentPlan: null, artifacts: null });
const usage = { input_tokens: 10, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
const answer = () => message([{ type: 'text', text: answerText }], 'end_turn', { usage });

class RecordingModel implements ShannonChatModel {
  readonly mode = 'anthropic' as const;
  readonly seen: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  result: Partial<ShannonChatModelResult> = {};
  constructor(readonly model: string) {}
  async generate(input: ShannonChatModelRequest) { this.seen.push(input); return { mode: this.mode, model: this.model, reply: '返事です。', ...this.result }; }
  async generateVoice(input: ShannonVoiceModelRequest) { return this.generate(input); }
  async generateStreaming(input: ShannonChatModelRequest, listener: (text: string) => void | Promise<void>) {
    await listener('返事です。'); return this.generate(input);
  }
  async generateVoiceStreaming(input: ShannonVoiceModelRequest, listener: (text: string) => void | Promise<void>) { return this.generateStreaming(input, listener); }
}

describe('primary selection without changing auxiliary or safety boundaries', () => {
  it('keeps Haiku rethink/escalation and actual served tier while denying automatic Sonnet promotion', async () => {
    const store = new SQLiteModelModeStore(path()), haiku = new RecordingModel('claude-haiku-5-5'), sonnet = new RecordingModel('claude-sonnet-5-5');
    const primary = new PrimaryModeChatModel(store, haiku, sonnet);
    haiku.result = { escalated: true };
    expect(await primary.generate({ ...request, tier: 'sonnet', escalation: true, firstTokenBudgetMs: 1 })).toMatchObject({ model: haiku.model, servedTier: 'luna_plus' });
    expect(haiku.seen[0]).toMatchObject({ tier: 'luna', escalation: true }); expect(haiku.seen[0]).not.toHaveProperty('firstTokenBudgetMs');
    haiku.result = { servedTier: 'luna_plus' };
    expect(await primary.generate(request)).toMatchObject({ servedTier: 'luna_plus' });
    expect(sonnet.seen).toEqual([]); store.close();
  });
  it('the real native Haiku still rethinks once at medium after a failed tool', async () => {
    const fixture = scriptedAnthropic([
      message([{ type: 'tool_use', id: 'synthetic_call', name: 'study_list', input: {} }], 'tool_use', { usage }), answer(),
    ]);
    const store = new SQLiteModelModeStore(path());
    const haiku = new AnthropicChatModel({ apiKey: 'synthetic-primary', fetch: fixture.fetcher,
      settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
    const primary = new PrimaryModeChatModel(store, haiku, null);
    const result = await primary.generate({ ...request, tier: 'sonnet', escalation: true,
      tools: { definitions: [shannonTool('study.list')!], maximumCalls: 6, deadline: new TurnDeadline(TEXT_TURN_DEADLINE),
        call: async () => JSON.stringify({ ok: false, failure: 'failed', retryable: true, text: '合成失敗' }) } });
    expect(result).toMatchObject({ model: 'claude-haiku-5-5', escalated: true, servedTier: 'luna_plus' });
    expect(fixture.bodies.map(body => (body.output_config as { effort: string }).effort)).toEqual(['low', 'medium']);
    expect(fixture.bodies.every(body => body.model === 'claude-haiku-5-5')).toBe(true); store.close();
  });
  it('pins before text recall and before voice routing, then observes the next committed preference', async () => {
    const store = new SQLiteModelModeStore(path()), haiku = new RecordingModel('claude-haiku-5-5'), sonnet = new RecordingModel('claude-sonnet-5-5');
    const primary = new PrimaryModeChatModel(store, haiku, sonnet);
    let enter!: () => void, release!: () => void;
    let entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const memoryRecall = { willSearch: () => true, retireKnowledge: () => [], async enrich(context: any) { enter(); await held; return { ...context, knowledgePrompt: '', memoryRecall: { status: 'skipped', modelCalls: 0, elapsedMilliseconds: 0 } }; } };
    const kernel = createLocalApiKernel(() => '2026-10-09T00:00:00Z', { chatModel: primary, memoryRecall });
    const text = kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: '考えて', threadId: 'synthetic-thread' } });
    await entered; store.compareAndSet('owner', 0, 'sonnet'); release();
    expect(await text).toMatchObject({ status: 200, body: { model: haiku.model } });
    expect(await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'もう一つ考えて' } })).toMatchObject({ status: 200, body: { model: sonnet.model } });
    entered = new Promise<void>(resolve => { enter = resolve; }); held = new Promise<void>(resolve => { release = resolve; });
    const local = new LocalVoiceDecisionGateway();
    const voiceKernel = createLocalApiKernel(() => '2026-10-09T00:00:00Z', { chatModel: primary,
      voiceDecision: { mode: 'fallback', model: 'synthetic', async decide(input) { enter(); await held; return local.decide(input); } } });
    const deltas: string[] = [];
    const spoken = voiceKernel.streamLiveVoiceDelegation({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: '聞こえる？' } },
      { onPlan: () => {}, onTextDelta: delta => { deltas.push(delta); } });
    await entered; store.compareAndSet('owner', 1, 'haiku'); release();
    expect(await spoken).toMatchObject({ status: 200, body: { model: sonnet.model } });
    expect(deltas).toEqual(['返事です。']);
    expect(sonnet.seen.at(-1)).toMatchObject({ tier: 'sonnet', firstTokenBudgetMs: 4000 });
    expect(await voiceKernel.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: '聞こえる？' } })).toMatchObject({ status: 200, body: { model: haiku.model } }); store.close();
  });
  it('pins the text stream and keeps each delta once even if the preference changes in the listener', async () => {
    const store = new SQLiteModelModeStore(path()), haiku = new RecordingModel('claude-haiku-5-5'), sonnet = new RecordingModel('claude-sonnet-5-5');
    const pinned = new PrimaryModeChatModel(store, haiku, sonnet).forTurn('owner'), deltas: string[] = [];
    const result = await pinned.generateStreaming!(request, delta => { deltas.push(delta); store.compareAndSet('owner', 0, 'sonnet'); });
    expect(result.model).toBe(haiku.model); expect(deltas).toEqual(['返事です。']); expect(sonnet.seen).toEqual([]); store.close();
  });
  it('preserves native Sonnet fallback metadata and never duplicates words or repeats a completed tool', async () => {
    const fixture = scriptedAnthropic([answer()]), haiku = new RecordingModel('claude-haiku-5-5');
    const sonnet = configuredSonnet(environment, { fetch: fixture.fetcher })!;
    const wiring = createModelModeWiring(environment, { path: path(), ownerScope: 'owner', haiku, sonnet });
    wiring.modes.change('owner', 0, 'sonnet');
    sonnet.generate = async () => { throw new Error('synthetic unknown before effect'); };
    expect(await wiring.chatModel.generate(request)).toMatchObject({ model: haiku.model, servedTier: 'luna' });
    expect(haiku.seen).toHaveLength(1);
    sonnet.generateStreaming = async (_input, listener) => { await listener('途中です。'); throw new Error('synthetic unknown after word'); };
    const deltas: string[] = [];
    expect(await wiring.chatModel.generateStreaming!(request, delta => { deltas.push(delta); })).toMatchObject({ model: sonnet.model, servedTier: 'sonnet', outOfTime: true });
    expect(deltas).toEqual(['途中です。']); expect(haiku.seen).toHaveLength(1);
    const tools = conversationTools(createInMemoryAutonomyService(() => '2026-10-09T00:00:00Z'), 'owner', 'text', true,
      { audience: { othersKnown: () => false, noteOthers: () => {} }, now: () => '2026-10-09T00:00:00Z' }, 'synthetic-thread\nsynthetic', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    sonnet.generate = async input => { await input.tools!.call('study_list', '{}'); throw new Error('synthetic unknown after tool'); };
    expect(await wiring.chatModel.generate({ ...request, tools })).toMatchObject({ model: sonnet.model, servedTier: 'sonnet', outOfTime: true });
    expect(haiku.seen).toHaveLength(1);
    wiring.close();
  });
  it('keeps place discovery auxiliary on Haiku while the final main response follows Sonnet', async () => {
    const store = new SQLiteModelModeStore(path()), haiku = new RecordingModel('claude-haiku-5-5'), sonnet = new RecordingModel('claude-sonnet-5-5');
    store.compareAndSet('owner', 0, 'sonnet');
    const kernel = createLocalApiKernel(() => '2026-10-09T00:00:00Z', { chatModel: new PrimaryModeChatModel(store, haiku, sonnet), auxiliaryChatModel: haiku });
    expect(await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'この近くの公園を地図で探して',
      placeLocation: { latitude: 34.7, longitude: 137.7, accuracyMeters: 24, observedAt: '2026-10-09T00:00:00Z' } } })).toMatchObject({ status: 200, body: { model: sonnet.model } });
    expect(haiku.seen).toHaveLength(1); expect(haiku.seen[0]).toHaveProperty('placeSearch');
    expect(sonnet.seen).toHaveLength(1); expect(sonnet.seen[0]).not.toHaveProperty('placeSearch');
    haiku.seen.length = 0; sonnet.seen.length = 0;
    expect(await kernel.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: 'この近くの公園を地図で探して' } })).toMatchObject({ status: 200, body: { model: sonnet.model } });
    expect(haiku.seen).toHaveLength(1); expect(haiku.seen[0]).toHaveProperty('placeSearch');
    expect(sonnet.seen).toHaveLength(1); expect(sonnet.seen[0]).not.toHaveProperty('placeSearch'); store.close();
  });
  it('advertises only configured capabilities of the captured selection and rejects unavailable native modes', () => {
    const fixture = scriptedAnthropic([answer()]), haiku = new RecordingModel('claude-haiku-5-5');
    const sonnet = configuredSonnet(environment, { fetch: fixture.fetcher })!;
    const ready: string[] = [];
    const wiring = createModelModeWiring({ ...environment, SHANNON_AUTONOMY_ANTHROPIC_API_KEY: 'synthetic-own-time' }, { path: path(), ownerScope: 'owner', haiku, sonnet,
      minecraftReady: (_scope, model) => ready.includes(model) });
    expect(wiring.modes.snapshot('owner').appliesTo).toEqual(['conversation', 'autonomy-planning']);
    ready.push(haiku.model);
    expect(wiring.modes.snapshot('owner').appliesTo).toEqual(['conversation', 'autonomy-planning', 'minecraft-planning']);
    expect(wiring.modes.change('owner', 0, 'sonnet').appliesTo).toEqual(['conversation', 'autonomy-planning']);
    expect(wiring.primarySelection('other')).toBeNull();
    expect(wiring.primarySelection('owner')).toEqual({ mode: 'sonnet', model: sonnet.model, revision: 1 });
    wiring.close();
    for (const unavailable of [{ ...environment, SHANNON_SONNET_ROUTING: 'off' }, { SHANNON_SONNET_ROUTING: 'on' }]) {
      const off = createModelModeWiring(unavailable, { path: path(), ownerScope: 'owner', haiku, sonnet: configuredSonnet(unavailable, {}) });
      expect(() => off.modes.change('owner', 0, 'sonnet')).toThrow('MODEL_MODE_UNAVAILABLE');
      expect(off.modes.snapshot('owner')).toMatchObject({ mode: 'haiku', revision: 0, available: { sonnet: false } }); off.close();
    }
  });
  it('refuses a stored unavailable Sonnet without changing it, and keeps deliberate default overrides honest', async () => {
    const database = path(), store = new SQLiteModelModeStore(database); store.compareAndSet('owner', 0, 'sonnet'); store.close();
    const haiku = new RecordingModel('claude-haiku-5-5');
    const wiring = createModelModeWiring({}, { path: database, ownerScope: 'owner', haiku, sonnet: null });
    expect(() => wiring.chatModel.forTurn!('owner')).toThrow('MODEL_MODE_UNAVAILABLE');
    expect(wiring.modes.snapshot('owner')).toMatchObject({ mode: 'sonnet', revision: 1, available: { sonnet: false } });
    expect(haiku.seen).toEqual([]); wiring.close();
    const overridden = createModelModeWiring({}, { path: path(), ownerScope: 'owner', haiku: new LocalStubChatModel(), sonnet: null });
    expect(overridden.modes.snapshot('owner')).toMatchObject({ mode: 'haiku', revision: 0, available: { haiku: false }, models: { haiku: 'local-stub' } });
    expect((await overridden.chatModel.generate(request)).mode).toBe('local-stub'); overridden.close();
  });
  it('learns the actual owner-selected or rethink tier without changing verification decisions', async () => {
    const records: any[] = [];
    const routing = { switches: { turnVerify: false }, record: (_scope: string, event: unknown) => records.push(event) } as unknown as TurnRouting;
    const decision = { tier: 'luna', served: 'luna', reason: 'plain', mappedDown: 'none', rethinks: 0, verify: true, escalateOnTrouble: true, kind: 'analysis' } as const;
    for (const servedTier of ['sonnet', 'luna_plus', 'luna'] as const) await finishTurn(routing, { scopeKey: 'owner', surface: 'text', threadId: 'synthetic', presence: 'alone', reply: '返事',
      outOfTime: false, escalated: servedTier === 'luna_plus', decision, tools: undefined, remainingMs: 30000, at: '2026-10-09T00:00:00Z', servedTier });
    expect(records.map(event => event.tier.served)).toEqual(['sonnet', 'luna_plus', 'luna']);
  });
});
