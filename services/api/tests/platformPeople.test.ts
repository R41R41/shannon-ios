import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { PeopleMemoryOverview } from '../src/apiPeopleMemoryRoutes.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { SQLitePersonIdentityStore } from '../src/mind/memory/store/personIdentity.js';
import { configuredPlatformBridge, PlatformBridgeError, PlatformBridgeService, platformBridgeThreadId } from '../src/surfaces/platform/platformBridge.js';
import { DEFAULT_PLATFORM_PEOPLE_LIMITS, PlatformPeople, platformPeopleEnabled } from '../src/surfaces/platform/platformPeople.js';
import { PlatformConversationSummarizer, acceptedPlatformSummary } from '../src/surfaces/platform/platformPeopleSummaries.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';

const fixtures = join(import.meta.dirname, 'fixtures/platform-people-v1');
const fixture = <T extends object = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as T;
const OWNER = '900000000000000001';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  get last() { return this.all.at(-1)!; }
  async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'わかりました。' }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
}

function harness(options: { enabled?: boolean; limits?: Partial<typeof DEFAULT_PLATFORM_PEOPLE_LIMITS> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-platform-people-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  let clock = Date.parse('2026-10-02T04:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const configuration = configuredPlatformBridge({ SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
    SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(fixture('bindings.json')) })!;
  let enabled = options.enabled ?? true;
  const platformPeople = new PlatformPeople(peopleStore, store, { ...DEFAULT_PLATFORM_PEOPLE_LIMITS, ...options.limits });
  const bridge = new PlatformBridgeService(configuration, store, store, background, now, platformPeople, () => enabled);
  const model = new RecordingModel();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store,
    background, peopleMemory: peopleStore });
  const overview = async () => (await api.dispatch({ method: 'GET', path: '/v1/people/memory',
    query: new URLSearchParams({ scopeKey: 'owner' }) })).body as PeopleMemoryOverview;
  const chat = async (message: string, threadId = 'owner-thread') => {
    clock += 1_000;
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId, message } });
    await api.waitForBackground('owner');
    return promptOf(model.last);
  };
  const errorCode = (operation: () => unknown) => { try { operation(); return 'none'; } catch (error) {
    return error instanceof PlatformBridgeError ? `${error.status} ${error.code}` : String(error); } };
  const close = async () => {
    await api.waitForBackground('owner');
    await background.waitForIdle('owner');
    await new Promise(resolve => setImmediate(resolve));
    await background.waitForIdle('owner');
    peopleStore.close(); store.close();
  };
  return { path, store, peopleStore, bridge, platformPeople, api, model, overview, chat, background, errorCode, close, now,
    advance: (milliseconds: number) => { clock += milliseconds; }, setEnabled: (value: boolean) => { enabled = value; } };
}

