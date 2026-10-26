import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { createConversationExtras } from '../src/wiring/conversationExtrasWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { chatTurnRequestBody, chatTurnSchema } from '../src/infra/models/chatModelTurn.js';
import { parseStructuredTurn } from '../src/infra/models/chatModelSupport.js';
import { claudeTextBody } from '../src/infra/models/anthropic/anthropicRequest.js';
import { REPLY_REACTION_INSTRUCTIONS, parsedReplyReaction } from '../src/mind/action/respond/replyReaction.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformReplyService } from '../src/surfaces/platform/platformReply.js';
import { InMemoryPlatformReactionLog, PlatformReactions, validatedPlatformReaction } from '../src/surfaces/platform/platformReactions.js';
import { handlePlatformBridgeRequest, type PlatformBridgeRouteDependencies } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import type { VoiceTurnLine } from '../src/surfaces/platform/platformVoice.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { feedbackHarness } from './support/feedbackHarness.js';

/**
 * Emoji reactions both ways (rich chat §4, owner request 2026-10-26): she reads who put which emoji on which message, or took it off, in
 * the app's Talk and on Discord; and she puts one on the message she answers with her reply (the structured `reaction` field).
 */
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const HER = '900000000000000099';
const ROOM = 'discord:222:300'; // bound owner-private
const SERVER_ROOM = 'discord:111:222'; // shared
const START = '2026-10-26T12:00:00.000Z';
const TOKEN = 'c'.repeat(40);
const BRIDGE = { SHANNON_PLATFORM_BRIDGE_TOKEN: TOKEN, SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([
  { platform: 'discord', conversationId: ROOM, ownerUserId: OWNER, title: 'ライ氏の部屋', audience: 'owner-private' },
  { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' },
]) };
const directories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
let h: ReturnType<typeof feedbackHarness> | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  h?.close(); h = undefined;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A model that puts `reaction` on its reply whenever the turn offers the field. */
class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  reaction = '🎂';
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'おいしそう！', ...(request.offerReaction && this.reaction ? { reaction: this.reaction } : {}) };
  }
}

describe('the reply field', () => {
  const base = { scopeKey: 'owner', systemPrompt: 'あなたはシャノン。', history: [], message: 'ケーキ焼いた' };

  it('is in the schema and the Claude system only on a turn that offers it, and never in the historical GPT request', () => {
    expect(chatTurnSchema(base).properties).not.toHaveProperty('reaction');
    const offered = chatTurnSchema({ ...base, offerReaction: true }) as { properties: Record<string, { type: unknown }>; required: string[] };
    // A plain string, so the provider's grammar gets no union more.
    expect(offered.properties.reaction!.type).toBe('string');
    expect(offered.required).toContain('reaction');
    const settings = { model: 'claude-haiku-5-5', textThinking: 'disabled', voiceThinking: 'disabled' } as never;
    expect(JSON.stringify(claudeTextBody(settings, { ...base, offerReaction: true }, undefined).system)).toContain('[メッセージに付ける絵文字]');
    expect(JSON.stringify(claudeTextBody(settings, base, undefined).system)).not.toContain('[メッセージに付ける絵文字]');
    const gpt = chatTurnRequestBody('gpt-test', { ...base, offerReaction: true }, undefined) as { text: { format: { schema: { properties: object } } } };
    expect(gpt.text.format.schema.properties).not.toHaveProperty('reaction');
    expect(REPLY_REACTION_INSTRUCTIONS).toContain('空文字');
  });

  it('is read as one emoji; empty, text or two emoji are none', () => {
    const answer = (reaction: unknown) => parseStructuredTurn(JSON.stringify({ reply: 'うん', threadSummary: null, threadTitle: null,
      taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null, reaction }));
    expect(answer('😂').reaction).toBe('😂');
    expect(answer(' 👍🏽 ').reaction).toBe('👍🏽');
    for (const none of ['', 'いいね', '😂😂', null, 3]) expect(answer(none)).not.toHaveProperty('reaction');
    expect(parsedReplyReaction('<b>')).toBeUndefined();
  });
});

