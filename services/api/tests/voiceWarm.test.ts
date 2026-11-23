import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService } from '../src/surfaces/platform/platformVoice.js';
import { ChatSentenceSplitter, splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { oneHeadEnabled } from '../src/contracts/oneHeadContract.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { LocalVoiceDecisionGateway } from '../src/mind/selectors/voiceDecision.js';
import type { VoiceMinecraftPort } from '../src/surfaces/platform/voiceMinecraftPort.js';
import type { ShannonChatModel } from '../src/infra/models/chatModel.js';
import { AnthropicChatModel } from '../src/infra/models/anthropic/anthropicChatModel.js';
import { warmedAudiences, type VoiceWarmAsk } from '../src/surfaces/voice/voiceWarm.js';
import { anthropicFixture, scriptedAnthropic } from './support/anthropicFixtures.js';

/**
 * The warm-up of a call's first reply (2026-11-24): it asks the provider for the very prefix a seated voice turn reads (tools, system, format),
 * with a few output tokens, and keeps nothing. The proof is the bytes: the warm-up's tools, system and format are the first real turn's.
 */
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const SERVER_ROOM = 'discord:111:222';
const PRIVATE_ROOM = 'discord:333:444';
const START = '2026-11-24T12:00:00.000Z';
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: 'c'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([
    { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' },
    { platform: 'discord', conversationId: PRIVATE_ROOM, ownerUserId: OWNER, title: '個人の部屋', audience: 'owner-private' },
  ]) };
const ENV = { SHANNON_DC_VOICE: 'on', SHANNON_ONE_HEAD: 'on' };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function harness(minutes = { value: 0 }) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-voice-warm-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => new Date(Date.parse(START) + minutes.value * 60_000).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const answer = anthropicFixture('structured-answer');
  const provider = scriptedAnthropic(() => ({ ...answer, model: 'claude-haiku-5-5' }));
  const model = new AnthropicChatModel({ apiKey: 'synthetic', fetch: provider.fetcher, cachePlan: true, voiceCachePlan: true,
    settings: { model: 'claude-haiku-5-5', effort: 'low', textThinking: 'adaptive', voiceThinking: 'adaptive' } });
  const local = new LocalVoiceDecisionGateway();
  const api = createLocalApiKernel(now, { voiceDecision: { mode: local.mode, model: local.model, decide: input => local.decide(input) }, chatModel: model,
    stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store),
    () => true, () => oneHeadEnabled(ENV));
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const body: VoiceMinecraftPort = { state: () => ({ connected: true, running: null }), intent: async () => ({ delivered: true, as: 'message' as const }) };
  const asks: VoiceWarmAsk[] = [];
  const voice = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store,
    conversation: { textTurn: api.textTurn.bind(api), seatedVoiceTurn: api.seatedVoiceTurn.bind(api),
      warmVoiceReply: ask => { asks.push(ask); return api.warmVoiceReply(ask); } },
    turns, now, chatModel: model as ShannonChatModel, minecraft: () => body,
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), splitter: () => new ChatSentenceSplitter(VOICE_SENTENCE_CUT),
    environment: () => ENV, log: () => undefined,
  });
  const say = (input: { room: string; user: string; participants: string[]; id: string }) => voice.turn({ platform: 'discord', requestId: input.id,
    conversationId: input.room, voiceChannelId: '700', sourceUserId: input.user, sourceDisplayName: input.user === OWNER ? 'ライ氏' : '友人',
    userMessage: 'シャノン、聞こえる？', observedAt: now(), participants: input.participants }, () => undefined);
  return { api, voice, provider, asks, store, say, minutes,
    close: async () => { await background.waitForIdle('owner'); await new Promise(resolve => setImmediate(resolve)); turns.close(); peopleStore.close(); store.close(); } };
}

/** The warm-ups among a provider's requests (a few output tokens), and the real replies (the words said). The auxiliary model's own warm-up is neither. */
const warmed = (bodies: Array<Record<string, unknown>>) => bodies.filter(body => body.max_tokens === 8);
const replied = (bodies: Array<Record<string, unknown>>) => bodies.filter(body => JSON.stringify(body.messages).includes('シャノン、聞こえる？'));
const prefix = (body: Record<string, unknown>) => JSON.stringify({ model: body.model, tools: body.tools, system: body.system, format: (body.output_config as { format?: unknown } | undefined)?.format, thinking: body.thinking });