describe('contract: the requests in docs/platform-people-contract.md', () => {
  it('the document shows the fixtures verbatim and names every field, error and reason the server uses', () => {
    const document = readFileSync(join(import.meta.dirname, '../../../docs/platform-people-contract.md'), 'utf8');
    for (const name of ['owner-turn.request.json', 'person-turn.request.json', 'context.request.json']) {
      expect(document).toContain(`\`\`\`json\n${JSON.stringify(fixture(name), null, 2)}\n\`\`\``);
    }
    for (const name of ['person-turn.request.json', 'overheard-turn.request.json', 'bot-turn.request.json', 'dm-turn.request.json',
      'context.request.json', 'dm-context.request.json', 'person-turn.response.json', 'bot-turn.response.json']) {
      for (const field of Object.keys(fixture(name))) expect(document).toContain(`\`${field}\``);
    }
    for (const word of ['BAD_REQUEST', 'PLATFORM_BRIDGE_UNAUTHORIZED', 'PLATFORM_CONVERSATION_DENIED', 'PLATFORM_ACTOR_DENIED',
      'PLATFORM_PEOPLE_DISABLED', 'PLATFORM_TURN_CONFLICT', 'RATE_LIMITED', 'PLATFORM_BRIDGE_NOT_CONFIGURED',
      'conversation_cap', 'daily_cap', 'forgotten_person', 'SHANNON_PLATFORM_PEOPLE_INGEST']) expect(document).toContain(word);
  });

  it('today\'s owner turn keeps working unchanged and is stored exactly as before', async () => {
    const { bridge, store, peopleStore, background, close } = harness();
    const request = fixture('owner-turn.request.json');
    const first = bridge.ingest(request);
    await background.waitForIdle('owner');
    expect(Object.keys(first).sort()).toEqual(['duplicate', 'experienceId', 'threadId']);
    expect(first).toMatchObject({ duplicate: false, threadId: platformBridgeThreadId('discord', 'discord:111:222') });
    expect(bridge.ingest(request)).toEqual({ ...first, duplicate: true });
    expect(store.conversationHistory('owner', first.threadId).map(message => message.content)).toEqual(['今日はここまでにするね', 'お疲れさまでした、ライ氏。']);
    expect(peopleStore.listPeople('owner')).toEqual([]);
    // Today's context request, without any of the new fields.
    const context = bridge.context({ platform: 'discord', conversationId: 'discord:111:222', sourceUserId: OWNER });
    expect(Object.keys(context).sort()).toEqual(['projection', 'schemaVersion', 'stateVersion', 'updatedAt']);
    await close();
  });

  it('a person\'s turn answers with the documented shape, is idempotent, and conflicts on changed content', async () => {
    const { bridge, errorCode, close } = harness();
    const request = fixture('person-turn.request.json');
    const expected = fixture<Record<string, unknown>>('person-turn.response.json');
    const first = bridge.ingest(request);
    expect(Object.keys(first).sort()).toEqual(Object.keys(expected).sort());
    expect(first.duplicate).toBe(false);
    expect(first.threadId).toMatch(/^platform:discord:[0-9a-f]{32}$/u);
    expect(first.experienceId).toMatch(/^pt-[0-9a-f]{32}$/u);
    expect(bridge.ingest(request)).toMatchObject({ duplicate: true, experienceId: first.experienceId, threadId: first.threadId });
    expect(errorCode(() => bridge.ingest({ ...request, userMessage: '別の内容' }))).toBe('409 PLATFORM_TURN_CONFLICT');
    const bot = bridge.ingest(fixture('bot-turn.request.json'));
    expect(bot).toEqual({ ...fixture('bot-turn.response.json'), threadId: first.threadId });
    await close();
  });

  it('refuses what the contract says it refuses', async () => {
    const { bridge, errorCode, setEnabled, close } = harness();
    const person = fixture('person-turn.request.json');
    expect(errorCode(() => bridge.ingest({ ...person, conversationId: 'discord:999:1' }))).toBe('403 PLATFORM_CONVERSATION_DENIED');
    // The shape that has always been refused: someone else's id without the new fields.
    const { conversationKind: _kind, sourceDisplayName: _name, sourceKind: _source, ...bare } = person;
    expect(errorCode(() => bridge.ingest(bare))).toBe('403 PLATFORM_ACTOR_DENIED');
    expect(errorCode(() => bridge.ingest({ ...person, attachments: [{ url: 'https://example.invalid/a.png' }] }))).toBe('400 BAD_REQUEST');
    expect(errorCode(() => bridge.ingest({ ...person, conversationKind: 'thread' }))).toBe('400 BAD_REQUEST');
    expect(errorCode(() => bridge.ingest({ ...person, sourceKind: 'webhook' }))).toBe('400 BAD_REQUEST');
    expect(errorCode(() => bridge.ingest({ ...person, userMessage: 'あ'.repeat(8_001) }))).toBe('400 BAD_REQUEST');
    // A friend cannot write into the owner's private DM.
    expect(errorCode(() => bridge.ingest({ ...person, conversationId: 'dm:owner', conversationKind: 'dm' }))).toBe('403 PLATFORM_ACTOR_DENIED');
    setEnabled(false);
    expect(errorCode(() => bridge.ingest({ ...person, requestId: 'discord:off' }))).toBe('403 PLATFORM_PEOPLE_DISABLED');
    expect(errorCode(() => bridge.context(fixture('dm-context.request.json')))).toBe('403 PLATFORM_ACTOR_DENIED');
    // The owner's own turns are unaffected by the switch.
    expect(bridge.ingest(fixture('owner-turn.request.json')).duplicate).toBe(false);
    expect(platformPeopleEnabled({})).toBe(true);
    expect(platformPeopleEnabled({ SHANNON_PLATFORM_PEOPLE_INGEST: 'off' })).toBe(false);
    await close();
  });
});

