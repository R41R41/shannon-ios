import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryAudience } from '@shannon/cognition';
import type { MindEvent } from '@shannon/mind';

/**
 * Syzygy ADR-0008 stage 3, step F2 (`docs/mind-workspace-contract.md`): every surface's normalizer COPIES the audience its surface
 * decided and never recomputes it. For each surface fixture, the event's audience is deep-equal to every audience the legacy paths
 * were handed in the same turn: `prepareTurnCognitiveContext`, the history (`visibleConversationHistory`, and the replay's
 * `visibleReplayMessages`) and `SemanticMemoryRecall`. The legacy functions are wrapped, not replaced: they run as they always do.
 */
const legacy = vi.hoisted(() => ({ calls: [] as Array<{ path: string; audience: unknown }> }));

vi.mock('../src/mind/workspace/turnCognitiveContext.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/mind/workspace/turnCognitiveContext.js')>();
  return { ...original, prepareTurnCognitiveContext: (...args: Parameters<typeof original.prepareTurnCognitiveContext>) => {
    legacy.calls.push({ path: 'prepareTurnCognitiveContext', audience: args[2].present });
    return original.prepareTurnCognitiveContext(...args);
  } };
});
vi.mock('../src/mind/memory/memoryVisibility.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/mind/memory/memoryVisibility.js')>();
  return {
    ...original,
    visibleConversationHistory: (...args: Parameters<typeof original.visibleConversationHistory>) => {
      legacy.calls.push({ path: 'visibleConversationHistory', audience: args[4] });
      return original.visibleConversationHistory(...args);
    },
    visibleReplayMessages: (...args: Parameters<typeof original.visibleReplayMessages>) => {
      legacy.calls.push({ path: 'visibleReplayMessages', audience: args[4] });
      return original.visibleReplayMessages(...args);
    },
  };
});

const { createLocalApiKernel } = await import('../src/infra/http/apiKernel.js');
const { OpenAIResponsesChatModel } = await import('../src/infra/models/chatModel.js');
const { SQLiteShannonStore } = await import('../src/infra/sqlite/sqliteStore.js');
const { SQLitePeopleMemoryStore } = await import('../src/mind/memory/store/peopleMemoryStore.js');
const { BackgroundUpdateCoordinator } = await import('../src/mind/sleep/backgroundUpdates.js');
const { SemanticMemoryRecall } = await import('../src/mind/recall/semanticMemoryRecall.js');
const { ShannonTurnMemoryRecall } = await import('../src/mind/recall/turnMemoryRecall.js');
const { SQLiteBodyReactionStore } = await import('../src/surfaces/body/store/bodyReactionStore.js');
const { SQLiteBodyStore } = await import('../src/surfaces/body/store/bodyStore.js');
const { OpenAIBodyReactionSpeaker } = await import('../src/surfaces/body/bodyReactionModel.js');
const { BODY_PRESENT } = await import('../src/surfaces/body/bodyReaction.js');
const { PlatformBridgeService, configuredPlatformBridge } = await import('../src/surfaces/platform/platformBridge.js');
const { PlatformPeople } = await import('../src/mind/memory/platformPeople.js');
const { PlatformReplyService } = await import('../src/surfaces/platform/platformReply.js');
const { SQLiteMinecraftTurnLog, SQLiteSurfaceTurnLog } = await import('../src/surfaces/minecraft/store/minecraftTurnStore.js');
const { MinecraftBody } = await import('../src/surfaces/minecraft/minecraftBody.js');
const { configuredMinecraftBody } = await import('../src/contracts/minecraftBodyContract.js');
const { chatAudienceTurn } = await import('../src/mind/perception/chatAudience.js');
const { INBOX_PRESENT, inboxPerception } = await import('../src/mind/perception/perceptionPorts.js');

