import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { SQLitePersonIdentityStore } from '../src/mind/memory/store/personIdentity.js';
import { PlatformPeople } from '../src/mind/memory/platformPeople.js';
import { greetNamesOf, greetingHintBlock, introducedBlock, onAirBlock, presenceBlock } from '../src/surfaces/platform/voicePresencePrompt.js';

// Names here are made up for the test: the code never holds a real person's name.
const START = '2026-10-20T12:00:00.000Z';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('calling a friend by name alone and someone she knows less with さん', () => {
  const facts = {
    call: { names: [SHANNON_OWNER_NAME, 'アキ', 'ミナ', 'ユウ'], unnamed: 0, companions: ['アキ', 'ミナ'] },
    server: { running: 'running' as const, bodyIn: false, people: { names: ['アキ', 'ユウ'], unnamed: 0, companions: ['アキ'] } },
    onAir: { note: '' },
    speakerName: SHANNON_OWNER_NAME,
  };

  it('writes a friend (the owner included) with no さん and the others with さん, in the list and in the greeting names', () => {
    const text = presenceBlock(facts);
    expect(text).toContain(`Discordの通話にいる人（ボクのほか）: ${SHANNON_OWNER_NAME}、アキ、ミナ、ユウさん。`);
    expect(text).toContain('同じマイクラのサーバーにいる人（ボクのほか）: アキ、ユウさん。');
    expect(greetNamesOf(facts, SHANNON_OWNER_NAME)).toEqual(['アキ', 'ミナ', 'ユウさん']);
    expect(introducedBlock(facts, 'こちらがシャノンです')).toContain('アキ、ミナ、ユウさんを名前で呼ぶところから始める');
    expect(greetingHintBlock(facts)).toContain('アキ、ミナ、ユウさん、視聴者の皆さんを呼ぶところから始めて');
  });

  it('gives the reason for each way of calling, to the same rule for every friend, and no real name in the example', () => {
    const text = presenceBlock(facts);
    expect(text).toContain('「さん」が付かずに書かれた人は、いつも一緒に遊ぶ仲間。名前だけで呼び、「さん」「氏」は付けない。理由: 仲間はボクにとって友だちなので');
    expect(text).toContain('「さん」が付いて書かれた人は、まだよく知らない人。書かれた通り「さん」を付けて呼ぶ。理由:');
    const air = onAirBlock({ note: '' });
    expect(air).toContain('形の例は「〈名前〉、〈名前〉、そして視聴者の皆さん！こんにちは、シャノンです！」');
    expect(air).not.toContain(`${SHANNON_OWNER_NAME}だけは`);
  });

  it('writes only the rule that applies: nobody known less, or nobody a friend', () => {
    const friendsOnly = presenceBlock({ ...facts, call: { names: ['アキ'], unnamed: 0, companions: ['アキ'] }, server: null });
    expect(friendsOnly).toContain('「さん」が付かずに書かれた人は');
    expect(friendsOnly).not.toContain('「さん」が付いて書かれた人は');
    const strangersOnly = presenceBlock({ ...facts, call: { names: ['ユウ'], unnamed: 0 }, server: null });
    expect(strangersOnly).toContain('ユウさん');
    expect(strangersOnly).not.toContain('「さん」が付かずに書かれた人は');
    expect(strangersOnly).toContain('「さん」が付いて書かれた人は');
  });

  it('takes a friend from the registry the owner confirmed, and not a person met only once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-companions-'));
    directories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const store = new SQLiteShannonStore({ path, now: () => START });
    const peopleStore = new SQLitePeopleMemoryStore(path);
    const identities = new SQLitePersonIdentityStore(path);
    const people = new PlatformPeople(peopleStore, store);
    const friend = identities.createCandidate('owner', { displayName: 'アキ', platform: 'discord', externalUserId: '900000000000000002' }, START);
    identities.confirm('owner', friend.id, 'discord', friend.identities[0]!.revision, START);
    // Someone met in the call: a person made from the account's name, never confirmed by the owner.
    const met = peopleStore.createPerson('owner', { displayName: 'ユウ', howKnown: 'Discordで会った人' }, START);
    peopleStore.linkPlatformPerson('owner', { platform: 'discord', userId: '900000000000000003', personId: met.id, displayName: 'ユウ', firstSeenAt: START, lastSeenAt: START });
    expect(people.placed('owner', 'discord', '900000000000000002')).toEqual({ name: 'アキ', companion: true });
    expect(people.placed('owner', 'discord', '900000000000000003')).toEqual({ name: 'ユウ', companion: false });
    expect(people.placed('owner', 'discord', '900000000000000009')).toBeNull();
    expect(people.callName('owner', 'discord', '900000000000000002')).toBe('アキ');
  });
});