describe('people from a platform conversation', () => {
  it('creates the person on first sight and keeps what they said as theirs, never as the owner\'s', async () => {
    const { bridge, store, peopleStore, api, overview, background, close } = harness();
    const result = bridge.ingest(fixture('person-turn.request.json'));
    bridge.ingest(fixture('overheard-turn.request.json'));
    await background.waitForIdle('owner');
    await api.waitForBackground('owner');
    const { people, unnamed } = await overview();
    expect(unnamed).toEqual([]);
    expect(people.map(person => person.displayName).sort()).toEqual(['ケン', 'ミキ']);
    const miki = people.find(person => person.displayName === 'ミキ')!;
    expect(miki).toMatchObject({ id: result.personId, howKnown: 'Discordで会った人', sources: ['Discord'], forgotten: false, mergeSuggestions: [] });
    // The conversation she was part of went on for another minute.
    expect(miki.lastTalkedAt).toBe('2026-10-02T03:02:00.000Z');
    const fact = miki.items.find(item => item.kind === 'fact')!;
    expect(fact).toMatchObject({ text: 'ミキさんは辛いものが苦手', audience: '友人グループ（Discord）で話した時', sensitivity: 'sensitive' });
    expect(miki.items.map(item => item.kind)).toEqual(expect.arrayContaining(['summary', 'fact', 'promise']));
    expect(miki.items.find(item => item.kind === 'summary')?.text).toContain('友人グループ（Discord）で2件のやり取り');
    // The conversation is the audience of everything kept from it.
    const key = platformBridgeThreadId('discord', 'discord:111:222');
    expect(peopleStore.items('owner').every(item => item.disclosure.audience?.kind === 'group' && item.disclosure.audience.groupKey === key)).toBe(true);
    // Nothing of it is the owner's.
    const snapshot = store.snapshot('owner');
    expect(snapshot.userFacts).toEqual([]);
    expect(snapshot.prospectiveMemories).toEqual([]);
    expect(snapshot.relationships).toEqual([]);
    expect(store.experienceCandidates('owner')).toEqual([]);
    expect(store.listThreads('owner')).toEqual([]);
    expect(store.dailyUserMessages('owner', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toEqual([]);
    const cognition = await api.dispatch({ method: 'GET', path: '/v1/cognition', query: new URLSearchParams({ scopeKey: 'owner' }) });
    expect(cognition.body).toMatchObject({ intents: [] });
    await close();
  });

  it('identifies by the platform user id: a renamed account is the same person, the same name on another account is not', async () => {
    const { bridge, overview, peopleStore, close } = harness();
    const person = fixture('person-turn.request.json');
    const first = bridge.ingest(person);
    const renamed = bridge.ingest({ ...person, requestId: 'discord:2001', sourceDisplayName: 'ミキティ', userMessage: '名前を変えたよ' });
    expect(renamed.personId).toBe(first.personId);
    const other = bridge.ingest({ ...person, requestId: 'discord:2002', sourceUserId: '900000000000000077', userMessage: 'はじめまして' });
    expect(other.personId).not.toBe(first.personId);
    const { people } = await overview();
    expect(people.find(entry => entry.id === first.personId)).toMatchObject({ displayName: 'ミキティ', aliases: ['ミキ'] });
    // Same name, different accounts: a suggestion for the owner, never an automatic merge.
    expect(people.find(entry => entry.id === first.personId)?.mergeSuggestions.map(entry => entry.personId)).toEqual([other.personId]);
    expect(peopleStore.platformLinks('owner')).toHaveLength(2);
    await close();
  });

  it('never merges with a person met by voice; the owner merges, and later messages follow the merged person', async () => {
    const { bridge, api, overview, act, close } = (() => {
      const base = harness();
      const act = (body: Record<string, unknown>) => base.api.dispatch({ method: 'POST', path: '/v1/people/memory/action', body: { scopeKey: 'owner', ...body } });
      return { ...base, act };
    })();
    // Met by voice first.
    const turns = [{ role: 'participant', text: 'ミキと言います' }, { role: 'shannon', text: 'ミキさん、よろしくお願いします。' }];
    const delegate = (transcript: string, earlier: unknown[]) => api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: 'owner', threadId: 'thread', transcript, participantMode: 'guest', deviceContext: { timeZoneIdentifier: 'Asia/Tokyo',
        requestedLocation: false, location: null, userUtterance: { id: transcript, text: transcript, source: 'speech',
          callContext: { callId: 'call-voice-0001', turns: earlier, introductionStart: true } } } } });
    await delegate('ミキと言います', []);
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/calls', body: { scopeKey: 'owner', callId: 'call-voice-0001', turns } });
    const discord = bridge.ingest(fixture('person-turn.request.json'));

    let { people } = await overview();
    expect(people).toHaveLength(2);
    const voice = people.find(person => person.sources.includes('音声'))!;
    const platform = people.find(person => person.id === discord.personId)!;
    expect(voice.id).not.toBe(platform.id);
    expect(voice.mergeSuggestions).toEqual([{ personId: platform.id, displayName: 'ミキ', sources: ['Discord'] }]);
    expect(platform.mergeSuggestions).toEqual([{ personId: voice.id, displayName: 'ミキ', sources: ['音声'] }]);

    expect((await act({ action: 'merge', personId: platform.id, intoPersonId: voice.id })).status).toBe(200);
    ({ people } = await overview());
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: voice.id, sources: ['Discord', '音声'], mergeSuggestions: [] });
    const later = bridge.ingest({ ...fixture('person-turn.request.json'), requestId: 'discord:3001', userMessage: '私は猫が好き' });
    expect(later.personId).toBe(voice.id);
    expect((await overview()).people[0]!.items.map(item => item.text).join('\n')).toContain('ミキさんは猫が好き');
    await close();
  });

  it('uses an account the owner registered beforehand, and records a candidate identity for a new one', async () => {
    const { bridge, path, peopleStore, close, now } = harness();
    const registry = new SQLitePersonIdentityStore(path);
    const registered = registry.createCandidate('owner', { displayName: '登録済みのケン', platform: 'discord', externalUserId: '900000000000000003' }, now());
    registry.confirm('owner', registered.id, 'discord', 1, now());
    expect(bridge.ingest(fixture('overheard-turn.request.json')).personId).toBe(registered.id);
    const created = bridge.ingest(fixture('person-turn.request.json'));
    const identity = registry.list('owner').find(person => person.id === created.personId)?.identities[0];
    expect(identity).toMatchObject({ platform: 'discord', externalUserId: '900000000000000002', status: 'candidate' });
    expect(peopleStore.listPeople('owner').map(person => person.displayName).sort()).toEqual(['ミキ', '登録済みのケン']);
    registry.close();
    await close();
  });

  it('forgetting works across sources: an item, and a person whose later messages are then not stored', async () => {
    const { bridge, overview, api, chat, close } = harness();
    const act = (body: Record<string, unknown>) => api.dispatch({ method: 'POST', path: '/v1/people/memory/action', body: { scopeKey: 'owner', ...body } });
    const first = bridge.ingest(fixture('person-turn.request.json'));
    const fact = (await overview()).people[0]!.items.find(item => item.kind === 'fact')!;
    expect(await chat('ミキさんってどんな人？')).toContain('ミキさんは辛いものが苦手');
    await act({ action: 'forget-item', itemId: fact.id });
    expect(await chat('ミキさんってどんな人？', 'second')).not.toContain('ミキさんは辛いものが苦手');
    await act({ action: 'restore-item', itemId: fact.id });
    expect(await chat('ミキさんってどんな人？', 'third')).toContain('ミキさんは辛いものが苦手');

    await act({ action: 'forget-person', personId: first.personId });
    const after = await chat('ミキさんってどんな人？Discordで誰と何を話した？', 'fourth');
    expect(after).not.toContain('辛いものが苦手');
    expect(after).not.toContain('友人グループ（Discord）で1件のやり取り');
    const ignored = bridge.ingest({ ...fixture('person-turn.request.json'), requestId: 'discord:4001', userMessage: '私は犬が好き' });
    expect(ignored).toMatchObject({ experienceId: '', ignored: 'forgotten_person' });
    expect(JSON.stringify(await overview())).not.toContain('犬が好き');
    await act({ action: 'restore-person', personId: first.personId });
    expect(await chat('ミキさんってどんな人？', 'fifth')).toContain('ミキさんは辛いものが苦手');
    await close();
  });
});