const directory = mkdtempSync(join(tmpdir(), 'shannon-perception-matrix-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => { vi.restoreAllMocks(); });

const START = Date.parse('2026-10-07T03:00:00.000Z');
const MINUTE = 60_000;
const structured = JSON.stringify({ reply: 'はい。', feeling: null, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null });

/** A capturing world: the fake provider, a clock, fresh stores, and the events the mind was handed. */
function world(name: string) {
  const path = join(directory, `${name}.sqlite`);
  const clock = { at: START };
  const now = () => new Date(clock.at).toISOString();
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body)) as { text?: { format?: { name?: string } } };
    const format = parsed.text?.format;
    const text = format?.name === 'shannon_body_reaction' ? JSON.stringify({ say: true, text: 'えへへ。', feeling: 'bashful', stance: null })
      : format === undefined ? 'はい。' : structured;
    return new Response(JSON.stringify({ output_text: text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
  }) as typeof fetch;
  const events: MindEvent[] = [];
  const mind = { perceive: (_scopeKey: string, event: MindEvent | null) => { if (event) events.push(event); return null; } };
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher, now });
  // Semantic recall is wrapped at its one entry: the audience it is asked with is recorded, and it answers nothing.
  const semantic = new SemanticMemoryRecall({ embeddingModel: 'test' } as never, store);
  vi.spyOn(SemanticMemoryRecall.prototype, 'recall').mockImplementation(async input => {
    legacy.calls.push({ path: 'SemanticMemoryRecall', audience: input.present });
    return { status: 'empty', hits: [], modelCalls: 0, elapsedMilliseconds: 0 };
  });
  return {
    path, now, fetcher, events, mind, store, peopleStore, background, chatModel, semantic,
    advance: (milliseconds: number) => { clock.at += milliseconds; },
    /** After the work a turn leaves for later (her reply's feeling, background updates) has run. */
    close: async (api?: { waitForBackground(scopeKey: string): Promise<void> }) => {
      await api?.waitForBackground('owner');
      await background.waitForIdle('owner');
      for (let tick = 0; tick < 3; tick += 1) await new Promise(resolve => setImmediate(resolve));
      peopleStore.close(); store.close();
    },
  };
}

type Matrix = { fixture: string; event: MindEvent; audiences: Array<{ path: string; audience: unknown }> };

/** Runs one turn, and pairs the one event the mind was handed with the audiences the legacy paths were handed in it. */
async function turn(fixture: string, w: ReturnType<typeof world>, run: () => Promise<unknown>): Promise<Matrix> {
  legacy.calls.length = 0;
  const before = w.events.length;
  await run();
  const perceived = w.events.slice(before);
  expect(perceived, fixture).toHaveLength(1);
  return { fixture, event: perceived[0]!, audiences: [...legacy.calls] };
}

function expectCopied(row: Matrix, paths: readonly string[]): void {
  for (const path of paths) expect(row.audiences.some(call => call.path === path), `${row.fixture}: ${path} was called`).toBe(true);
  for (const call of row.audiences) expect(row.event.audience, `${row.fixture}: ${call.path}`).toEqual(call.audience);
}

function kernel(w: ReturnType<typeof world>) {
  return createLocalApiKernel(w.now, {
    chatModel: w.chatModel, stateStore: w.store, conversationStore: w.store, knowledgeStore: w.store, background: w.background, peopleMemory: w.peopleStore,
    memoryRecall: new ShannonTurnMemoryRecall(w.semantic, w.store), mind: w.mind,
  });
}

