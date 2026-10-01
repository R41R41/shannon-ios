import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, groupAudience, peopleAudience } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { BackgroundUpdateCoordinator } from '../src/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { MemoryEmbeddingWorker } from '../src/memoryEmbeddingWorker.js';
import { DeterministicMemoryModelGateway } from '../src/memoryModels.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import { usableThreadSummary, visibleConversationHistory } from '../src/memoryVisibility.js';
import { configuredPlatformBridge, PlatformBridgeService, platformBridgeThreadId } from '../src/platformBridge.js';
import { DEFAULT_SEMANTIC_MEMORY_CONFIG, SemanticMemoryRecall } from '../src/semanticMemoryRecall.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { prepareTurnCognitiveContext } from '../src/turnCognitiveContext.js';
import { ShannonTurnMemoryRecall } from '../src/turnMemoryRecall.js';
import { ownerSaysCompanionPresent } from '../src/voiceCompanionPresence.js';

const at = '2026-10-02T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Words that exist only in sensitive one-to-one content. None may reach a prompt other people can hear. */
const SENSITIVE = ['ミズクラゲ銀行', 'カピバラ基金', 'ユーザーは病院が苦手', 'オカピ方式'];

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  readonly voiceRequests: ShannonVoiceModelRequest[] = [];
  /** Every request in order, whichever lane answered it. */
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  threadSummary: string | undefined;
  /** The next chat reply, for a turn whose answer paraphrases what it recalled. */
  nextReply: string | undefined;
  get last() { return this.all.at(-1)!; }
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    this.all.push(request);
    const reply = this.nextReply ?? '了解です。';
    this.nextReply = undefined;
    return { mode: this.mode, model: this.model, reply, ...(this.threadSummary ? { threadSummary: this.threadSummary } : {}) };
  }
  async generateVoice(request: ShannonVoiceModelRequest) {
    this.voiceRequests.push(request);
    this.all.push(request);
    return { mode: this.mode, model: this.model, reply: 'はい。' };
  }
}

function persistentStore(): { store: SQLiteShannonStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-audience-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  return { store: new SQLiteShannonStore({ path, now: () => at }), path };
}

function everythingSaid(request: ShannonChatModelRequest | ShannonVoiceModelRequest): string {
  return JSON.stringify([request.systemPrompt, request.history, (request as ShannonChatModelRequest).priorThreadSummary ?? '']);
}

async function seeded() {
  const { store, path } = persistentStore();
  const model = new RecordingModel();
  const gateway = new DeterministicMemoryModelGateway();
  const memoryRecall = new ShannonTurnMemoryRecall(
    new SemanticMemoryRecall(gateway, store, { ...DEFAULT_SEMANTIC_MEMORY_CONFIG, minimumSimilarity: 0, minimumRelevance: 0 }), store);
  const api = createLocalApiKernel(() => at, {
    chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store,
    background: new BackgroundUpdateCoordinator(store, store), memoryRecall,
    memoryStore: new ShannonMemoryService(store, store, () => at, store),
  });
  const chat = async (message: string, threadId = 'thread') => {
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId, message } });
    expect(response.status).toBe(200);
    await api.waitForBackground('owner');
    return (response.body as { turnId: string }).turnId;
  };
  // What the owner and Shannon talked about one-to-one. The ordinary turns come first, so nothing
  // protected was in front of Shannon when she answered them.
  const birds = await chat('最近はハシビロコウの動画ばかり見ている', 'hobby');
  await chat('私は紅茶が好き', 'hobby');
  model.threadSummary = 'カピバラ基金と返済の段取りを相談した';
  const debt = await chat('実は借金があって、ミズクラゲ銀行のローンを返している');
  const hospital = await chat('私は病院が苦手');
  model.threadSummary = undefined;
  const note = store.createShannonKnowledge('owner', {
    title: '返済の段取りの進め方', bodyMarkdown: '## 状況\n返済の段取りを聞かれた\n## 行動\nオカピ方式で月ごとに分けて示す\n## 結果\n納得してもらえた',
    status: 'hypothesis', applicability: '返済の段取りを相談された時', sourceExperienceIds: [debt],
  }, at, 'test');
  expect(await new MemoryEmbeddingWorker(store, store, gateway, store, { now: () => at }).runOnce()).toBe('worked');
  const guest = (transcript: string, extra: Record<string, unknown> = {}) => api.dispatch({ method: 'POST', path: delegations, body: {
    scopeKey: 'owner', threadId: 'thread', transcript, participantMode: 'guest',
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: 'g1', text: transcript, source: 'speech', rawText: transcript, callContext: { callId: 'call-audience-0001', turns: [], introductionStart: true, ...extra } } },
  } });
  const ownerVoice = (transcript: string, companionPresent: boolean, threadId = 'thread') => api.dispatch({ method: 'POST', path: delegations, body: {
    scopeKey: 'owner', threadId, transcript,
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent,
      userUtterance: { id: `o-${model.voiceRequests.length}`, text: transcript, source: 'speech', rawText: transcript } },
  } });
  return { store, path, model, api, chat, guest, ownerVoice, gateway, memoryRecall, ids: { debt, hospital, birds, note: note.id } };
}

