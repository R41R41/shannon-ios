import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, disclosureFor, groupAudience, peopleAudience } from '@shannon/cognition';
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
import { ownerSaysCompanionPresent, speakTimePrivacyCheck } from '../src/voiceCompanionPresence.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-10-02T03:00:00.000Z';
const delegations = '/v1/voice/gemini/cascade/delegations';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Words that exist only in hard-withheld content: a secret, and an item the owner marked 機微 by hand. */
const HARD = ['ウォンバット会', 'アルマジロ'];
/** Words that exist only in protected content that is under the speak-time check. */
const GUARDED = ['ミズクラゲ銀行', 'ユーザーは病院が苦手'];
const SELF_CHECK = '[Speak-time privacy check — other people can hear this reply]';
const MARKER = '【機微:';

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
  return JSON.stringify([promptOf(request), request.history, (request as ShannonChatModelRequest).priorThreadSummary ?? '']);
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
  // Hard-withheld: something the owner asked to keep secret, and something he marked 機微 by hand.
  const secret = await chat('内緒だけど、ウォンバット会に入っている', 'private');
  const marked = await chat('最近アルマジロの置物を集めている', 'collection');
  expect((await api.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: marked, action: 'mark-sensitive' } })).status).toBe(200);
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
  return { store, path, model, api, chat, guest, ownerVoice, gateway, memoryRecall, ids: { debt, hospital, birds, secret, marked, note: note.id } };
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

