import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { PeopleMemoryOverview } from '../src/apiPeopleMemoryRoutes.js';
import { BackgroundUpdateCoordinator } from '../src/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { visibleConversationHistory } from '../src/memoryVisibility.js';
import { SQLitePeopleMemoryStore } from '../src/peopleMemoryStore.js';
import { SQLitePersonIdentityStore } from '../src/personIdentity.js';
import { establishedGuestName, personNameKey } from '../src/voiceGuestNames.js';
import { promptOf } from './modelPrompt.js';

const delegations = '/v1/voice/gemini/cascade/delegations';
const calls = '/v1/voice/gemini/cascade/calls';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  /** What the summary call returns; an Error makes it fail. */
  summary: string | Error = '相手: ミキさん\n話したこと: 好きな食べ物と映画の話をした。\n次に話したいこと: 猫の写真を見せてもらう。';
  get last() { return this.all.at(-1)!; }
  async generate(request: ShannonChatModelRequest) {
    this.all.push(request);
    return { mode: this.mode, model: this.model, reply: 'わかりました。' };
  }
  async generateVoice(request: ShannonVoiceModelRequest) {
    this.all.push(request);
    if (promptOf(request).startsWith('You write Shannon\'s own short memory')) {
      if (this.summary instanceof Error) throw this.summary;
      return { mode: this.mode, model: this.model, reply: this.summary };
    }
    return { mode: this.mode, model: this.model, reply: 'はい。次は猫の写真を見せてくださいね。' };
  }
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-people-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  let clock = Date.parse('2026-10-02T03:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const state = new InMemoryCompanionStateStore(now);
  const conversations = new InMemoryConversationStore();
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const model = new RecordingModel();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: state, conversationStore: conversations,
    background: new BackgroundUpdateCoordinator(state, conversations), peopleMemory: peopleStore });
  const post = (requestPath: string, body: Record<string, unknown>) => api.dispatch({ method: 'POST', path: requestPath, body: { scopeKey: 'owner', ...body } });
  /** One 「友人も一緒」 period: says each utterance, then ends the period. Returns the turns the device would hold. */
  const guestCall = async (callId: string, utterances: readonly string[], options: { remember?: boolean } = {}) => {
    const turns: Array<{ role: 'participant' | 'shannon'; text: string }> = [];
    const prompts: string[] = [];
    for (const [index, transcript] of utterances.entries()) {
      clock += 1_000;
      const response = await post(delegations, { threadId: 'thread', transcript, participantMode: 'guest', deviceContext: {
        timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: `${callId}-${index}`, text: transcript, source: 'speech', rawText: transcript,
          callContext: { callId, turns: [...turns], introductionStart: index === 0, addressedByName: true } } } });
      expect(response.status).toBe(200);
      prompts.push(promptOf(model.last));
      turns.push({ role: 'participant', text: transcript }, { role: 'shannon', text: (response.body as { reply: string }).reply });
    }
    const remembered = options.remember === false ? null : await post(calls, { callId, threadId: 'thread', turns, timeZone: 'Asia/Tokyo' });
    return { turns, prompts, remembered };
  };
  const chat = async (message: string, threadId = 'owner-thread') => {
    clock += 1_000;
    const response = await post('/v1/chat', { threadId, message });
    expect(response.status).toBe(200);
    await api.waitForBackground('owner');
    return promptOf(model.last);
  };
  const overview = async () => (await api.dispatch({ method: 'GET', path: '/v1/people/memory',
    query: new URLSearchParams({ scopeKey: 'owner' }) })).body as PeopleMemoryOverview;
  const act = (body: Record<string, unknown>) => post('/v1/people/memory/action', body);
  return { api, model, state, conversations, peopleStore, path, post, guestCall, chat, overview, act, now };
}

const mikiCall = ['こんにちは', 'はじめまして、ミキと言います', '私は辛いものが苦手。明日映画に行こうね', 'シャノンを毎日使えるように改善したい。'];