describe('perception copies every surface\'s audience (stage 3, step F2)', () => {
  it('text: the owner alone, and others present', async () => {
    const w = world('text');
    const api = kernel(w);
    const chat = (message: string, extra: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message, ...extra } });
    await chat('こんにちは');
    w.advance(MINUTE);
    const alone = await turn('text owner', w, () => chat('前に話したこと、覚えてる？'));
    expectCopied(alone, ['prepareTurnCognitiveContext', 'visibleReplayMessages', 'SemanticMemoryRecall']);
    expect(alone.event).toMatchObject({ surface: 'text', kind: 'utterance', audience: { kind: 'owner' }, speaker: { kind: 'owner', verified: true } });
    w.advance(MINUTE);
    const others = await turn('text others', w, () => chat('前に話したこと、覚えてる？', { audience: 'others' }));
    expectCopied(others, ['prepareTurnCognitiveContext', 'visibleReplayMessages', 'SemanticMemoryRecall']);
    expect(others.event.audience).toEqual(chatAudienceTurn('others')!.present);
    expect(others.event).toMatchObject({ presence: { openOnly: false, othersMayHear: true }, speaker: { kind: 'unknown', verified: false } });
    await w.close(api);
  });

  it('voice: the owner alone, a companion beside him, and 「友人も一緒」', async () => {
    const w = world('voice');
    const api = kernel(w);
    const speak = (transcript: string, extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: 'owner', threadId: 'thread-voice', transcript, ...body,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...extra, userUtterance: { id: `u-${transcript.length}-${Object.keys(extra).length}`, text: transcript, source: 'speech', rawText: transcript } },
    } });
    await speak('おはよう');
    w.advance(MINUTE);
    const alone = await turn('voice owner', w, () => speak('シャノン、前に話したこと覚えてる？'));
    expectCopied(alone, ['prepareTurnCognitiveContext', 'visibleConversationHistory', 'visibleReplayMessages']);
    expect(alone.event).toMatchObject({ surface: 'voice', audience: { kind: 'owner' }, speaker: { kind: 'owner', verified: true } });
    w.advance(MINUTE);
    const companion = await turn('voice companion', w, () => speak('シャノン、前に話したこと覚えてる？', { companionPresent: true }));
    expectCopied(companion, ['prepareTurnCognitiveContext', 'visibleConversationHistory', 'visibleReplayMessages']);
    expect(companion.event.audience).toMatchObject({ kind: 'people', unknownGuest: true });
    w.advance(MINUTE);
    const guest = await turn('voice guest', w, () => speak('シャノン、こんにちは', {}, { participantMode: 'guest' }));
    expectCopied(guest, ['prepareTurnCognitiveContext']);
    expect(guest.event).toMatchObject({ audience: { kind: 'people' }, speaker: { kind: 'person' }, provenance: { trust: 'untrusted' } });
    // Semantic recall, when the turn searched, was asked with the same audience.
    expect([alone, companion].some(row => row.audiences.some(call => call.path === 'SemanticMemoryRecall'))).toBe(true);
    await w.close(api);
  });

  it('body: a touch with the owner alone and with others beside her', async () => {
    const w = world('body');
    const reactionStore = new SQLiteBodyReactionStore(w.path);
    const bodyStore = new SQLiteBodyStore(w.path);
    const speaker = new OpenAIBodyReactionSpeaker({ apiKey: 'test-only', fetcher: w.fetcher, now: w.now });
    const api = createLocalApiKernel(w.now, {
      chatModel: w.chatModel, stateStore: w.store, conversationStore: w.store, knowledgeStore: w.store, mind: w.mind,
      body: { store: bodyStore, ingestEnabled: true, reactions: { store: reactionStore, speaker, config: {}, experiences: null } },
    });
    const send = (method: 'POST' | 'PUT', path: string, body: Record<string, unknown>, deviceId: string) => api.dispatch({ method, path, body: { scopeKey: 'owner', ...body }, deviceId });
    await send('PUT', '/v1/body/capabilities', { expressions: ['smile'], gestures: [], flags: {} }, 'body-pc');
    // A Talk in progress, so the reaction reads its last lines.
    await send('POST', '/v1/chat', { threadId: 'thread', message: 'ただいま' }, 'iphone');
    w.advance(MINUTE);
    const alone = await turn('body owner', w, () => send('POST', '/v1/body/reactions', { id: 'touch-1', touch: { type: 'pet', durationMs: 1_500, ongoing: true }, audience: 'owner', occurredAt: w.now() }, 'body-pc'));
    expectCopied(alone, ['visibleReplayMessages']);
    expect(alone.event).toMatchObject({ surface: 'body', kind: 'touch', body: 'body-pc', audience: BODY_PRESENT.owner, salienceInputs: { touch: 'press' } });
    w.advance(MINUTE);
    const others = await turn('body others', w, () => send('POST', '/v1/body/reactions', { id: 'touch-2', touch: { type: 'poke', durationMs: 200, ongoing: false, input: 'hover' }, audience: 'others', occurredAt: w.now() }, 'body-pc'));
    // With others beside her the reaction reads no Talk: its audience is the one the body holds, the text chat's `others`.
    expect(others.audiences).toEqual([]);
    expect(others.event.audience).toEqual(BODY_PRESENT.others);
    expect(others.event.audience).toEqual(chatAudienceTurn('others')!.present);
    expect(others.event.presence).toEqual({ openOnly: false, othersMayHear: true });
    await w.close(api);
    reactionStore.close(); bodyStore.close();
  });

  it('Minecraft: the verified owner and a friend in the shared chat', async () => {
    const w = world('minecraft');
    const api = kernel(w);
    const OWNER = 'b9191317-c52d-4d67-85fe-ab831e6db146';
    const FRIEND = '0f6a8c52-1b2d-4e3f-9a8b-7c6d5e4f3a2b';
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot-dev', servers: [
      { serverId: 'lab-qywEbW', ownerUuid: OWNER, title: 'マイクラ実験ワールド', onlineMode: true },
    ] }) })!;
    const turns = new SQLiteMinecraftTurnLog(w.path);
    const body = new MinecraftBody({ configuration, stateStore: w.store, conversationStore: w.store, background: w.background, now: w.now, chatModel: w.chatModel, turns,
      conversation: { textTurn: input => api.textTurn(input) }, peopleStore: w.peopleStore, peopleEnabled: () => true });
    const say = (requestId: string, uuid: string, name: string, message: string) => body.turn('owner', 'minebot-dev', {
      requestId, serverId: 'lab-qywEbW', conversation: { kind: 'channel' }, observedAt: w.now(), speaker: { uuid, name }, message,
    });
    const owner = await turn('minecraft owner', w, () => say('mc-1', OWNER, 'Rai1241', '前の続き、覚えてる？'));
    expectCopied(owner, ['prepareTurnCognitiveContext', 'visibleReplayMessages']);
    expect(owner.event).toMatchObject({ surface: 'minecraft', kind: 'game', body: 'minebot-dev', speaker: { kind: 'owner', verified: true }, provenance: { trust: 'owner' } });
    w.advance(MINUTE);
    const friend = await turn('minecraft friend', w, () => say('mc-2', FRIEND, 'Mina_77', 'シャノン、一緒に家を建てよう'));
    expectCopied(friend, ['prepareTurnCognitiveContext', 'visibleReplayMessages']);
    expect(friend.event).toMatchObject({ speaker: { kind: 'person', verified: false }, provenance: { trust: 'untrusted' } });
    await w.close(api);
    turns.close();
  });

  it('platform: the owner in his DM, a friend and the owner in a shared channel', async () => {
    const w = world('platform');
    const api = kernel(w);
    const OWNER = '900000000000000001';
    const bridge = new PlatformBridgeService(configuredPlatformBridge({
      SHANNON_PLATFORM_BRIDGE_TOKEN: 'b'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
      SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([
        { platform: 'discord', conversationId: 'discord::555', ownerUserId: OWNER, title: 'ライ氏とのDM', audience: 'owner-private' },
        { platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テストサーバー' },
      ]),
    })!, w.store, w.store, w.background, w.now, new PlatformPeople(w.peopleStore, w.store), () => true);
    const log = new SQLiteSurfaceTurnLog(w.path, 'platform_reply_turns');
    const service = new PlatformReplyService({ scopeKey: 'owner', bridge, conversationStore: w.store, conversation: api, turns: log, now: w.now });
    const reply = (fields: Record<string, unknown>) => service.reply({ platform: 'discord', observedAt: w.now(), ...fields } as never);
    const dm = await turn('platform dm', w, () => reply({ requestId: 'dm-1', conversationId: 'discord::555', sourceUserId: OWNER, userMessage: '前に話したこと覚えてる？' }));
    expectCopied(dm, ['prepareTurnCognitiveContext', 'visibleReplayMessages', 'SemanticMemoryRecall']);
    expect(dm.event).toMatchObject({ surface: 'platform', audience: { kind: 'owner' }, speaker: { kind: 'owner', verified: true } });
    w.advance(MINUTE);
    const friend = await turn('platform friend', w, () => reply({ requestId: 'ch-1', conversationId: 'discord:111:222', conversationKind: 'channel', sourceUserId: '900000000000000002', sourceDisplayName: 'ミナ', userMessage: 'シャノン、はじめまして！' }));
    expectCopied(friend, ['prepareTurnCognitiveContext', 'visibleReplayMessages']);
    expect(friend.event).toMatchObject({ speaker: { kind: 'person' }, provenance: { trust: 'untrusted' }, presence: { othersMayHear: true } });
    w.advance(MINUTE);
    const shared = await turn('platform owner shared', w, () => reply({ requestId: 'ch-2', conversationId: 'discord:111:222', conversationKind: 'channel', sourceUserId: OWNER, userMessage: 'ミナはぼくの友達だよ' }));
    expectCopied(shared, ['prepareTurnCognitiveContext', 'visibleReplayMessages']);
    expect(shared.event.audience).not.toEqual({ kind: 'owner' });
    await w.close(api);
    log.close();
  });

  it('the background inbox: the writer\'s audience, mapped as the conversation maps the same words', () => {
    for (const audience of ['owner', 'others'] as const) {
      const event = inboxPerception({ draft: { kind: 'own_time_step', code: 'done', audience, source: 'own_time', sourceId: 'step-1', tool: 'study.create' }, at: new Date(START).toISOString(), seq: 7 })!;
      expect(event.audience).toEqual(INBOX_PRESENT[audience]);
      expect(event.audience).toEqual(chatAudienceTurn(audience)!.present as MemoryAudience);
      expect(event).toMatchObject({ id: 'inbox:7', surface: 'own_time', kind: 'own_time_step', content: null, provenance: { trust: 'system' } });
    }
    // A row of anything but closed values is refused, not perceived.
    expect(inboxPerception({ draft: { kind: 'notice', code: 'said something', audience: 'owner', source: 'own_time', sourceId: 'x' }, at: new Date(START).toISOString() })).toBeNull();
  });
});