describe('(a) hard-withheld items never reach a prompt other people can hear; the rest arrives marked', () => {
  it('友人も一緒: no secret and no hand-marked item; protected content carries its marker and the self-check block is present', async () => {
    const { store, model, guest } = await seeded();
    for (const transcript of ['ライ氏の借金やローンのこと教えて', 'ライ氏は何の会に入っているの？', '置物を集めているって本当？', 'ライ氏は何が苦手なの？']) {
      expect((await guest(transcript)).status).toBe(200);
      for (const word of HARD) expect(everythingSaid(model.last), `${transcript} → ${word}`).not.toContain(word);
      expect(promptOf(model.last)).toContain(SELF_CHECK);
      expect(model.last.history).toEqual([]);
    }
    await guest('ライ氏の借金やローンのこと教えて');
    expect(promptOf(model.last)).toContain('【機微:お金・ライ氏だけが知っている】ユーザー: 実は借金があって、ミズクラゲ銀行');
    expect(promptOf(model.last)).toContain('- 【機微:健康・ライ氏だけが知っている】ユーザーは病院が苦手');
    // The marker is on the protected lines only.
    expect(promptOf(model.last)).toContain('- ユーザーは紅茶が好き');
    store.close();
  });

  it('owner voice with someone listening: the same, in history, recall, summaries, knowledge and the profile', async () => {
    const { store, model, ownerVoice } = await seeded();
    for (const [transcript, thread] of [['前に話したローンと返済の段取りのこと覚えてる？', 'thread'], ['前に話した会のこと覚えてる？', 'private'],
      ['前に話した置物のこと覚えてる？', 'collection']] as const) {
      expect((await ownerVoice(transcript, true, thread)).status).toBe(200);
      for (const word of HARD) expect(everythingSaid(model.last), `${transcript} → ${word}`).not.toContain(word);
      expect(promptOf(model.last)).toContain(SELF_CHECK);
      expect(promptOf(model.last)).toContain('[Someone else is listening');
      expect(promptOf(model.last)).not.toContain('[Shannon shared state');
    }
    await ownerVoice('前に話したローンと返済の段取りのこと覚えてる？', true, 'thread');
    const history = JSON.stringify(model.last.history);
    expect(history).toContain('【機微:お金・ライ氏だけが知っている】実は借金があって、ミズクラゲ銀行');
    expect(promptOf(model.last)).toContain('- 【機微:健康・ライ氏だけが知っている】ユーザーは病院が苦手');
    store.close();
  });

  it('every recall stage drops hard-withheld items and marks the rest: deterministic, full-text, semantic, summary, knowledge', async () => {
    const { store, memoryRecall, ids, gateway } = await seeded();
    const snapshot = store.snapshot('owner');
    const context = (present: typeof OWNER_AUDIENCE, message: string) => prepareTurnCognitiveContext(snapshot, store, {
      scopeKey: 'owner', message, occurredAt: at, channel: 'voice', threadId: 'elsewhere', present });
    const question = '借金とローンの返済の段取りを相談した件';
    const hardQuestion = 'ウォンバット会のことと、アルマジロの置物のこと';
    const alone = context(OWNER_AUDIENCE, question);
    expect(alone.prompt).not.toContain(MARKER);
    expect(context(OWNER_AUDIENCE, 'ウォンバット会のこと').frame.recalledMemoryIDs).toContain(ids.secret);
    expect(context(OWNER_AUDIENCE, 'アルマジロの置物のこと').frame.recalledMemoryIDs).toContain(ids.marked);
    for (const present of [UNKNOWN_GUEST_PRESENCE, peopleAudience(['person-a']), groupAudience('discord:1')]) {
      const shared = context(present, question);
      expect(shared.frame.recalledMemoryIDs).toContain(ids.debt);
      const hard = context(present, hardQuestion);
      expect(hard.frame.recalledMemoryIDs).not.toContain(ids.secret);
      expect(hard.frame.recalledMemoryIDs).not.toContain(ids.marked);
      for (const word of HARD) expect(hard.prompt).not.toContain(word);
      for (const word of HARD) expect(shared.prompt).not.toContain(word);
      expect(shared.prompt).toContain('【機微:お金・ライ氏だけが知っている】ユーザー: 実は借金');
      expect(shared.prompt).toContain('【機微:未分類・ライ氏だけが知っている】[別の会話の要約]');
      const enriched = await memoryRecall.enrich(shared, { scopeKey: 'owner', message: question, snapshot, threadId: 'elsewhere', memoryTurn: true });
      for (const word of HARD) expect(enriched.prompt).not.toContain(word);
      expect(enriched.knowledgePrompt.startsWith('【機微:未分類・ライ氏だけが知っている】')).toBe(true);
      expect(enriched.knowledgePrompt).toContain('オカピ方式');
      const semantic = await new SemanticMemoryRecall(gateway, store, { ...DEFAULT_SEMANTIC_MEMORY_CONFIG, minimumSimilarity: 0, minimumRelevance: 0, rerankCandidates: 50 })
        .recall({ scopeKey: 'owner', query: `${question} ${hardQuestion}`, snapshot, present, isEligible: () => true });
      expect(semantic.hits.every(hit => hit.id !== 'thread:private' && hit.id !== 'thread:collection')).toBe(true);
      expect(semantic.hits.map(hit => hit.id)).not.toContain(ids.secret);
      expect(semantic.hits.map(hit => hit.id)).not.toContain(ids.marked);
      expect(semantic.hits.find(hit => hit.id === ids.debt)?.summary.startsWith('【機微:お金・ライ氏だけが知っている】')).toBe(true);
      const history = JSON.stringify(visibleConversationHistory(snapshot, store, 'owner', 'private', present));
      expect(history).not.toContain('ウォンバット会');
    }
    store.close();
  });

  it('a reply written with a secret in front of it is withheld too; one written from merely protected memory is not', async () => {
    const { store, model, chat, guest, ownerVoice } = await seeded();
    // The owner asks without the secret word; Shannon answers in a paraphrase no keyword rule catches.
    model.nextReply = 'あの集まりはワライカワセミ作戦で順調ですよ。';
    const fromSecret = await chat('ウォンバット会の件どうなった？', 'follow-up');
    expect(store.experiencesById('owner', [fromSecret])[0]!.recalledMemoryIds).toContain((await seededIds(store)).secret);
    model.nextReply = 'あの件はクラゲ作戦で順調ですよ。';
    await chat('ミズクラゲ銀行の件どうなった？', 'follow-up-2');

    await guest('作戦が順調って、何のこと？');
    expect(everythingSaid(model.last)).not.toContain('ワライカワセミ作戦');
    expect(everythingSaid(model.last)).toContain('クラゲ作戦');
    await ownerVoice('前に話した作戦が順調な件、覚えてる？', true, 'follow-up');
    expect(everythingSaid(model.last)).not.toContain('ワライカワセミ作戦');
    await ownerVoice('前に話した作戦が順調な件、覚えてる？', false, 'follow-up');
    expect(everythingSaid(model.last)).toContain('ワライカワセミ作戦');
    store.close();
  });
});