describe('how a name is established', () => {
  it.each([
    ['はじめまして、ミキと言います', '', 'ミキ'],
    ['田中って言います', '', '田中'],
    ['ケンって呼んでください', '', 'ケン'],
    ['名前はさくらです', '', 'さくら'],
    ['こんにちは、ユウタです', '', 'ユウタ'],
    ['ミキです', 'お名前、聞いてもいいですか？', 'ミキ'],
    ['私はミキです', 'お名前を教えてください', 'ミキ'],
    ['こちらミキさん', '', 'ミキ'],
    ['友達のケンくんを紹介するね', '', 'ケン'],
    ['この人、ユウタって言うんだ', '', 'ユウタ'],
  ])('%s → %s', (utterance, previous, name) => {
    expect(establishedGuestName(utterance, previous)).toBe(name);
  });

  it.each([
    ['ミキです', ''], ['元気です', 'お名前、聞いてもいいですか？'], ['シャノンって呼んで', ''], ['私は学生です', ''],
    ['声、可愛いね', ''], ['ライ氏と言います', ''], ['名前は何ですか？', ''], ['友達の話を聞いて', ''],
    // Talking about someone who is not here is not an introduction.
    ['同僚の佐藤さんが転職したらしい', ''], ['田中さんを紹介してもらった', ''], ['友達のミキさんが昨日来た', ''],
    ['ミキさんって知ってる', ''], ['ミキさんは元気かな', ''], ['この前ケンさんを紹介された', ''],
    // Ordinary sentences that look like the patterns.
    ['こちらこそ、よろしくお願いします', ''], ['こっちは雨です', ''], ['こっちがいいです', ''], ['友達の奥さんが来る', ''],
    ['犬の名前はポチです', ''], ['名前はちょっと。', ''], ['これは日本語で桜と言います', ''], ['先生って呼んでください', ''],
    ['ありがとう', 'お名前、聞いてもいいですか？'], ['わからない', 'お名前、聞いてもいいですか？'],
    ['あとで', 'お名前、聞いてもいいですか？'], ['いやです', 'お名前、聞いてもいいですか？'],
  ])('%s establishes no name', (utterance, previous) => {
    expect(establishedGuestName(utterance, previous)).toBeNull();
  });

  it('matches names without honorifics and across kana', () => {
    expect(personNameKey('ミキさん')).toBe(personNameKey('みき'));
    expect(personNameKey('Ken')).toBe(personNameKey('ken'));
    expect(personNameKey('ミキ')).not.toBe(personNameKey('ミカ'));
  });
});

