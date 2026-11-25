/*
 * The voice warm-up bench (not a test): `SHANNON_ANTHROPIC_API_KEY=… PAIRS=3 node --import tsx tests/perf/voiceWarmBench.ts` from services/api.
 *
 * What the warm-up of a call's first reply (`voiceWarm.ts`) does to the time to her first words, with the real Haiku. Every arm uses a prefix
 * the provider has never seen (a nonce in the system), so a first request is a cold cache the way the first reply after an hour of silence is:
 *   cold  – the first spoken reply of a "call" with nothing warmed;
 *   warm  – `PlatformVoiceService.warm` (the auxiliary model and the reply's cache), then the first spoken reply;
 *   hot   – a second spoken reply right after the cold one (the steady state of a call).
 * Printed per arm: milliseconds from the channel's turn to its first sentence line, the tokens the provider read from and wrote to its cache for the
 * reply (the usage the transport books), and the cost. The router is the local rules and recall the deterministic one, as in `oneHeadBench.ts`.
 * The models are real: keep PAIRS small (each pair is about five requests).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalApiKernel } from '../../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../../src/mind/sleep/backgroundUpdates.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../../src/mind/memory/platformPeople.js';
import { SQLiteSurfaceTurnLog } from '../../src/mind/action/respond/store/surfaceTurnStore.js';
import { PlatformVoiceService, type VoiceTurnLine } from '../../src/surfaces/platform/platformVoice.js';
import { ChatSentenceSplitter, splitChatSentences } from '../../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../../src/surfaces/text/chatSentenceStream.js';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { AnthropicChatModel } from '../../src/infra/models/anthropic/anthropicChatModel.js';
import { LocalVoiceDecisionGateway } from '../../src/mind/selectors/voiceDecision.js';
import { oneHeadEnabled } from '../../src/contracts/oneHeadContract.js';
import type { LlmUsageEvent } from '../../src/infra/models/llmUsage.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../../src/infra/models/chatModel.js';

const pairs = Number(process.env.PAIRS ?? 3);
const apiKey = process.env.SHANNON_ANTHROPIC_API_KEY?.trim() ?? '';
if (!apiKey) throw new Error('SHANNON_ANTHROPIC_API_KEY is required');
const OWNER = '900000000000000001';
const ROOM = 'discord:333:444';
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: 'e'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationId: ROOM, ownerUserId: OWNER, title: '個人の部屋', audience: 'owner-private' }]) };
const ENV = { SHANNON_DC_VOICE: 'on', SHANNON_ONE_HEAD: 'on' };

/** The real model with a nonce in every system, so the provider has never seen the prefix; what it was asked is the real request otherwise. */
class Nonced implements ShannonChatModel {
  readonly mode = 'anthropic' as const;
  readonly model = 'claude-haiku-5-5';
  nonce = '';
  constructor(private readonly inner: AnthropicChatModel) {}
  private marked<T extends { systemPrompt: string }>(request: T): T { return { ...request, systemPrompt: `${request.systemPrompt}\n\n(bench ${this.nonce})` }; }
  generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> { return this.inner.generate(this.marked(request)); }
  generateStreaming(request: ShannonChatModelRequest, onText: (text: string) => void | Promise<void>) { return this.inner.generateStreaming(this.marked(request), onText); }
  generateVoice(request: ShannonVoiceModelRequest) { return this.inner.generateVoice(this.marked(request)); }
  generateVoiceStreaming(request: ShannonVoiceModelRequest, onText: (delta: string) => void | Promise<void>, signal?: AbortSignal) {
    return this.inner.generateVoiceStreaming(this.marked(request), onText, signal);
  }
}

const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-warm-bench-'));
const path = join(directory, 'shannon.sqlite');
const now = () => new Date().toISOString();
const store = new SQLiteShannonStore({ path, now });
const peopleStore = new SQLitePeopleMemoryStore(path);
const background = new BackgroundUpdateCoordinator(store, store);
const usage: LlmUsageEvent[] = [];
/**
 * `SCHEMA_NONCE=1`: the output format too is one the provider has never seen (a field named by the nonce, in every request alike). The journal of
 * 2026-11-24 puts the cold first reply's extra seconds in the model call, and the provider compiles a new output grammar before its first token.
 */