describe('the owner alone: no marker, no self-check block, no prompt growth', () => {
  it('text chat and owner voice carry neither, and still use everything', async () => {
    const { store, model, chat, ownerVoice } = await seeded();
    await chat('前に話した返済の段取りと借金のローンのこと、ウォンバット会のこと覚えてる？', 'new-thread');
    const text = model.requests.at(-1)!;
    expect(everythingSaid(text)).not.toContain(MARKER);
    expect(promptOf(text)).not.toContain('Speak-time privacy check');
    expect(promptOf(text)).toContain('ミズクラゲ銀行');
    expect(promptOf(text)).toContain('ウォンバット会');
    expect(promptOf(text)).toContain('オカピ方式');
    expect(promptOf(text)).toContain('ユーザーは病院が苦手');
    await ownerVoice('前に話したローンのこと覚えてる？', false);
    expect(everythingSaid(model.last)).not.toContain(MARKER);
    expect(promptOf(model.last)).not.toContain('Speak-time privacy check');
    expect(promptOf(model.last)).not.toContain('[Someone else is listening');
    expect(everythingSaid(model.last)).toContain('ミズクラゲ銀行');
    store.close();
  });
});

describe('(b) an ordinary one-to-one item is used without a marker', () => {
  it('友人も一緒 and an owner call with someone listening', async () => {
    const { store, model, guest, ownerVoice } = await seeded();
    await guest('ライ氏はどんな動画を見ているの？');
    expect(promptOf(model.last)).toContain('- ユーザー: 最近はハシビロコウの動画ばかり見ている');
    expect(promptOf(model.last)).toContain('- ユーザーは紅茶が好き');
    await ownerVoice('前に話した動画のこと覚えてる？', true, 'hobby');
    expect(JSON.stringify(model.last.history)).toContain('"content":"最近はハシビロコウの動画ばかり見ている"');
    store.close();
  });

  it('the owner\'s 機微 withholds an item outright and his ふつう removes its marker', async () => {
    const { store, api, model, guest, ids } = await seeded();
    const act = (memoryId: string, action: string) => api.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId, action } });
    const item = async (memoryId: string) => ((await api.dispatch({ method: 'GET', path: '/v1/memories',
      query: new URLSearchParams({ scopeKey: 'owner' }) })).body as { items: Array<{ id: string; disclosure?: Record<string, string> }> })
      .items.find(candidate => candidate.id === memoryId)?.disclosure;
    expect(await item(ids.birds)).toMatchObject({ audience: 'ライ氏と二人の時', sensitivity: 'ordinary', decidedBy: 'rule' });
    expect((await item(ids.debt))?.reason).toContain('お金');
    expect(await item(ids.marked)).toMatchObject({ sensitivity: 'sensitive', decidedBy: 'owner' });

    expect((await act(ids.birds, 'mark-sensitive')).status).toBe(200);
    await guest('ライ氏はどんな動画を見ているの？');
    expect(promptOf(model.last)).not.toContain('ハシビロコウ');

    expect((await act(ids.debt, 'mark-ordinary')).status).toBe(200);
    await guest('借金とローンって何のこと？');
    expect(promptOf(model.last)).toContain('- ユーザー: 実は借金があって、ミズクラゲ銀行');
    store.close();
  });
});