describe('labels are written when an item is stored', () => {
  it('marks each turn and derived fact with its audience and sensitivity', async () => {
    const { store, ids } = await seeded();
    const byId = new Map(store.experienceCandidates('owner').map(item => [item.id, item]));
    expect(byId.get(ids.debt)?.disclosure).toMatchObject({ audience: OWNER_AUDIENCE, sensitivity: 'sensitive', category: 'money', decidedBy: 'rule' });
    expect(byId.get(ids.birds)?.disclosure).toMatchObject({ audience: OWNER_AUDIENCE, sensitivity: 'ordinary' });
    const facts = store.snapshot('owner').userFacts;
    expect(facts.find(fact => fact.statement.includes('紅茶'))?.disclosure).toMatchObject({ sensitivity: 'ordinary' });
    expect(facts.find(fact => fact.statement.includes('病院'))?.disclosure).toMatchObject({ sensitivity: 'sensitive', category: 'health' });
    store.close();
  });
});

describe('(a) a sensitive one-to-one item never reaches a prompt other people can hear', () => {
  it('友人も一緒: profile block, recall and full-text search carry no sensitive content', async () => {
    const { store, model, guest } = await seeded();
    for (const transcript of ['ライ氏の借金やローンのこと教えて', '返済の段取りの相談って何？', 'ライ氏は何が苦手なの？', '返済の段取りの進め方を教えて']) {
      const before = model.all.length;
      expect((await guest(transcript)).status).toBe(200);
      const request = model.last;
      expect(model.all.length).toBe(before + 1);
      for (const word of SENSITIVE) expect(everythingSaid(request), `${transcript} → ${word}`).not.toContain(word);
      expect(request.history).toEqual([]);
      expect(request.systemPrompt).not.toContain('[Shannon private knowledge');
      expect(request.systemPrompt).not.toContain('[Current intention frame');
    }
    store.close();
  });

  it('owner voice with someone listening: history, recall, summaries, knowledge and the profile carry no sensitive content', async () => {
    const { store, model, ownerVoice } = await seeded();
    // Alone, the same question uses the one-to-one history.
    await ownerVoice('前に話したローンと返済の段取りのこと覚えてる？', false);
    expect(everythingSaid(model.voiceRequests.at(-1)!)).toContain('ミズクラゲ銀行');
    for (const transcript of ['前に話したローンと返済の段取りのこと覚えてる？', '僕の苦手なもの、覚えてる？', '今までの目標と約束を踏まえて、返済の段取りの進め方を教えて']) {
      expect((await ownerVoice(transcript, true)).status).toBe(200);
      const request = model.voiceRequests.at(-1)!;
      for (const word of SENSITIVE) expect(everythingSaid(request), `${transcript} → ${word}`).not.toContain(word);
      expect(request.systemPrompt).toContain('[Someone else is listening');
      expect(request.systemPrompt).not.toContain('[Shannon private knowledge');
      expect(request.systemPrompt).not.toContain('[Shannon shared state');
    }
    store.close();
  });

  it('every recall stage drops it: deterministic, full-text, semantic, summary, knowledge', async () => {
    const { store, memoryRecall, ids, gateway } = await seeded();
    const snapshot = store.snapshot('owner');
    const context = (present: typeof OWNER_AUDIENCE, message: string) => prepareTurnCognitiveContext(snapshot, store, {
      scopeKey: 'owner', message, occurredAt: at, channel: 'voice', threadId: 'elsewhere', present });
    const question = '借金とローンの返済の段取りを相談した件';
    const alone = context(OWNER_AUDIENCE, question);
    expect(alone.frame.recalledMemoryIDs).toContain(ids.debt);
    expect(alone.prompt).toContain('[別の会話の要約]');
    expect(alone.prompt).toContain('カピバラ基金');
    for (const present of [UNKNOWN_GUEST_PRESENCE, peopleAudience(['person-a']), groupAudience('discord:1')]) {
      const shared = context(present, question);
      expect(shared.frame.recalledMemoryIDs).toEqual([]);
      for (const word of SENSITIVE) expect(shared.prompt).not.toContain(word);
      const enriched = await memoryRecall.enrich(shared, { scopeKey: 'owner', message: question, snapshot, threadId: 'elsewhere', memoryTurn: true });
      expect(enriched.knowledgePrompt).toBe('');
      expect(enriched.frame.recalledMemoryIDs).not.toContain(ids.debt);
      expect(enriched.frame.recalledMemoryIDs).not.toContain(`knowledge:${ids.note}`);
      for (const word of SENSITIVE) expect(enriched.prompt).not.toContain(word);
      const semantic = await new SemanticMemoryRecall(gateway, store, { ...DEFAULT_SEMANTIC_MEMORY_CONFIG, minimumSimilarity: 0, minimumRelevance: 0 })
        .recall({ scopeKey: 'owner', query: question, snapshot, present, isEligible: () => true });
      expect(semantic.hits.map(hit => hit.id)).not.toContain(ids.debt);
      expect(semantic.hits.every(hit => !hit.id.startsWith('thread:') && !hit.id.startsWith('knowledge:'))).toBe(true);
      expect(usableThreadSummary(snapshot, store, 'owner', 'thread', present)).toBeUndefined();
      expect(JSON.stringify(visibleConversationHistory(snapshot, store, 'owner', 'thread', present))).not.toContain('ミズクラゲ銀行');
    }
    // Alone, the semantic stage and the knowledge note are still there.
    const owner = await memoryRecall.enrich(alone, { scopeKey: 'owner', message: question, snapshot, threadId: 'elsewhere', memoryTurn: true });
    expect(owner.knowledgePrompt).toContain('オカピ方式');
    expect(usableThreadSummary(snapshot, store, 'owner', 'thread', OWNER_AUDIENCE)).toContain('カピバラ基金');
    store.close();
  });
});