describe('volume and safety bounds', () => {
  it('ignores bots and system messages, caps a conversation and a day, clips long text, and limits the rate', async () => {
    const { bridge, peopleStore, errorCode, advance, close } = harness({ limits: { conversationTurnsPerDay: 2, turnsPerDay: 3, messageCharacters: 20 } });
    const person = fixture('person-turn.request.json');
    const send = (index: number, extra: Record<string, unknown> = {}) => bridge.ingest({ ...person, requestId: `discord:c${index}`, userMessage: `メッセージ${index}`, ...extra });
    expect(bridge.ingest(fixture('bot-turn.request.json'))).toMatchObject({ experienceId: '', ignored: 'bot' });
    expect(send(0, { sourceKind: 'system' })).toMatchObject({ experienceId: '', ignored: 'system' });
    expect(peopleStore.listPeople('owner')).toEqual([]);
    expect(send(1, { userMessage: 'あ'.repeat(500) }).ignored).toBeUndefined();
    expect(peopleStore.items('owner').find(item => item.kind === 'turn')?.evidence).toBe('あ'.repeat(20));
    expect(send(2).ignored).toBeUndefined();
    expect(send(3)).toMatchObject({ experienceId: '', ignored: 'conversation_cap' });
    expect(send(4, { conversationId: 'discord:111:333' }).ignored).toBeUndefined();
    expect(send(5, { conversationId: 'discord:111:444' })).toMatchObject({ ignored: 'daily_cap' });
    // A capped message is still idempotent.
    expect(send(3)).toMatchObject({ duplicate: true, ignored: 'conversation_cap' });
    expect(peopleStore.items('owner').filter(item => item.kind === 'turn')).toHaveLength(3);

    const flooded = harness({ limits: { conversationTurnsPerDay: 10_000, turnsPerDay: 10_000 } });
    for (let index = 0; index < 120; index += 1) flooded.bridge.ingest({ ...person, requestId: `discord:f${index}`, userMessage: `m${index}` });
    expect(flooded.errorCode(() => flooded.bridge.ingest({ ...person, requestId: 'discord:f120' }))).toBe('429 RATE_LIMITED');
    flooded.advance(61_000);
    expect(flooded.bridge.ingest({ ...person, requestId: 'discord:f121', observedAt: flooded.now() }).ignored).toBeUndefined();
    await flooded.close();
    expect(errorCode(() => bridge.ingest(fixture('owner-turn.request.json')))).toBe('none');
    advance(0);
    await close();
  });
});

