import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { SQLiteSurfaceTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformBridgeService, configuredPlatformBridge, platformBridgeThreadId } from '../src/mind/memory/platformBridge.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { PlatformVoiceService } from '../src/surfaces/platform/platformVoice.js';
import { splitChatSentences } from '../src/surfaces/text/chatSentenceSplitter.js';
import { VOICE_SENTENCE_CUT } from '../src/surfaces/text/chatSentenceStream.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { guestPeoplePrompt, ownerPeoplePrompt } from '../src/mind/memory/peopleMemoryPrompts.js';
import { PeopleMemory } from '../src/mind/memory/peopleMemory.js';
import { OWNER_AUDIENCE, createInitialCompanionState, disclosureFor, groupAudience, peopleAudience } from '@shannon/cognition';
import { promptOf } from './modelPrompt.js';

// Names here are made up for the test: the code never holds a real person's name.
const OWNER = '900000000000000001';
const FRIEND = '900000000000000002';
const FRIEND_TWO = '900000000000000004';
const STRANGER = '900000000000000003';
const ROOM = 'discord:111:222';
const START = '2026-10-20T12:00:00.000Z';
const BRIDGE = {
  SHANNON_PLATFORM_BRIDGE_TOKEN: 'c'.repeat(40), SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
  SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{ platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: OWNER, title: 'テスト' }]),
};

class Model implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  private result(): ShannonChatModelResult { return { mode: this.mode, model: this.model, reply: 'こんにちは。' }; }
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> { this.requests.push(request); return this.result(); }
  async generateStreaming(request: ShannonChatModelRequest, onReplyText: (text: string) => void | Promise<void>): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    await onReplyText('こんにちは。');
    return this.result();
  }
}

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** A greeting turn in a Discord call of the owner, two friends and someone she knows less, with her records of them in the older form (written with さん). */
async function greetingInput(): Promise<{ whole: string; friendSan: number; strangerSan: number }> {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-greeting-input-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const now = () => START;
  const store = new SQLiteShannonStore({ path, now });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const background = new BackgroundUpdateCoordinator(store, store);
  const model = new Model();
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background, peopleMemory: peopleStore });
  const bridge = new PlatformBridgeService(configuredPlatformBridge(BRIDGE)!, store, store, background, now, new PlatformPeople(peopleStore, store), () => true);
  const turns = new SQLiteSurfaceTurnLog(path, 'platform_voice_turns');
  const service = new PlatformVoiceService({
    scopeKey: 'owner', bridge, conversationStore: store, conversation: api, turns, now, chatModel: model, onAir: () => ({ note: 'テスト用のメモ' }),
    sentences: text => splitChatSentences(text, VOICE_SENTENCE_CUT), environment: () => ({ SHANNON_DC_VOICE: 'on' }), log: () => undefined,
  });
  const aki = peopleStore.createPerson('owner', { displayName: 'アキ', howKnown: 'テスト' }, START);
  const mina = peopleStore.createPerson('owner', { displayName: 'ミナ', howKnown: 'テスト' }, START);
  const yuu = peopleStore.createPerson('owner', { displayName: 'ユウ', howKnown: 'テスト' }, START);
  peopleStore.linkPlatformPerson('owner', { platform: 'discord', userId: FRIEND, personId: aki.id, displayName: 'アキ', firstSeenAt: START, lastSeenAt: START });
  peopleStore.linkPlatformPerson('owner', { platform: 'discord', userId: FRIEND_TWO, personId: mina.id, displayName: 'ミナ', firstSeenAt: START, lastSeenAt: START });
  peopleStore.linkPlatformPerson('owner', { platform: 'discord', userId: STRANGER, personId: yuu.id, displayName: 'ユウ', firstSeenAt: START, lastSeenAt: START });
  const said = (text: string) => disclosureFor(text, groupAudience(platformBridgeThreadId('discord', ROOM)));
  // What was kept before the friends were told apart: lines that call them with さん, one about each of the three.
  peopleStore.saveCall('owner', { callId: 'old-1', source: 'discord', label: 'Discord', status: 'remembered', personIds: [aki.id, mina.id, yuu.id], createdPersonIds: [], startedAt: START, updatedAt: START });
  peopleStore.replaceCallItems('owner', 'old-1', [
    { id: 'i1', kind: 'summary', text: '相手: アキさん・ミナさん・ユウさん\n話したこと: アキさんとミナさんが遊んだ話。', observedAt: START, disclosure: said('相手: アキさん・ミナさん・ユウさん\n話したこと: アキさんとミナさんが遊んだ話。') },
    { id: 'i2', kind: 'fact', personId: aki.id, text: 'アキさんは猫が好き', observedAt: START, disclosure: said('アキさんは猫が好き') },
    { id: 'i3', kind: 'fact', personId: mina.id, text: 'ミナさんはゲームが好き', observedAt: START, disclosure: said('ミナさんはゲームが好き') },
    { id: 'i4', kind: 'fact', personId: yuu.id, text: 'ユウさんは犬が好き', observedAt: START, disclosure: said('ユウさんは犬が好き') },
  ]);
  // A line kept about someone she knows less, in a call that friend was not in, that names a friend.
  peopleStore.saveCall('owner', { callId: 'old-2', source: 'discord', label: 'Discord', status: 'remembered', personIds: [yuu.id], createdPersonIds: [], startedAt: START, updatedAt: START });
  peopleStore.replaceCallItems('owner', 'old-2', [
    { id: 'i5', kind: 'fact', personId: yuu.id, text: 'ユウさんはアキさんと同じ学校だった', observedAt: START, disclosure: said('ユウさんはアキさんと同じ学校だった') },
  ]);
  await service.turn({
    platform: 'discord', requestId: 'v-1', conversationId: ROOM, voiceChannelId: '700', sourceUserId: OWNER, sourceDisplayName: 'ライ',
    userMessage: 'シャノン、挨拶して', observedAt: START, participants: [OWNER, FRIEND, FRIEND_TWO, STRANGER],
  }, () => undefined);
  await background.waitForIdle('owner');
  const request = model.requests.at(-1)!;
  const whole = [promptOf(request), JSON.stringify(request.history ?? []), request.message ?? ''].join('\n');
  turns.close(); peopleStore.close(); store.close();
  return { whole, friendSan: (whole.match(/(?:アキ|ミナ)さん/gu) ?? []).length, strangerSan: (whole.match(/ユウさん/gu) ?? []).length };
}