describe('a reply written from a protected memory is protected too', () => {
  it('withholds a turn whose prompt recalled a sensitive item, even when its own words look ordinary', async () => {
    const { store, model, chat, guest, ownerVoice, api } = await seeded();
    // The owner asks without any protected word; Shannon answers in a paraphrase the keyword rules do not catch.
    model.nextReply = 'あの件はクラゲ作戦で順調ですよ。';
    const paraphrase = await chat('ミズクラゲの件どうなった？', 'follow-up');
    const stored = store.experiencesById('owner', [paraphrase])[0]!;
    expect(stored.disclosure).toMatchObject({ sensitivity: 'ordinary' });
    expect(stored.recalledMemoryIds?.length).toBeGreaterThan(0);

    await guest('作戦が順調って、何のこと？');
    expect(everythingSaid(model.last)).not.toContain('クラゲ作戦');
    await ownerVoice('前に話した作戦が順調な件、覚えてる？', true, 'follow-up');
    expect(everythingSaid(model.last)).not.toContain('クラゲ作戦');
    await ownerVoice('前に話した作戦が順調な件、覚えてる？', false, 'follow-up');
    expect(everythingSaid(model.last)).toContain('クラゲ作戦');

    // The owner can still say that this turn is fine to mention.
    await api.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: paraphrase, action: 'mark-ordinary' } });
    await ownerVoice('前に話した作戦が順調な件、覚えてる？', true, 'follow-up');
    expect(everythingSaid(model.last)).toContain('クラゲ作戦');
    store.close();
  });
});

