import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainCompanionNames, withHonorific } from '../src/mind/memory/companionNames.js';
import { periodSummaryText } from '../src/mind/memory/peopleMemory.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { impressionSubject } from '../src/mind/recall/impressionRecall.js';

// Names are made up for the test.
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

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
});