describe('remembering a friend from a 「友人も一緒」 call', () => {
  it('creates a person once the name is said and keeps the call with audience {owner, that person}', async () => {
    const { guestCall, overview, peopleStore } = harness();
    const { prompts, remembered } = await guestCall('call-0001', mikiCall);
    expect(prompts[0]).toContain('No name has been established yet');
    expect(prompts[1]).toContain('ミキさん: you are meeting them for the first time today');
    expect(prompts[1]).toContain('was established by the current utterance');
    expect(prompts[1]).toContain('you will remember their name and what you talk about');
    expect(remembered?.status).toBe(201);
    expect(remembered?.body).toMatchObject({ status: 'remembered', people: [{ displayName: 'ミキ' }] });

    const { people, unnamed } = await overview();
    expect(unnamed).toEqual([]);
    expect(people).toHaveLength(1);
    const miki = people[0]!;
    expect(miki).toMatchObject({ displayName: 'ミキ', forgotten: false, howKnown: '「友人も一緒」の通話で名前を聞いた' });
    expect(miki.lastTalkedAt).toBeDefined();
    const kinds = miki.items.map(item => item.kind);
    expect(kinds).toContain('summary');
    expect(kinds).toContain('fact');
    expect(kinds).toContain('promise');
    expect(kinds).toContain('topic');
    expect(kinds).not.toContain('turn');
    expect(miki.items.find(item => item.kind === 'summary')?.text).toContain('好きな食べ物と映画の話');
    expect(miki.items.find(item => item.kind === 'fact')).toMatchObject({ text: 'ミキさんは辛いものが苦手', audience: 'ミキさんと一緒の時',
      sensitivity: 'sensitive', status: 'active' });
    // The exchanges are kept as text for recall, the same way owner turns are; no audio exists anywhere.
    const stored = peopleStore.items('owner');
    expect(stored.filter(item => item.kind === 'turn').length).toBe(mikiCall.length);
    expect(stored.every(item => item.disclosure.audience?.kind === 'people' && item.disclosure.audience.personIds.length === 1)).toBe(true);
    peopleStore.close();
  });

  it('(d) never turns a friend\'s statement into an owner fact, promise, goal, experience or message', async () => {
    const { api, guestCall, state, conversations, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    await api.waitForBackground('owner');
    const snapshot = state.snapshot('owner');
    expect(snapshot.userFacts).toEqual([]);
    expect(snapshot.relationships).toEqual([]);
    expect(snapshot.prospectiveMemories).toEqual([]);
    expect(snapshot.interests).toEqual([]);
    expect(conversations.experienceCandidates('owner')).toEqual([]);
    expect(conversations.conversationHistory('owner', 'thread')).toEqual([]);
    const cognition = await api.dispatch({ method: 'GET', path: '/v1/cognition', query: new URLSearchParams({ scopeKey: 'owner' }) });
    expect(cognition.body).toMatchObject({ intents: [] });
    const memories = await api.dispatch({ method: 'GET', path: '/v1/memories', query: new URLSearchParams({ scopeKey: 'owner' }) });
    expect(JSON.stringify(memories.body)).not.toContain('辛いもの');
    peopleStore.close();
  });

  it('uses a deterministic summary when the model fails or quotes speech', async () => {
    const { model, guestCall, overview, peopleStore } = harness();
    model.summary = new Error('model unavailable');
    await guestCall('call-0001', mikiCall);
    expect((await overview()).people[0]?.items.find(item => item.kind === 'summary')?.text).toContain('相手: ミキさん');
    model.summary = '相手: ミキさん\n話したこと: 私は辛いものが苦手。明日映画に行こうねと言った。\n次に話したいこと: 特になし';
    await guestCall('call-0002', ['ミキと言います', '私は辛いものが苦手。明日映画に行こうね']);
    const summaries = (await overview()).people[0]!.items.filter(item => item.kind === 'summary').map(item => item.text);
    expect(summaries.every(text => !text.includes('明日映画に行こうねと言った'))).toBe(true);
    peopleStore.close();
  });

  it('keeps a call whose guest never gave a name for the owner alone', async () => {
    const { guestCall, overview, chat, peopleStore } = harness();
    await guestCall('call-0001', ['こんにちは', 'カピバラ温泉の話、面白かったね']);
    const first = await overview();
    expect(first.people).toEqual([]);
    expect(first.unnamed.map(item => item.audience)).toContain('名前を聞いていない方と一緒の時');
    expect(first.unnamed.every(item => item.sensitivity === 'sensitive')).toBe(true);
    expect(await chat('さっき誰と何を話した？')).toContain('名前を聞いていない方と一緒の時');
    // Another unnamed guest, and a named one, hear nothing of it.
    const later = await guestCall('call-0002', ['こんにちは', '温泉の話って何？', 'ケンと言います', '温泉の話って何？'], { remember: false });
    for (const prompt of later.prompts) expect(prompt).not.toContain('カピバラ温泉');
    peopleStore.close();
  });

  it('stores nothing for a client that sends no call id', async () => {
    const { post, model, overview, peopleStore } = harness();
    await post(delegations, { threadId: 'thread', transcript: 'はじめまして、ミキと言います', participantMode: 'guest', deviceContext: {
      timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: 'old-1', text: 'はじめまして、ミキと言います', source: 'speech', callContext: { turns: [], introductionStart: true } } } });
    expect(promptOf(model.last)).toContain('This call is not being recorded in memory');
    // That client's own notice says no owner memory is used, so none is given to it.
    expect(promptOf(model.last)).not.toContain('[この場で使ってよいライ氏についての記憶]');
    expect(promptOf(model.last)).not.toContain('[Current cognitive context');
    expect(await overview()).toEqual({ people: [], unnamed: [] });
    expect((await post(calls, { turns: [{ role: 'participant', text: 'こんにちは' }] })).status).toBe(400);
    peopleStore.close();
  });
});