describe('(f) data written before labels existed is protected, not withheld', () => {
  it('an unlabelled turn and an unlabelled fact arrive marked 未分類 with others present and unmarked alone', async () => {
    const { store, path, model, guest, ownerVoice } = await seeded();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE experience_events SET payload_json = json_remove(payload_json, '$.disclosure') WHERE event_type = 'turn.completed'");
    raw.close();
    store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'legacy-fact', statement: 'ユーザーはアルパカが好き', confidence: 0.8, observedAt: at } });
    expect(store.experienceCandidates('owner').every(item => item.disclosure === undefined)).toBe(true);
    await guest('ライ氏はどんな動画を見ていて、何が好きなの？');
    expect(promptOf(model.last)).toContain('【機微:未分類・ライ氏だけが知っている】ユーザー: 最近はハシビロコウ');
    expect(promptOf(model.last)).toContain('- 【機微:未分類・ライ氏だけが知っている】ユーザーはアルパカが好き');
    await ownerVoice('前に話した動画のこと覚えてる？', false, 'hobby');
    expect(everythingSaid(model.last)).toContain('ハシビロコウ');
    expect(everythingSaid(model.last)).not.toContain(MARKER);
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

  it('applies on the very turn the owner says so, even from an older client, and tells the iPhone to keep marking', async () => {
    const { store, model, ownerVoice } = await seeded();
    const response = await ownerVoice('友達も一緒にいるよ。会のこと覚えてる？', false, 'private');
    expect(promptOf(model.last)).toContain('[Someone else is listening');
    expect(promptOf(model.last)).toContain(SELF_CHECK);
    for (const word of HARD) expect(everythingSaid(model.last)).not.toContain(word);
    expect(response.body).toMatchObject({ companionPresent: true });
    store.close();
  });

  it('does not run commands that act, start work, learn a goal, or move her stored feeling while someone is listening', async () => {
    const { store, model, api } = await seeded();
    // Typed into the call, so the words are certain and only the presence of someone else decides.
    const ownerVoice = (transcript: string, companionPresent: boolean) => api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript, deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false,
        location: null, companionPresent, userUtterance: { id: `typed-${transcript}-${companionPresent}`, text: transcript, source: 'typed' } } } });
    const before = store.snapshot('owner');
    const cognition = async () => ((await api.dispatch({ method: 'GET', path: '/v1/cognition',
      query: new URLSearchParams({ scopeKey: 'owner' }) })).body as { intents: unknown[] }).intents;
    const goalsBefore = await cognition();
    for (const transcript of ['写真整理をタスクにして', 'それは忘れて', '英語を毎日勉強できるようになりたい。']) {
      const response = await ownerVoice(transcript, true);
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('receipt');
      expect(response.body).not.toHaveProperty('organizeSession');
      expect(response.body).not.toHaveProperty('uiBlocks');
      expect(promptOf(model.last)).toContain('Requests that act');
    }
    expect(await cognition()).toEqual(goalsBefore);
    const after = store.snapshot('owner');
    expect(after.memoryControls).toEqual(before.memoryControls);
    expect(JSON.stringify(after.expressiveEmotion)).toBe(JSON.stringify(before.expressiveEmotion));
    // Alone, the same command runs.
    const acted = (await ownerVoice('写真整理をタスクにして', false)).body as Record<string, unknown>;
    expect('receipt' in acted || 'organizeSession' in acted).toBe(true);
    store.close();
  });

  it('gives today\'s focus, goals and agent work to the model marked, under the self-check', async () => {
    const { store } = persistentStore();
    const model = new RecordingModel();
    const api = createLocalApiKernel(() => at, { chatModel: model, stateStore: store, conversationStore: store,
      background: new BackgroundUpdateCoordinator(store, store),
      dailyMind: { promptFor: () => '[今日の関心] 現在の関心に「ナマケモノ投資」が残っているから', currentFocus: () => null } as never });
    const voice = (transcript: string, companionPresent: boolean) => api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'thread', transcript,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, companionPresent,
        userUtterance: { id: transcript, text: transcript, source: 'speech', rawText: transcript } } } });
    await voice('今日は何に興味ある？最近気になってることを教えて', false);
    const aloneHasFocus = promptOf(model.last).includes('ナマケモノ投資');
    await voice('今日は何に興味ある？最近気になってることを教えて', true);
    expect(promptOf(model.last).includes('ナマケモノ投資')).toBe(aloneHasFocus);
    if (aloneHasFocus) expect(promptOf(model.last)).toContain('【機微:未分類・ライ氏だけが知っている】\n[今日の関心]');
    expect(promptOf(model.last)).toContain('You may talk in general terms about what you and ライ氏 are building');
    // An older client that sends no flag: the words themselves mark the stored turn.
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: '友達も一緒にいるよ', shannonTranscript: 'こんにちは。' } });
    expect(store.experienceCandidates('owner').at(-1)?.disclosure).toMatchObject({ speaker: 'unknown' });
    await api.waitForBackground('owner');
    store.close();
  });

  it('judges a corrected memory by its corrected wording, and keeps a secret a secret when restated', async () => {
    const { store, api, guest, model } = await seeded();
    const tea = store.snapshot('owner').userFacts.find(fact => fact.statement.includes('紅茶'))!;
    await api.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId: tea.id, action: 'correct', text: 'ユーザーはオカメインコ病院に通院している' } });
    await guest('ライ氏は何が好きなの？');
    expect(promptOf(model.last)).toContain('- 【機微:健康・ライ氏だけが知っている】ユーザーはオカメインコ病院に通院している');
    expect(promptOf(model.last)).not.toContain('ユーザーは紅茶が好き');

    const fact = { id: 'fact-secret', statement: 'ユーザーはクアッカ会に入っている', confidence: 0.8, observedAt: at };
    store.apply('owner', { type: 'user-fact-upserted', fact: { ...fact, disclosure: disclosureFor('内緒だけどクアッカ会に入っている') } });
    store.apply('owner', { type: 'user-fact-upserted', fact: { ...fact, disclosure: disclosureFor(fact.statement) } });
    expect(store.snapshot('owner').userFacts.find(item => item.id === 'fact-secret')?.disclosure).toMatchObject({ sensitivity: 'sensitive', category: 'secret' });
    await guest('ライ氏は何の会に入っているの？');
    expect(promptOf(model.last)).not.toContain('クアッカ会');
    store.close();
  });

  it('accepts the flag the iPhone sends with the utterance and rejects a malformed one', async () => {
    const { store, model, api } = await seeded();
    const send = (companionPresent: unknown) => api.dispatch({ method: 'POST', path: delegations, body: {
      scopeKey: 'owner', threadId: 'private', transcript: '前に話した会のこと覚えてる？',
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'flagged', text: '前に話した会のこと覚えてる？', source: 'speech', companionPresent } } } });
    expect((await send(true)).status).toBe(200);
    expect(promptOf(model.last)).toContain('[Someone else is listening');
    for (const word of HARD) expect(everythingSaid(model.last)).not.toContain(word);
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

  it('a group projection carries the self-check, marks protected facts, and holds no hard-withheld item', async () => {
    const { store } = await seeded();
    store.apply('owner', { type: 'user-fact-upserted', fact: { id: 'fact-secret', statement: 'ユーザーはクアッカ会に入っている', confidence: 0.8,
      observedAt: at, disclosure: disclosureFor('内緒だけどクアッカ会に入っている') } });
    const { service } = bridge(store, [group, direct]);
    const shared = service.context({ platform: 'discord', conversationId: 'c-1', sourceUserId: 'u-1' });
    expect(shared.projection).toContain('[Shannon shared audience]');
    expect(shared.projection).toContain('この場の人がまだ知らない個人情報にならないかを自分で確かめ');
    expect(shared.projection).toContain('- ユーザーは紅茶が好き');
    expect(shared.projection).toContain('- 【機微:健康・ライ氏だけが知っている】ユーザーは病院が苦手');
    expect(shared.projection).not.toContain('クアッカ会');
    expect(shared.projection.length).toBeLessThanOrEqual(2_400);
    // The owner-private binding keeps the full, unmarked projection.
    const alone = service.context({ platform: 'discord', conversationId: 'dm-1', sourceUserId: 'u-1' }).projection;
    expect(alone).toContain('ユーザーは病院が苦手');
    expect(alone).toContain('クアッカ会');
    expect(alone).not.toContain(MARKER);
    store.close();
  });

  it('what was said in a conversation is unmarked there and marked elsewhere', async () => {
    const { store, model, guest } = await seeded();
    const { service, background } = bridge(store, [group, other]);
    const turn = service.ingest({ platform: 'discord', requestId: 'm-1', conversationId: 'c-1', sourceUserId: 'u-1',
      userMessage: '明日はラッコ診療所に行く', shannonReply: 'お大事に。', observedAt: at });
    await background.waitForIdle('owner');
    const experience = store.experiencesById('owner', [turn.experienceId])[0]!;
    expect(experience.disclosure).toMatchObject({ audience: groupAudience(platformBridgeThreadId('discord', 'c-1')), speaker: 'owner', sensitivity: 'sensitive' });
    const here = service.context({ platform: 'discord', conversationId: 'c-1', sourceUserId: 'u-1' }).projection;
    expect(here).toMatch(/- 約束: [^\n]*ラッコ診療所/u);
    const elsewhere = service.context({ platform: 'discord', conversationId: 'c-2', sourceUserId: 'u-1' }).projection;
    expect(elsewhere).toMatch(/- 【機微:[^】]*・別のグループの会話で出た】約束: [^\n]*ラッコ診療所/u);
    await guest('明日はどこに行くの？');
    expect(promptOf(model.last)).toMatch(/【機微:[^】]*・別のグループの会話で出た】[^\n]*ラッコ診療所/u);
    store.close();
  });
});

describe('prompt size with other people present', () => {
  it('reports the system prompt and history length for each context and keeps the growth bounded', async () => {
    const { store, model, guest, ownerVoice } = await seeded();
    const size = () => ({ system: promptOf(model.last).length, history: JSON.stringify(model.last.history).length });
    await ownerVoice('前に話した借金のこと覚えてる？', false);
    const alone = size();
    await ownerVoice('前に話した借金のこと覚えてる？', true);
    const companion = size();
    await guest('ライ氏は何が好きなの？');
    const friend = size();
    console.log('PROMPT_SIZE', JSON.stringify({ alone, companion, friend }));
    expect(speakTimePrivacyCheck.length).toBeLessThan(900);
    expect(companion.system).toBeLessThan(alone.system + 1_500);
    store.close();
  });
});

/** IDs of the seeded turns, looked up by their text. */
async function seededIds(store: SQLiteShannonStore) {
  const turns = store.experienceCandidates('owner');
  return { secret: turns.find(turn => turn.userMessage.includes('内緒だけど'))!.id };
}