describe('(b) an ordinary one-to-one item may be used with other people present', () => {
  it('友人も一緒 recalls ordinary content and ordinary profile facts', async () => {
    const { store, model, guest } = await seeded();
    await guest('ライ氏はどんな動画を見ているの？');
    const prompt = model.last.systemPrompt;
    expect(prompt).toContain('ハシビロコウ');
    expect(prompt).toContain('[この場で使ってよいライ氏についての記憶]');
    expect(prompt).toContain('ユーザーは紅茶が好き');
    store.close();
  });

  it('owner voice with someone listening keeps ordinary history and facts', async () => {
    const { store, model, ownerVoice } = await seeded();
    await ownerVoice('前に話した動画のこと覚えてる？', true, 'hobby');
    const request = model.voiceRequests.at(-1)!;
    expect(JSON.stringify(request.history)).toContain('ハシビロコウ');
    expect(request.systemPrompt).toContain('ユーザーは紅茶が好き');
    store.close();
  });

  it('the owner can change an item between 機微 and ふつう, and that decides', async () => {
    const { store, api, model, guest, ids } = await seeded();
    const act = (memoryId: string, action: string) => api.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId, action } });
    const item = async (memoryId: string) => ((await api.dispatch({ method: 'GET', path: '/v1/memories',
      query: new URLSearchParams({ scopeKey: 'owner' }) })).body as { items: Array<{ id: string; disclosure?: Record<string, string> }> })
      .items.find(candidate => candidate.id === memoryId)?.disclosure;
    expect(await item(ids.birds)).toMatchObject({ audience: 'ライ氏と二人の時', sensitivity: 'ordinary', decidedBy: 'rule' });
    expect(await item(ids.debt)).toMatchObject({ sensitivity: 'sensitive', decidedBy: 'rule' });
    expect((await item(ids.debt))?.reason).toContain('お金');

    expect((await act(ids.birds, 'mark-sensitive')).status).toBe(200);
    expect(await item(ids.birds)).toMatchObject({ sensitivity: 'sensitive', decidedBy: 'owner' });
    await guest('ライ氏はどんな動画を見ているの？');
    expect(model.last.systemPrompt).not.toContain('ハシビロコウ');

    expect((await act(ids.debt, 'mark-ordinary')).status).toBe(200);
    await guest('借金とローンって何のこと？');
    expect(model.last.systemPrompt).toContain('ミズクラゲ銀行');
    store.close();
  });
});

describe('(f) data written before labels existed behaves as owner-only', () => {
  it('an unlabelled turn and an unlabelled fact are used alone and withheld from everyone else', async () => {
    const { store, path, model, guest, ownerVoice } = await seeded();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE experience_events SET payload_json = json_remove(payload_json, '$.disclosure') WHERE event_type = 'turn.completed'");
    raw.close();
    store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'legacy-fact', statement: 'ユーザーはアルパカが好き', confidence: 0.8, observedAt: at } });
    expect(store.experienceCandidates('owner').every(item => item.disclosure === undefined)).toBe(true);
    await guest('ライ氏はどんな動画を見ていて、何が好きなの？');
    const guestPrompt = model.last;
    expect(everythingSaid(guestPrompt)).not.toContain('ハシビロコウ');
    expect(everythingSaid(guestPrompt)).not.toContain('アルパカ');
    await ownerVoice('前に話した動画のこと覚えてる？', true, 'hobby');
    expect(everythingSaid(model.voiceRequests.at(-1)!)).not.toContain('ハシビロコウ');
    await ownerVoice('前に話した動画のこと覚えてる？', false, 'hobby');
    expect(everythingSaid(model.voiceRequests.at(-1)!)).toContain('ハシビロコウ');
    const item = store.snapshot('owner').userFacts.find(fact => fact.id === 'legacy-fact');
    expect(item?.disclosure).toBeUndefined();
    store.close();
  });
});

describe('owner mode with someone else present (PP-01, PP-02, PP-09)', () => {
  it('recognises the owner saying that someone is with him, and nothing else', () => {
    for (const text of ['友達も一緒にいるよ', '今、友達とご飯食べてて', '彼女が隣にいるんだ', '友達に自己紹介して']) {
      expect(ownerSaysCompanionPresent(text), text).toBe(true);
    }
    for (const text of ['昨日友達とご飯食べた', '友達はいないよ', '今度友達を紹介するね', '友達に紹介してもらった', '今日はいい天気', '']) {
      expect(ownerSaysCompanionPresent(text), text).toBe(false);
    }
  });

  it('withholds owner-private projections on the very turn the owner says so, even from an older client', async () => {
    const { store, model, ownerVoice } = await seeded();
    await ownerVoice('友達も一緒にいるよ。ローンのこと覚えてる？', false);
    const request = model.voiceRequests.at(-1)!;
    expect(request.systemPrompt).toContain('[Someone else is listening');
    for (const word of SENSITIVE) expect(everythingSaid(request)).not.toContain(word);
    store.close();
  });

  it('accepts the flag the iPhone sends with the utterance and rejects a malformed one', async () => {
    const { store, model, api } = await seeded();
    const send = (companionPresent: unknown) => api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript: '前に話したローンのこと覚えてる？',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'flagged', text: '前に話したローンのこと覚えてる？', source: 'speech', companionPresent } } } });
    expect((await send(true)).status).toBe(200);
    expect(model.last.systemPrompt).toContain('[Someone else is listening');
    for (const word of SENSITIVE) expect(everythingSaid(model.last)).not.toContain(word);
    expect((await send('yes')).status).toBe(400);
    store.close();
  });

  it('stores such a turn as "someone else was present" and learns nothing about the owner from it', async () => {
    const { store, api } = await seeded();
    const factsBefore = store.snapshot('owner').userFacts.map(fact => fact.id);
    const response = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: '私は辛いものが苦手。明日映画に行こうね', shannonTranscript: 'いいですね。', companionPresent: true } });
    expect(response.status).toBe(201);
    await api.waitForBackground('owner');
    const stored = store.experienceCandidates('owner').at(-1)!;
    expect(stored.disclosure).toMatchObject({ audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown', sensitivity: 'sensitive' });
    const after = store.snapshot('owner');
    expect(after.userFacts.map(fact => fact.id)).toEqual(factsBefore);
    expect(after.prospectiveMemories.map(memory => memory.summary).join()).not.toContain('映画');
    expect(store.dailyUserMessages('owner', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z').map(message => message.content).join())
      .not.toContain('辛いもの');
    // The same words from the owner alone are learned as before.
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: '私は辛いものが苦手', shannonTranscript: '覚えました。' } });
    await api.waitForBackground('owner');
    expect(store.snapshot('owner').userFacts.map(fact => fact.statement).join()).toContain('辛いもの');
    store.close();
  });
});