describe('using it', () => {
  it('gives a group conversation what Shannon remembers of its participants from that conversation, unmarked', async () => {
    const { bridge, chat, close } = harness();
    await chat('内緒だけど、ウォンバット会に入っている');
    await chat('私は病院が苦手');
    bridge.ingest(fixture('person-turn.request.json'));
    bridge.ingest(fixture('overheard-turn.request.json'));
    const context = bridge.context(fixture('context.request.json'));
    expect(context.projection).toContain('[Shannon shared audience]');
    expect(context.projection).toContain('[この会話にいる人についての記憶]');
    expect(context.projection).toContain('ミキさん、ケンさん');
    expect(context.projection).toContain('- (2026-10-02 友人グループ（Discord）) ミキさんは辛いものが苦手');
    expect(context.projection).toContain('ケンさんは猫が好き');
    // The owner's protected item is marked, his secret is absent.
    expect(context.projection).toContain('【機微:健康・ライ氏だけが知っている】ユーザーは病院が苦手');
    expect(context.projection).not.toContain('ウォンバット会');
    expect(context.projection.length).toBeLessThanOrEqual(2_400);
    // Another channel of the same guild is another audience: what was said there stays there (final review of 2026-10-06:
    // a person memory reaches a conversation only when everyone there heard it; before, it arrived marked).
    const elsewhere = bridge.context({ ...fixture('context.request.json'), conversationId: 'discord:111:999' });
    expect(elsewhere.projection).toContain('ミキさん、ケンさん');
    expect(elsewhere.projection).not.toContain('ミキさんは辛いものが苦手');
    // Without participants nothing about people is added.
    expect(bridge.context({ platform: 'discord', conversationId: 'discord:111:222', sourceUserId: OWNER }).projection).not.toContain('[この会話にいる人についての記憶]');
    await close();
  });

  it('a DM with a friend is that friend alone: their own DM memories only, and no protected owner content at all', async () => {
    const { bridge, chat, errorCode, close } = harness();
    await chat('私は病院が苦手');
    await chat('私は紅茶が好き');
    bridge.ingest(fixture('person-turn.request.json'));
    bridge.ingest({ ...fixture('dm-turn.request.json'), userMessage: '私はホラー映画が好き' });
    const dm = bridge.context(fixture('dm-context.request.json'));
    expect(dm.projection).toContain('ミキさんはホラー映画が好き');
    expect(dm.projection).toContain('- ユーザーは紅茶が好き');
    // What she said in the group is known to the group, not a matter for this DM; the owner is not here to release anything.
    expect(dm.projection).not.toContain('辛いものが苦手');
    expect(dm.projection).not.toContain('病院');
    expect(dm.projection).not.toMatch(/^- 【機微:/mu);
    expect(dm.stateVersion).toBe(0);
    // A stranger's DM: an unknown person, nothing but ordinary content.
    const stranger = bridge.context({ ...fixture('dm-context.request.json'), sourceUserId: '900000000000000055' });
    expect(stranger.projection).not.toContain('ミキ');
    expect(stranger.projection).not.toContain('病院');
    // A friend cannot ask for the owner's private DM projection.
    expect(errorCode(() => bridge.context({ platform: 'discord', conversationId: 'dm:owner', conversationKind: 'dm', sourceUserId: '900000000000000002' })))
      .toBe('403 PLATFORM_ACTOR_DENIED');
    await close();
  });

  it('answers the owner alone with provenance: which place, when, who', async () => {
    const { bridge, chat, store, close } = harness();
    bridge.ingest(fixture('person-turn.request.json'));
    const recent = await chat('Discordで誰と何を話した？');
    expect(recent).toContain('[人についての記憶');
    expect(recent).toContain('(2026-10-02 友人グループ（Discord）で話した時)');
    expect(recent).toContain('相手: ミキさん');
    expect(recent).not.toContain('【機微:');
    const about = await chat('ミキさんってどんな人？', 'another');
    expect(about).toContain('名前が出た人: ミキさん');
    expect(about).toContain('(2026-10-02 友人グループ（Discord）で話した時) ミキさんは辛いものが苦手');
    expect(store.experienceCandidates('owner').at(-1)?.recalledMemoryIds?.some(id => id.startsWith('person:'))).toBe(true);
    await close();
  });
});