describe('using what she remembers', () => {
  it('greets a returning person as someone she has met and recalls what they talked about', async () => {
    const { guestCall, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    const second = await guestCall('call-0002', ['友達のミキさんを紹介するね', '前に何を話したっけ？'], { remember: false });
    for (const prompt of second.prompts) {
      expect(prompt).toContain('ミキさん: you have talked with them before');
      expect(prompt).toContain('「ミキさん、また会えましたね」');
      expect(prompt).toContain('ミキさんは辛いものが苦手');
      expect(prompt).toContain('好きな食べ物と映画の話');
      expect(prompt).not.toContain('you are meeting them for the first time');
    }
    expect(peopleStore.listPeople('owner')).toHaveLength(1);
    peopleStore.close();
  });

  it('(c) what was said with A is open with A, and marked as A\'s when only B or an unnamed guest is present', async () => {
    const { guestCall, chat, peopleStore } = harness();
    await chat('実は借金があって、ミズクラゲ銀行のローンを返している');
    await guestCall('call-0001', mikiCall);
    const withB = await guestCall('call-0002', ['はじめまして、ケンと言います', 'ミキさんってどんな人？苦手なものは？'], { remember: false });
    const guarded = '【機微:ほかの人のこと・別の人と一緒の時に聞いた】[ミキさんと一緒の時] ミキさんは辛いものが苦手';
    expect(withB.prompts[1]).toContain(guarded);
    for (const prompt of withB.prompts) {
      expect(prompt).toContain('[Speak-time privacy check');
      // Nothing about ミキ is listed as what Shannon talked about with the person who is here.
      expect(prompt).not.toContain('What you talked about with ミキさん before');
      expect(prompt).not.toMatch(/(?<!】\[ミキさんと一緒の時\] )ミキさんは辛いものが苦手/u);
    }
    const unnamed = await guestCall('call-0003', ['こんにちは', 'ミキさんの苦手な食べ物って何？'], { remember: false });
    expect(unnamed.prompts[1]).toContain(guarded);
    const withA = await guestCall('call-0004', ['ミキと言います', '苦手な食べ物の話、前にした？'], { remember: false });
    expect(withA.prompts[1]).toContain('What you talked about with ミキさん before');
    expect(withA.prompts[1]).toMatch(/\(\d{4}-\d{2}-\d{2} ミキさんと一緒の時\) ミキさんは辛いものが苦手/u);
    expect(withA.prompts[1]).not.toContain('【機微:ほかの人のこと');
    // A protected one-to-one item never appears unmarked, even when a remembered person is present.
    for (const prompt of withA.prompts) expect(prompt).not.toMatch(/(?<!】)ユーザー: 実は借金/u);
    peopleStore.close();
  });

  it('answers the owner alone with provenance: who, when, and what', async () => {
    const { guestCall, chat, conversations, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    const recent = await chat('さっき誰と何を話した？');
    expect(recent).toContain('[人についての記憶');
    expect(recent).toContain('ミキさんと一緒の時');
    expect(recent).toContain('好きな食べ物と映画の話');
    expect(recent).toContain('いつ・誰と一緒の時の話かを添えて答える');
    expect(recent).toContain('ライ氏自身の事実・約束・目的ではない');
    const about = await chat('ミキさんってどんな人？');
    expect(about).toContain('名前が出た人: ミキさん');
    expect(about).toContain('ミキさんは辛いものが苦手');
    // The reply records which person memories it used, so forgetting can find it later.
    expect(conversations.experienceCandidates('owner').at(-1)?.recalledMemoryIds?.some(id => id.startsWith('person:'))).toBe(true);
    const nobody = harness();
    expect(await nobody.chat('さっき誰と何を話した？')).toContain('(該当する記憶なし)');
    nobody.peopleStore.close();
    peopleStore.close();
  });

  it('asks rather than guesses when two remembered people share a name', async () => {
    const { guestCall, act, overview, peopleStore } = harness();
    await guestCall('call-0001', ['ケンと言います', '私はラーメンが好き']);
    await guestCall('call-0002', ['タクと言います', '私は釣りが好き']);
    const taku = (await overview()).people.find(person => person.displayName === 'タク')!;
    expect((await act({ action: 'rename', personId: taku.id, displayName: 'ケン' })).status).toBe(200);
    const third = await guestCall('call-0003', ['ケンと言います', '前に何が好きって言ったっけ？']);
    for (const prompt of third.prompts) {
      expect(prompt).toContain('you remember more than one person with that name');
      expect(prompt).not.toContain('ラーメンが好き');
      expect(prompt).not.toContain('釣りが好き');
    }
    // Unresolved, the call is kept as an unnamed guest's: usable only by the owner alone.
    const after = await overview();
    expect(after.people).toHaveLength(2);
    expect(after.unnamed.length).toBeGreaterThan(0);
    peopleStore.close();
  });
});

describe('review regressions', () => {
  it('mentioning a remembered person who is absent does not make them present', async () => {
    const { guestCall, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    const other = await guestCall('call-0002', ['こんにちは', '友達のミキさんが転職したらしい', 'ミキさんの苦手なものって何？'], { remember: false });
    for (const prompt of other.prompts) {
      expect(prompt).not.toContain('you have talked with them before');
      expect(prompt).not.toContain('What you talked about with ミキさん before');
      expect(prompt).toContain('No name has been established yet');
    }
    expect(peopleStore.listPeople('owner')).toHaveLength(1);
    peopleStore.close();
  });

  it('a discard that arrives while the summary is being written wins', async () => {
    const { model, guestCall, post, overview, peopleStore } = harness();
    const { turns } = await guestCall('call-0001', mikiCall, { remember: false });
    const original = model.generateVoice.bind(model);
    model.generateVoice = async request => {
      if (promptOf(request).startsWith('You write Shannon\'s own short memory')) {
        await post('/v1/voice/gemini/cascade/calls/discard', { callId: 'call-0001' });
      }
      return original(request);
    };
    const late = await post(calls, { callId: 'call-0001', threadId: 'thread', turns });
    expect(late.status).toBe(409);
    expect(await overview()).toEqual({ people: [], unnamed: [] });
    expect(peopleStore.items('owner')).toEqual([]);
    expect(peopleStore.listPeople('owner')).toEqual([]);
    peopleStore.close();
  });

  it('saving the same period again keeps a forgotten item forgotten and the owner\'s ふつう', async () => {
    const { guestCall, post, overview, act, peopleStore } = harness();
    const { turns } = await guestCall('call-0001', mikiCall);
    const before = (await overview()).people[0]!.items;
    const fact = before.find(item => item.kind === 'fact')!;
    const promise = before.find(item => item.kind === 'promise')!;
    await act({ action: 'forget-item', itemId: fact.id });
    await act({ action: 'mark-ordinary', itemId: promise.id });
    expect((await post(calls, { callId: 'call-0001', threadId: 'thread', turns })).status).toBe(201);
    const after = (await overview()).people[0]!.items;
    expect(after.map(item => item.id).sort()).toEqual(before.map(item => item.id).sort());
    expect(after.find(item => item.id === fact.id)?.status).toBe('forgotten');
    expect(after.find(item => item.id === promise.id)).toMatchObject({ sensitivity: 'ordinary', decidedBy: 'owner' });
    peopleStore.close();
  });

  it('a person named earlier in the call and then forgotten leaves the call with an unknown guest', async () => {
    const { guestCall, overview, act, chat, peopleStore } = harness();
    await chat('私は紅茶が好き');
    await guestCall('call-0001', mikiCall);
    const miki = (await overview()).people[0]!;
    const second = await guestCall('call-0002', ['ミキと言います'], { remember: false });
    expect(second.prompts[0]).toContain('ミキさんは辛いものが苦手');
    await act({ action: 'forget-person', personId: miki.id });
    const after = await guestCall('call-0002', ['苦手な食べ物の話、前にした？'], { remember: false });
    expect(after.prompts[0]).not.toContain('辛いものが苦手');
    expect(after.prompts[0]).toContain('No name has been established yet');
    peopleStore.close();
  });

  it('a name from a period that was never saved is not listed as a person', async () => {
    const { guestCall, overview, peopleStore } = harness();
    await guestCall('call-0001', mikiCall, { remember: false });
    expect(peopleStore.listPeople('owner')).toHaveLength(1);
    expect(await overview()).toEqual({ people: [], unnamed: [] });
    peopleStore.close();
  });
});

describe('the owner\'s controls under 人', () => {
  it('(e) forgetting one item withholds it everywhere and restoring brings it back', async () => {
    const { guestCall, chat, overview, act, state, conversations, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    expect(await chat('ミキさんってどんな人？')).toContain('ミキさんは辛いものが苦手');
    const fact = (await overview()).people[0]!.items.find(item => item.kind === 'fact')!;
    expect((await act({ action: 'forget-item', itemId: fact.id })).status).toBe(200);
    expect((await overview()).people[0]!.items.find(item => item.id === fact.id)?.status).toBe('forgotten');
    expect(await chat('ミキさんってどんな人？', 'second-thread')).not.toContain('ミキさんは辛いものが苦手');
    const withA = await guestCall('call-0002', ['ミキと言います', '苦手な食べ物の話、前にした？'], { remember: false });
    for (const prompt of withA.prompts) expect(prompt).not.toContain('ミキさんは辛いものが苦手');
    // The reply that was generated from the forgotten item is no longer fed back as history.
    expect(visibleConversationHistory(state.snapshot('owner'), conversations, 'owner', 'owner-thread', OWNER_AUDIENCE)
      .filter(message => message.role === 'assistant')).toHaveLength(0);

    expect((await act({ action: 'restore-item', itemId: fact.id })).status).toBe(200);
    expect(await chat('ミキさんってどんな人？', 'third-thread')).toContain('ミキさんは辛いものが苦手');
    expect(visibleConversationHistory(state.snapshot('owner'), conversations, 'owner', 'owner-thread', OWNER_AUDIENCE)
      .filter(message => message.role === 'assistant')).toHaveLength(1);
    peopleStore.close();
  });

  it('(e) forgetting a person withholds everything about them and restoring brings it back', async () => {
    const { guestCall, chat, overview, act, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    const miki = (await overview()).people[0]!;
    expect((await act({ action: 'forget-person', personId: miki.id })).status).toBe(200);
    const forgotten = (await overview()).people[0]!;
    expect(forgotten.forgotten).toBe(true);
    expect(forgotten.items.every(item => item.status === 'forgotten')).toBe(true);
    const alone = await chat('ミキさんってどんな人？さっき誰と何を話した？');
    expect(alone).not.toContain('辛いものが苦手');
    expect(alone).not.toContain('好きな食べ物と映画の話');
    // The same name in a later call is a stranger: nothing is recalled and no returning greeting is given.
    const again = await guestCall('call-0002', ['ミキと言います', '前に何を話したっけ？'], { remember: false });
    for (const prompt of again.prompts) {
      expect(prompt).not.toContain('辛いものが苦手');
      expect(prompt).not.toContain('you have talked with them before');
    }
    expect((await act({ action: 'restore-person', personId: miki.id })).status).toBe(200);
    const restored = (await overview()).people.find(person => person.id === miki.id)!;
    expect(restored.forgotten).toBe(false);
    expect(restored.items.every(item => item.status === 'active')).toBe(true);
    expect(await chat('ミキさんってどんな人？', 'later-thread')).toContain('ミキさんは辛いものが苦手');
    peopleStore.close();
  });

  it('renames, keeps the old name as an alias, and merges two records', async () => {
    const { guestCall, overview, act, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    await guestCall('call-0002', ['美紀と言います', '私は猫が好き']);
    let { people } = await overview();
    expect(people.map(person => person.displayName).sort()).toEqual(['ミキ', '美紀']);
    const kana = people.find(person => person.displayName === 'ミキ')!;
    const kanji = people.find(person => person.displayName === '美紀')!;
    expect((await act({ action: 'merge', personId: kanji.id, intoPersonId: kana.id })).status).toBe(200);
    ({ people } = await overview());
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: kana.id, displayName: 'ミキ', aliases: ['美紀'] });
    expect(people[0]!.items.map(item => item.text).join('\n')).toContain('猫が好き');
    expect(people[0]!.items.every(item => item.audience === 'ミキさんと一緒の時')).toBe(true);
    expect((await act({ action: 'rename', personId: kana.id, displayName: 'ミキ子さん' })).status).toBe(200);
    expect((await overview()).people[0]).toMatchObject({ displayName: 'ミキ子', aliases: ['美紀', 'ミキ'] });
    // Either earlier name still finds the same person.
    const next = await guestCall('call-0003', ['美紀と言います'], { remember: false });
    expect(next.prompts[0]).toContain('ミキ子さん: you have talked with them before');
    expect((await act({ action: 'merge', personId: 'missing', intoPersonId: kana.id })).status).toBe(404);
    expect((await act({ action: 'explode', personId: kana.id })).status).toBe(400);
    peopleStore.close();
  });

  it('lets the owner mark a person memory ふつう so it may be mentioned to others', async () => {
    const { guestCall, overview, act, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    const fact = (await overview()).people[0]!.items.find(item => item.kind === 'fact')!;
    expect(fact).toMatchObject({ sensitivity: 'sensitive', decidedBy: 'rule' });
    expect(fact.reason).toContain('ほかの人のこと');
    expect((await act({ action: 'mark-ordinary', itemId: fact.id })).status).toBe(200);
    expect((await overview()).people[0]!.items.find(item => item.id === fact.id)).toMatchObject({ sensitivity: 'ordinary', decidedBy: 'owner' });
    const withB = await guestCall('call-0002', ['ケンと言います', '辛いものが苦手な人っている？'], { remember: false });
    expect(withB.prompts[1]).toContain('ミキさんは辛いものが苦手');
    peopleStore.close();
  });
});

describe('(g) 「今回は残さない」 leaves nothing', () => {
  it('removes the call\'s items and the person it created, and a late save stores nothing', async () => {
    const { guestCall, post, overview, chat, peopleStore, path, state } = harness();
    const { turns } = await guestCall('call-0001', mikiCall);
    expect((await overview()).people).toHaveLength(1);
    expect((await post('/v1/voice/gemini/cascade/calls/discard', { callId: 'call-0001' })).body).toEqual({ callId: 'call-0001', discarded: true });

    expect(await overview()).toEqual({ people: [], unnamed: [] });
    const raw = new DatabaseSync(path);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM person_memory_items').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM people').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT call_id, thread_id, status, person_ids_json, created_person_ids_json, pending_name FROM person_calls').all())
      .toEqual([{ call_id: 'call-0001', thread_id: null, status: 'discarded', person_ids_json: '[]', created_person_ids_json: '[]', pending_name: null }]);
    raw.close();
    expect(JSON.stringify(state.snapshot('owner'))).not.toContain('辛いもの');
    expect(await chat('さっき誰と何を話した？ミキさんってどんな人？')).toContain('(該当する記憶なし)');

    // The same period arriving again (a retry, or a save that lost the race) is refused.
    const late = await post(calls, { callId: 'call-0001', threadId: 'thread', turns });
    expect(late.status).toBe(409);
    expect(await overview()).toEqual({ people: [], unnamed: [] });
    peopleStore.close();
  });

  it('keeps a person who was already remembered from an earlier call', async () => {
    const { guestCall, post, overview, peopleStore } = harness();
    await guestCall('call-0001', mikiCall);
    await guestCall('call-0002', ['ミキと言います', '私は猫が好き']);
    await post('/v1/voice/gemini/cascade/calls/discard', { callId: 'call-0002' });
    const { people } = await overview();
    expect(people).toHaveLength(1);
    expect(people[0]!.items.map(item => item.text).join('\n')).not.toContain('猫が好き');
    expect(people[0]!.items.map(item => item.text).join('\n')).toContain('辛いものが苦手');
    peopleStore.close();
  });

  it('discarding before the period was saved also blocks the save', async () => {
    const { guestCall, post, overview, peopleStore } = harness();
    const { turns } = await guestCall('call-0001', mikiCall, { remember: false });
    await post('/v1/voice/gemini/cascade/calls/discard', { callId: 'call-0001' });
    expect((await post(calls, { callId: 'call-0001', turns })).status).toBe(409);
    expect(await overview()).toEqual({ people: [], unnamed: [] });
    peopleStore.close();
  });
});

describe('storage', () => {
  it('survives a restart and shares the people table with the identity registry without changing it', async () => {
    const first = harness();
    await first.guestCall('call-0001', mikiCall);
    first.peopleStore.close();
    const registry = new SQLitePersonIdentityStore(first.path);
    const candidate = registry.createCandidate('owner', { displayName: 'Discordの人', platform: 'discord', externalUserId: '12345' }, first.now());
    expect(registry.list('owner').map(person => person.displayName).sort()).toEqual(['Discordの人', 'ミキ']);
    const reopened = new SQLitePeopleMemoryStore(first.path);
    // An unconfirmed platform identity is not someone Shannon has met.
    expect(reopened.listPeople('owner').map(person => person.displayName)).toEqual(['ミキ']);
    expect(reopened.items('owner').length).toBeGreaterThan(0);
    registry.confirm('owner', candidate.id, 'discord', 1, first.now());
    expect(reopened.listPeople('owner').map(person => person.displayName).sort()).toEqual(['Discordの人', 'ミキ']);
    registry.close();
    reopened.close();
  });
});