describe('platform conversations are group audiences', () => {
  function bridge(store: SQLiteShannonStore, bindings: unknown[]) {
    const configuration = configuredPlatformBridge({ SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32),
      SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner', SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(bindings) })!;
    const background = new BackgroundUpdateCoordinator(store, store);
    return { service: new PlatformBridgeService(configuration, store, store, background, () => at), background };
  }
  const group = { platform: 'discord', conversationId: 'c-1', ownerUserId: 'u-1', title: 'Discord・友人グループ' };
  const other = { platform: 'discord', conversationId: 'c-2', ownerUserId: 'u-1', title: 'Discord・別のグループ' };
  const direct = { platform: 'discord', conversationId: 'dm-1', ownerUserId: 'u-1', title: 'Discord・DM', audience: 'owner-private' };

  it('excludes sensitive one-to-one content from a group projection and keeps ordinary content', async () => {
    const { store } = await seeded();
    const { service } = bridge(store, [group, direct]);
    const shared = service.context({ platform: 'discord', conversationId: 'c-1', sourceUserId: 'u-1' });
    for (const word of SENSITIVE) expect(shared.projection).not.toContain(word);
    expect(shared.projection).toContain('ユーザーは紅茶が好き');
    expect(shared.projection).toContain('[Shannon shared audience]');
    expect(shared.projection.length).toBeLessThanOrEqual(2_400);
    // The owner-private binding keeps the full projection.
    expect(service.context({ platform: 'discord', conversationId: 'dm-1', sourceUserId: 'u-1' }).projection).toContain('ユーザーは病院が苦手');
    store.close();
  });

  it('lets what was said in a conversation be used in that conversation only', async () => {
    const { store, model, guest } = await seeded();
    const { service, background } = bridge(store, [group, other]);
    const turn = service.ingest({ platform: 'discord', requestId: 'm-1', conversationId: 'c-1', sourceUserId: 'u-1',
      userMessage: '明日はラッコ診療所に行く', shannonReply: 'お大事に。', observedAt: at });
    await background.waitForIdle('owner');
    const experience = store.experiencesById('owner', [turn.experienceId])[0]!;
    expect(experience.disclosure).toMatchObject({ audience: groupAudience(platformBridgeThreadId('discord', 'c-1')), speaker: 'owner', sensitivity: 'sensitive' });
    const promise = store.snapshot('owner').prospectiveMemories.find(memory => memory.summary.includes('ラッコ診療所'));
    expect(promise?.disclosure?.audience).toEqual(groupAudience(platformBridgeThreadId('discord', 'c-1')));
    expect(service.context({ platform: 'discord', conversationId: 'c-1', sourceUserId: 'u-1' }).projection).toContain('ラッコ診療所');
    expect(service.context({ platform: 'discord', conversationId: 'c-2', sourceUserId: 'u-1' }).projection).not.toContain('ラッコ診療所');
    await guest('明日はどこに行くの？');
    expect(everythingSaid(model.last)).not.toContain('ラッコ診療所');
    store.close();
  });
});

describe('text chat with the owner alone is unchanged', () => {
  it('uses sensitive and ordinary content, summaries and knowledge', async () => {
    const { store, model, chat } = await seeded();
    await chat('前に話した返済の段取りと借金のローンのこと覚えてる？', 'new-thread');
    const request = model.requests.at(-1)!;
    expect(request.systemPrompt).toContain('ミズクラゲ銀行');
    expect(request.systemPrompt).toContain('オカピ方式');
    expect(request.systemPrompt).toContain('ユーザーは病院が苦手');
    store.close();
  });
});