describe('in the app\'s Talk', () => {
  function kernel(alone = true) {
    h = feedbackHarness();
    h.clock.alone = alone;
    const extras = createConversationExtras({ database: h.db, ownerScope: 'owner', now: () => h!.clock.at, ownerAlone: () => h!.clock.alone,
      feedback: () => null, reportVisible: () => true });
    const model = new Model();
    const api = createLocalApiKernel(() => h!.clock.at, { stateStore: h.store, conversationStore: h.store, knowledgeStore: h.store, chatModel: model,
      conversationExtras: () => extras.ports });
    return { api, model, extras };
  }

  it('puts her reaction on the owner\'s message she answered, on the response and in the Talk read back', async () => {
    const { api, model, extras } = kernel();
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'talk', message: 'ケーキ焼いた' } });
    expect(model.requests[0]!.offerReaction).toBe(true);
    const body = response.body as { shannonReaction?: { messageId: string; emoji: string } };
    const mine = h!.store.conversationHistory('owner', 'talk').find(message => message.role === 'user')!;
    expect(body.shannonReaction).toEqual({ messageId: mine.id, emoji: '🎂' });
    await api.waitForBackground('owner');
    const read = await api.dispatch({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner', threadId: 'talk' }) });
    const messages = (read.body as { messages: Array<{ role: string; shannonReactions?: string[]; reactions?: string[] }> }).messages;
    expect(messages.find(message => message.role === 'user')).toMatchObject({ shannonReactions: ['🎂'] });
    expect(messages.find(message => message.role === 'user')).not.toHaveProperty('reactions');
    expect(extras.reactions.list('owner', 'talk')).toEqual([{ messageId: mine.id, emojis: [], shannonEmojis: ['🎂'] }]);
    // The owner's own reaction beside hers: both are kept, apart.
    expect(extras.reactions.set('owner', { threadId: 'talk', messageId: mine.id, emoji: '🎂', on: true }))
      .toEqual({ messageId: mine.id, emojis: ['🎂'], shannonEmojis: ['🎂'] });
  });

  it('offers no reaction and keeps none while others may see the screen', async () => {
    const { api, model, extras } = kernel(false);
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'talk', message: 'ケーキ焼いた',
      audience: 'others' } });
    expect(model.requests[0]!.offerReaction).toBeUndefined();
    expect(response.body).not.toHaveProperty('shannonReaction');
    h!.clock.alone = true;
    expect(extras.reactions.list('owner', 'talk')).toEqual([]);
    await api.waitForBackground('owner');
  });

  it('tells her next turn what the owner put on and took off, on her message and on his own, once', () => {
    h = feedbackHarness();
    const { turnId } = h.seed({ tools: false, reply: 'ここは大事です。' });
    const { reactions, ports } = createConversationExtras({ database: h.db, ownerScope: 'owner', now: () => h!.clock.at,
      ownerAlone: () => h!.clock.alone, feedback: () => null, reportVisible: () => true });
    const mine = h.store.conversationHistory('owner', 'talk').find(message => message.role === 'user')!;
    reactions.set('owner', { threadId: 'talk', messageId: turnId, emoji: '😂', on: true });
    reactions.set('owner', { threadId: 'talk', messageId: turnId, emoji: '👍', on: true });
    reactions.set('owner', { threadId: 'talk', messageId: turnId, emoji: '😂', on: false });
    reactions.set('owner', { threadId: 'talk', messageId: mine.id, emoji: '🙏', on: true });
    // A retried request is no new event.
    reactions.set('owner', { threadId: 'talk', messageId: mine.id, emoji: '🙏', on: true });
    const block = ports.turnContext('owner', 'talk', true);
    expect(block).toContain('- ボクの「ここは大事です。」に 😂 👍 を付けた、😂 を外した');
    expect(block).toContain('ライ氏自身の「');
    expect(block.match(/🙏/gu)).toHaveLength(1);
    expect(block).toContain('気持ちの手がかり');
    expect(ports.turnContext('owner', 'talk', true)).toBe('');
  });
});