describe('what a greeting turn gives the reply to read (the whole input, built for real)', () => {
  it('has no 「さん」 after a listed friend, in the people block, the recalled lines and the labels, and keeps it for someone she knows less', async () => {
    vi.stubEnv('SHANNON_COMPANION_NAMES', 'アキ、ミナ');
    const { whole, friendSan, strangerSan } = await greetingInput();
    expect(whole).toContain('アキ');
    expect(friendSan).toBe(0);
    expect(strangerSan).toBeGreaterThan(0);
  });
});

describe('the people blocks of a call she is told of (友人も一緒)', () => {
  const person = (id: string, displayName: string) => ({ id, displayName, aliases: [], howKnown: 'テスト', createdAt: START, updatedAt: START }) as never;

  it('writes the listed friend by name alone and anyone else with さん, in the guest block and the owner block', () => {
    const aki = person('a', 'アキ');
    const yuu = person('b', 'ユウ');
    const guest = guestPeoplePrompt({ people: [aki, yuu], returning: [aki], newlyNamed: yuu, recorded: true, items: [], companionIds: ['a'] });
    expect(guest).toContain('- アキ: you have talked with them before');
    expect(guest).toContain('- ユウさん: you are meeting them for the first time today');
    expect(guest).toContain('The name ユウさん was established');
    expect(guest).not.toMatch(/アキさん/u);
    const owner = ownerPeoplePrompt('アキとユウ', [aki, yuu], [], shown => (shown.id === 'a' ? shown.displayName : `${shown.displayName}さん`));
    expect(owner.prompt).toContain('名前が出た人: アキ、ユウさん');
  });

  it('says a name she asks about by name alone when it is listed, with さん when it is not', () => {
    vi.stubEnv('SHANNON_COMPANION_NAMES', 'アキ');
    const ask = (name: string) => guestPeoplePrompt({ people: [], returning: [], ambiguousName: name, recorded: true, items: [] });
    expect(ask('アキ')).toContain('お会いしたアキでしょうか');
    expect(ask('ユウ')).toContain('お会いしたユウさんでしょうか');
  });
});