const schemaNonce = process.env.SCHEMA_NONCE === '1';
const provider: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!schemaNonce || typeof init?.body !== 'string') return fetch(url, init);
  const body = JSON.parse(init.body) as { output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } } };
  const properties = body.output_config?.format?.schema?.properties;
  if (properties) properties[`bench_${model.nonce.replace(/[^a-z0-9]/gu, '_')}`] = { type: 'string' };
  return fetch(url, { ...init, body: JSON.stringify(body) });
}) as typeof fetch;
const inner = new AnthropicChatModel({ apiKey, fetch: provider, cachePlan: true, voiceCachePlan: true, now, usageStore: { recordLlmUsage: event => { usage.push(event); },
  backgroundLlmCostUsd: () => 0 }, settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
const model = new Nonced(inner);
const local = new LocalVoiceDecisionGateway();
const api = createLocalApiKernel(now, { voiceDecision: { mode: local.mode, model: local.model, decide: input => local.decide(input) }, chatModel: model,
  stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store),
  () => true, () => oneHeadEnabled(ENV));
const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
/** A service per arm: the warm-up's ten-minute interval (per service) would otherwise skip the later pairs. */
const newVoice = () => new PlatformVoiceService({
  scopeKey: 'owner', bridge, conversationStore: store,
  conversation: { textTurn: api.textTurn.bind(api), seatedVoiceTurn: api.seatedVoiceTurn.bind(api), warmVoiceReply: ask => api.warmVoiceReply(ask) },
  turns, now, chatModel: model, sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), splitter: () => new ChatSentenceSplitter(VOICE_SENTENCE_CUT),
  environment: () => ENV, log: () => undefined,
});

let voice = newVoice();
let serial = 0;
async function reply(message: string): Promise<{ firstMs: number; totalMs: number; text: string }> {
  const started = performance.now();
  let first = 0;
  let text = '';
  await voice.turn({ platform: 'discord', requestId: `bench-${++serial}`, conversationId: ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ',
    userMessage: message, observedAt: now(), participants: [OWNER] }, (line: VoiceTurnLine) => {
    if (line.type === 'sentence' && !first) first = performance.now() - started;
    if (line.type === 'sentence') text += line.text;
  });
  return { firstMs: Math.round(first), totalMs: Math.round(performance.now() - started), text: text.slice(0, 30) };
}

/** The usage of the requests made since `from`, largest first-request input excluded of nothing: each event is one provider request. */
function usageSince(from: number) {
  return usage.slice(from).map(event => ({ input: event.inputTokens, cached: event.cachedInputTokens, output: event.outputTokens, usd: Number(event.estimatedCostUsd.toFixed(5)) }));
}

const rows: Array<Record<string, unknown>> = [];
let spent = 0;
for (let pair = 1; pair <= pairs; pair++) {
  const order = pair % 2 === 1 ? ['cold', 'warm'] as const : ['warm', 'cold'] as const;
  for (const arm of order) {
    model.nonce = `${Date.now().toString(36)}-${arm}-${pair}`;
    voice = newVoice();
    const from = usage.length;
    let warmMs = 0;
    let warmUsage: unknown = null;
    if (arm === 'warm') {
      const started = performance.now();
      const result = await voice.warm({});
      warmMs = Math.round(performance.now() - started);
      warmUsage = { ...result.reply?.[0] };
    }
    const mark = usage.length;
    const first = await reply(`ねえシャノン、今日の調子はどう？ (${arm}${pair})`);
    const firstUsage = usageSince(mark);
    rows.push({ pair, arm, ...(arm === 'warm' ? { warmCallMs: warmMs, warmUsage } : {}), firstWordsMs: first.firstMs, totalMs: first.totalMs, requestUsage: firstUsage });
    if (arm === 'cold') {
      const again = await reply(`もう一回聞くけど、元気？ (hot${pair})`);
      rows.push({ pair, arm: 'hot', firstWordsMs: again.firstMs, totalMs: again.totalMs, requestUsage: usageSince(usage.length - 1) });
    }
    spent += usage.slice(from).reduce((sum, event) => sum + event.estimatedCostUsd, 0);
  }
}
for (const row of rows) console.log(JSON.stringify(row));
console.log(JSON.stringify({ summary: true, pairs, estimatedCostUsd: Number(spent.toFixed(4)) }));
await background.waitForIdle('owner');
turns.close(); peopleStore.close(); store.close(); rmSync(directory, { recursive: true, force: true });