describe('the warm-up of a call\'s first spoken reply', () => {
  it('asks the provider for a few tokens with the very tools, system and format of the first real reply (the owner alone)', async () => {
    const h = harness();
    expect(await h.voice.warm({})).toMatchObject({ reply: [{ audience: 'owner_alone', warmed: true }] });
    expect(warmed(h.provider.bodies)).toHaveLength(1);
    await h.say({ room: PRIVATE_ROOM, user: OWNER, participants: [OWNER], id: 'v-1' });
    expect(replied(h.provider.bodies)).toHaveLength(1);
    const real = replied(h.provider.bodies)[0]!;
    expect(real.max_tokens).not.toBe(8);
    expect(prefix(warmed(h.provider.bodies)[0]!)).toBe(prefix(real));
    console.info(`voice warm prefix characters ${JSON.stringify({ tools: JSON.stringify(real.tools).length, system: JSON.stringify(real.system).length })}`);
    await h.close();
  });

  it('warms the two audiences of a channel with others in it, each as the first reply of that audience reads it', async () => {
    const h = harness();
    const result = await h.voice.warm({ others: true });
    expect(result.reply?.map(item => item.audience)).toEqual(warmedAudiences(true));
    const [ownerWarm, guestWarm] = warmed(h.provider.bodies);
    expect(warmed(h.provider.bodies)).toHaveLength(2);
    expect(prefix(ownerWarm!)).not.toBe(prefix(guestWarm!));
    await h.say({ room: SERVER_ROOM, user: OWNER, participants: [OWNER, FRIEND], id: 'v-owner' });
    expect(prefix(ownerWarm!)).toBe(prefix(replied(h.provider.bodies)[0]!));
    await h.say({ room: SERVER_ROOM, user: FRIEND, participants: [OWNER, FRIEND], id: 'v-friend' });
    expect(prefix(guestWarm!)).toBe(prefix(replied(h.provider.bodies)[1]!));
    await h.close();
  });

  it('keeps and says nothing: no turn, no experience, no reply line, and the ask carries no words of anyone', async () => {
    const h = harness();
    const before = h.store.experienceCandidates('owner').length;
    await h.voice.warm({});
    expect(h.store.experienceCandidates('owner')).toHaveLength(before);
    expect(h.asks).toEqual([{ scopeKey: 'owner', audience: 'owner_alone', offerMinecraftIntent: true }]);
    const request = JSON.stringify(warmed(h.provider.bodies)[0]);
    expect(request).not.toContain('シャノン、聞こえる？');
    expect(request).toContain('返事はいらない');
    await h.close();
  });

  it('asks each audience at most once in ten minutes, and again after', async () => {
    const h = harness();
    await h.voice.warm({});
    expect(await h.voice.warm({})).not.toHaveProperty('reply');
    h.minutes.value = 9;
    await h.voice.warm({});
    expect(warmed(h.provider.bodies)).toHaveLength(1);
    h.minutes.value = 11;
    expect((await h.voice.warm({})).reply).toHaveLength(1);
    expect(warmed(h.provider.bodies)).toHaveLength(2);
    await h.close();
  });

  it('is not an error when the provider fails: the call goes on, and the next ask may try again', async () => {
    const h = harness();
    const original = h.api.warmVoiceReply.bind(h.api);
    h.api.warmVoiceReply = async ask => { await original(ask); throw new Error('provider down'); };
    expect((await h.voice.warm({})).reply).toEqual([{ audience: 'owner_alone', warmed: false }]);
    expect((await h.voice.warm({})).reply).toHaveLength(1);
    await h.close();
  });

  it('reads the provider\'s count of the cache it read and wrote', async () => {
    const h = harness();
    const [reply] = (await h.voice.warm({})).reply!;
    const usage = anthropicFixture('structured-answer').usage as { input_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    expect(reply).toMatchObject({ warmed: true, input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 });
    await h.close();
  });
});