describe('summaries by the background worker', () => {
  const window = ['2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'] as const;

  it('replaces the deterministic summary within the budget and keeps it on failure, quotation or no writer', async () => {
    const { bridge, peopleStore, platformPeople, overview, close } = harness();
    bridge.ingest(fixture('person-turn.request.json'));
    const summary = async () => (await overview()).people[0]!.items.find(item => item.kind === 'summary')!.text;
    const deterministic = await summary();
    expect(deterministic).toContain('友人グループ（Discord）で1件のやり取り');
    const usage = { cost: 0, backgroundLlmCostUsd() { return this.cost; } };
    const run = (writer: { summarize: () => Promise<string | null> } | null, budget = 1) =>
      new PlatformConversationSummarizer(peopleStore, platformPeople, writer, usage, { backgroundBudgetUsd: budget, now: () => '2026-10-02T18:00:00.000Z' })
        .consolidate('owner', ...window);

    expect(await run(null)).toEqual({ status: 'disabled', written: 0 });
    expect(await run({ summarize: async () => { throw new Error('model unavailable'); } })).toEqual({ status: 'applied', written: 0 });
    expect(await run({ summarize: async () => '私は辛いものが苦手。明日映画に行こうねと言っていた。' })).toEqual({ status: 'applied', written: 0 });
    usage.cost = 2;
    expect(await run({ summarize: async () => '食べ物の好みと映画の予定を話した。' })).toEqual({ status: 'budget', written: 0 });
    expect(await summary()).toBe(deterministic);
    usage.cost = 0;
    expect(await run({ summarize: async () => '食べ物の好みと映画の予定を話した。' })).toEqual({ status: 'applied', written: 1 });
    expect(await summary()).toBe('相手: ミキさん 話したこと: 食べ物の好みと映画の予定を話した。');
    expect(acceptedPlatformSummary('', [])).toBeNull();
    await close();
  });
});