describe('the names a call summary is written with', () => {
  it('shows the friend by name alone in the summary input, from one rule', async () => {
    vi.stubEnv('SHANNON_COMPANION_NAMES', 'アキ');
    const directory = mkdtempSync(join(tmpdir(), 'shannon-greeting-summary-'));
    directories.push(directory);
    const store = new SQLitePeopleMemoryStore(join(directory, 'shannon.sqlite'));
    const people = new PeopleMemory(store, { snapshot: () => ({}) } as never);
    const aki = store.createPerson('owner', { displayName: 'アキ', howKnown: 'テスト' }, START);
    const yuu = store.createPerson('owner', { displayName: 'ユウ', howKnown: 'テスト' }, START);
    expect(people.shownName('owner', aki)).toBe('アキ');
    expect(people.shownName('owner', yuu)).toBe('ユウさん');
    let given: readonly string[] = [];
    store.saveCall('owner', { callId: 'c1', status: 'open', personIds: [aki.id, yuu.id], createdPersonIds: [], startedAt: START, updatedAt: START });
    const result = await people.rememberCall('owner', { callId: 'c1', turns: [{ role: 'participant', text: 'こんにちは' }, { role: 'shannon', text: 'やあ' }] }, START,
      async (_turns, names) => { given = names; return '相手: アキ・ユウさん\n話したこと: 挨拶。'; });
    // Person ids are random UUIDs, so the order of the people may follow them; what matters is how each name is written.
    expect([...given].sort()).toEqual(['アキ', 'ユウさん'].sort());
    expect(result.summary).toContain('相手: アキ・ユウさん');
    store.close();
  });

  it('shows a listed friend by name alone in what she recalls of a call (the line and the label of who was there), and keeps さん for the rest', () => {
    vi.stubEnv('SHANNON_COMPANION_NAMES', 'アキ');
    const directory = mkdtempSync(join(tmpdir(), 'shannon-greeting-recall-'));
    directories.push(directory);
    const store = new SQLitePeopleMemoryStore(join(directory, 'shannon.sqlite'));
    const people = new PeopleMemory(store, { snapshot: () => ({}) } as never);
    const aki = store.createPerson('owner', { displayName: 'アキ', howKnown: 'テスト' }, START);
    const yuu = store.createPerson('owner', { displayName: 'ユウ', howKnown: 'テスト' }, START);
    store.saveCall('owner', { callId: 'c2', status: 'remembered', personIds: [aki.id, yuu.id], createdPersonIds: [], startedAt: START, updatedAt: START });
    const text = 'アキさんもユウさんも猫が好き';
    store.replaceCallItems('owner', 'c2', [{ id: 'r1', kind: 'fact', personId: aki.id, text, observedAt: START, disclosure: disclosureFor(text, peopleAudience([aki.id, yuu.id])) }]);
    const recalled = people.recall('owner', createInitialCompanionState('owner', START), '', OWNER_AUDIENCE);
    expect(recalled.items.map(item => item.text)).toEqual(['アキもユウさんも猫が好き']);
    // peopleAudience sorts the person ids, which are random UUIDs, so the two names come in either order.
    expect(recalled.items.map(item => item.audienceLabel)).toEqual([expect.stringMatching(/^(?:アキ・ユウさん|ユウさん・アキ)と一緒の時$/u)]);
    expect(recalled.candidates.map(candidate => candidate.summary).join('')).not.toContain('アキさん');
    store.close();
  });
});
