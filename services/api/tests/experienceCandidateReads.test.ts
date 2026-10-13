import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

/**
 * 2026-10-13: a text turn read and parsed every remembered turn about ten times before its model call, and the FCA report scan
 * again every few seconds. The read is kept while the database is unchanged, and read afresh after any change, by this
 * connection or by any other (another process's turn, a direct UPDATE of a payload).
 */
const at = '2026-10-13T08:00:00.000Z';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function world() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-candidates-'));
  const path = join(directory, 'shannon.sqlite');
  const store = new SQLiteShannonStore({ path, now: () => at });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }), () => store.close());
  return { store, path, thread: store.createThread('owner', 'talk') };
}

describe('remembered turns read once while nothing changed', () => {
  it('reuses the read until this connection writes, and reads the new turn after it', () => {
    const { store, thread } = world();
    store.appendTurn('owner', thread, 'こんにちは', 'こんにちは、ライ氏。', at);
    const first = store.experienceCandidates('owner');
    expect(store.experienceCandidates('owner')).toBe(first);
    store.appendTurn('owner', thread, '元気？', '元気です。', at);
    const second = store.experienceCandidates('owner');
    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
    expect(Object.isFrozen(second[0])).toBe(true);
  });

  it('reads afresh after another connection changed a payload in place', () => {
    const { store, path, thread } = world();
    store.appendTurn('owner', thread, 'こんにちは', 'こんにちは、ライ氏。', at);
    const before = store.experienceCandidates('owner');
    const other = new DatabaseSync(path); cleanups.push(() => other.close());
    const row = other.prepare("SELECT event_id, payload_json FROM experience_events WHERE event_type='turn.completed'").get() as { event_id: string; payload_json: string };
    const payload = { ...JSON.parse(row.payload_json), userMessage: '書き換えた' };
    other.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify(payload), row.event_id);
    const after = store.experienceCandidates('owner');
    expect(after).not.toBe(before);
    expect(after[0]!.userMessage).toBe('書き換えた');
  });
});
