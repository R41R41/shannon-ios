import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { companionRoster, onRoster, plainCompanionNames, withHonorific } from '../src/mind/memory/companionNames.js';
import { periodSummaryText } from '../src/mind/memory/peopleMemory.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { impressionSubject } from '../src/mind/recall/impressionRecall.js';

// Names are made up for the test.
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('one way of writing a remembered person in the fields she reads', () => {
  it('writes a friend by name alone and anyone else with さん', () => {
    expect(withHonorific('アキ', true)).toBe('アキ');
    expect(withHonorific('ユウ', false)).toBe('ユウさん');
  });

  it('shows a friend written with さん in older text as the name alone, and leaves other people and 「さんぽ」', () => {
    expect(plainCompanionNames('相手: アキさん・ユウさん アキさんが来た。アキさんぽ', ['アキ'])).toBe('相手: アキ・ユウさん アキが来た。アキさんぽ');
    expect(plainCompanionNames('相手: アキさん', [])).toBe('相手: アキさん');
    expect(plainCompanionNames('a.b さん', ['a.b'])).toBe('a.b さん');
    expect(plainCompanionNames('a.bさん', ['a.b'])).toBe('a.b');
  });

  it('names a friend alone as the subject of an impression', () => {
    const people = [{ id: 'p1', displayName: 'アキ', aliases: [], forgotten: false, companion: true }, { id: 'p2', displayName: 'ユウ', aliases: [], forgotten: false }];
    expect(impressionSubject({ personKey: 'p1' }, people)).toBe('アキ');
    expect(impressionSubject({ personKey: 'p2' }, people)).toBe('ユウさん');
  });

  it('writes the period summary with the friend by name alone', () => {
    const persons: Record<string, { displayName: string }> = { a: { displayName: 'アキ' }, b: { displayName: 'ユウ' } };
    const store = {
      call: () => ({ personIds: ['a', 'b'] }), person: (_scope: string, id: string) => persons[id], items: () => [],
      confirmedPerson: (_scope: string, id: string) => id === 'a',
    } as unknown as Parameters<typeof periodSummaryText>[0];
    expect(periodSummaryText(store, 'owner', 'call-1', 'Discord')?.text).toContain('相手: アキ・ユウさん');
  });

  it('keeps calling everyone with さん when the registry cannot be read, and says so once in the log', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-companions-'));
    directories.push(directory);
    const store = new SQLitePeopleMemoryStore(join(directory, 'shannon.sqlite'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // No registry table has been made in this file.
    expect(store.confirmedPerson('owner', 'x')).toBe(false);
    expect(store.confirmedPerson('owner', 'y')).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe('Shannon companion lookup failed');
  });

  it('reads the list with half-width and full-width commas, trimmed, and never by a part of a name', () => {
    expect(companionRoster(' アキ, ユウ、ミト，  ,')).toEqual(['アキ', 'ユウ', 'ミト']);
    expect(companionRoster('')).toEqual([]);
    expect(companionRoster(undefined)).toEqual([]);
    expect(onRoster(['アキ'], [' アキ '])).toBe(true);
    expect(onRoster(['アキ'], ['アキラ', 'ライアキ'])).toBe(false);
    expect(onRoster([], ['アキ'])).toBe(false);
  });

  describe('a friend named in SHANNON_COMPANION_NAMES', () => {
    const made = () => {
      const directory = mkdtempSync(join(tmpdir(), 'shannon-companions-'));
      directories.push(directory);
      const store = new SQLitePeopleMemoryStore(join(directory, 'shannon.sqlite'));
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const at = '2026-01-01T00:00:00.000Z';
      const listed = store.createPerson('owner', { displayName: 'アキ', howKnown: 'met' }, at);
      const byAlias = store.createPerson('owner', { displayName: 'ミト', howKnown: 'met', aliases: ['ユウ'] }, at);
      const other = store.createPerson('owner', { displayName: 'ユウキ', howKnown: 'met' }, at);
      const auto = store.createPerson('owner', { displayName: 'ノア', howKnown: 'met' }, at);
      return { store, listed, byAlias, other, auto };
    };

    it('is called by name alone, by name or by alias; anyone else, the automatically made included, keeps さん', () => {
      const { store, listed, byAlias, other, auto } = made();
      vi.stubEnv('SHANNON_COMPANION_NAMES', 'アキ，ユウ,');
      expect(store.confirmedPerson('owner', listed.id)).toBe(true);
      expect(store.confirmedPerson('owner', byAlias.id)).toBe(true);
      expect(store.confirmedPerson('owner', other.id)).toBe(false);
      expect(store.confirmedPerson('owner', auto.id)).toBe(false);
      expect(withHonorific(listed.displayName, store.confirmedPerson('owner', listed.id))).toBe('アキ');
      expect(withHonorific(auto.displayName, store.confirmedPerson('owner', auto.id))).toBe('ノアさん');
    });

    it('does not match a part of a name', () => {
      const { store, other } = made();
      vi.stubEnv('SHANNON_COMPANION_NAMES', 'ユウ');
      expect(store.confirmedPerson('owner', other.id)).toBe(false);
    });

    it('changes nothing while the list is empty or unset', () => {
      const { store, listed } = made();
      vi.stubEnv('SHANNON_COMPANION_NAMES', '');
      expect(store.confirmedPerson('owner', listed.id)).toBe(false);
      vi.stubEnv('SHANNON_COMPANION_NAMES', ' , ');
      expect(store.confirmedPerson('owner', listed.id)).toBe(false);
    });
  });
});