describe('on Discord', () => {
  function harness() {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-emoji-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const now = () => START;
    const store = new SQLiteShannonStore({ path, now });
    const peopleStore = new SQLitePeopleMemoryStore(path);
    const background = new BackgroundUpdateCoordinator(store, store);
    const model = new Model();
    const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
    const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store),
      () => true, () => true);
    const turns = new SQLiteSurfaceTurnLog(path, 'platform_reply_turns');
    const reactions = new PlatformReactions({ scopeKey: 'owner', bridge, log: new InMemoryPlatformReactionLog(), now });
    const reply = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: store, conversation: { textTurn: api.textTurn.bind(api) },
      turns, now, reactions });
    const close = async () => { await background.waitForIdle('owner'); await new Promise(resolve => setImmediate(resolve)); turns.close(); peopleStore.close(); store.close(); };
    return { model, bridge, reactions, reply, close };
  }
  const event = (fields: Record<string, unknown> = {}) => ({
    version: 1, platform: 'discord', conversationId: SERVER_ROOM, messageId: '902', author: { userId: HER, shannon: true },
    excerpt: 'ケーキいいですね！', actor: { userId: FRIEND, displayName: 'ユウ' }, emoji: '😂', on: true, observedAt: START, ...fields,
  });

  async function serve(h: ReturnType<typeof harness>) {
    const dependencies = { configuration: configuredPlatformBridge(BRIDGE)!, chatModel: h.model, service: h.bridge, reply: h.reply,
      reactions: h.reactions, voice: null, environment: () => ({ SHANNON_ONE_HEAD: 'on' }) } as unknown as PlatformBridgeRouteDependencies;
    const server = createServer((request, response) => {
      void handlePlatformBridgeRequest(new URL(request.url ?? '/', 'http://127.0.0.1').pathname, request, response, dependencies);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return (path: string, body: unknown, token = TOKEN) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}` } });
  }

  it('tells her next typed turn there who reacted to whose message, once, and puts her reaction on the done line', async () => {
    const h = harness();
    const call = await serve(h);
    expect(await (await call('/v1/platform/reactions', event())).json()).toEqual({ recorded: true });
    expect((await call('/v1/platform/reactions', event({ actor: { userId: OWNER, displayName: 'ライ' }, emoji: ':party_parrot:',
      author: { userId: FRIEND, displayName: 'ユウ', shannon: false }, excerpt: 'ケーキ焼いた', messageId: '901' }))).status).toBe(202);
    const typed = (words: string) => call('/v1/converse', { version: 1, requestId: `t-${words}`, observedAt: START, modality: 'text',
      where: { platform: 'discord', conversationId: SERVER_ROOM, conversationKind: 'channel' }, who: { userId: FRIEND, displayName: 'ユウ' },
      presence: { participants: [FRIEND] }, words });
    const lines = (await (await typed('ほんとに焼いたんだよ')).text()).trim().split('\n').map(line => JSON.parse(line) as VoiceTurnLine);
    expect(lines.at(-1)).toMatchObject({ type: 'done', reply: 'おいしそう！', reaction: '🎂' });
    const request = h.model.requests[0]!;
    expect(request.offerReaction).toBe(true);
    const prompt = promptOf(request);
    expect(prompt).toContain('[この場の絵文字の反応');
    expect(prompt).toContain('- 「ユウ」がボクの「ケーキいいですね！」に 😂 を付けた');
    expect(prompt).toContain('- ライ氏が「ユウ」の「ケーキ焼いた」に :party_parrot: を付けた');
    await typed('もう一回');
    expect(promptOf(h.model.requests[1]!)).not.toContain('[この場の絵文字の反応');
    await h.close();
  });

  it('keeps only the owner\'s reactions in his private room, nothing stale, and refuses bad input and a wrong token', async () => {
    const h = harness();
    const call = await serve(h);
    expect(await (await call('/v1/platform/reactions', event({ conversationId: ROOM }))).json()).toEqual({ recorded: false });
    expect(await (await call('/v1/platform/reactions', event({ conversationId: ROOM, actor: { userId: OWNER, displayName: 'ライ' } }))).json())
      .toEqual({ recorded: true });
    expect(await (await call('/v1/platform/reactions', event({ observedAt: '2026-10-26T11:00:00.000Z' }))).json()).toEqual({ recorded: false });
    expect((await call('/v1/platform/reactions', event({ emoji: 'いいね' }))).status).toBe(400);
    expect((await call('/v1/platform/reactions', { ...event(), extra: 1 })).status).toBe(400);
    expect((await call('/v1/platform/reactions', event(), 'x'.repeat(40))).status).toBe(401);
    expect(() => validatedPlatformReaction(event({ platform: 'line' }))).toThrow();
    expect(h.reactions.turnBlock('discord', ROOM)).toContain('- ライ氏がボクの「ケーキいいですね！」に 😂 を付けた');
    await h.close();
  });
});
