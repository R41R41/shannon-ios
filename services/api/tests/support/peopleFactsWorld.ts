import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { SQLitePeopleMemoryStore } from '../../src/mind/memory/store/peopleMemoryStore.js';
import { PlatformPeople } from '../../src/surfaces/platform/platformPeople.js';
import type { IdentityChooser, PersonFactJudge } from '../../src/mind/memory/memoryPorts.js';
import { memoryPortsOf, memoryWriterOf } from '../../src/wiring/memoryOutboxWiring.js';
import { peopleFactReaders, peopleFactsStoreOptions } from '../../src/wiring/peopleFactsWiring.js';

/**
 * A temporary database with the memory outbox and people facts on (Syzygy ADR-0008 stage 3, F5 and F6), the platform's people
 * over it as the API builds them, and the one writer with an optional judge (luna's stand-in) and chooser (Jev's).
 */
export const PEOPLE_AT = '2026-10-07T03:00:00.000Z';

export function peopleFactsWorld(options: { judge?: PersonFactJudge | null; chooser?: IdentityChooser | null; environment?: Record<string, string> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-people-facts-'));
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: Date.parse(PEOPLE_AT) };
  const now = () => new Date(clock.at).toISOString();
  const store = new SQLiteShannonStore({ path, now, memoryOutbox: true, moodHistory: null, ...peopleFactsStoreOptions(options.environment ?? {}) });
  const peopleStore = new SQLitePeopleMemoryStore(path);
  const ports = memoryPortsOf(store, now)!;
  const readers = peopleFactReaders(store, now);
  const people = new PlatformPeople(peopleStore, store, undefined, ports.proposals, readers);
  const writer = memoryWriterOf(store, { now, log: () => {}, judge: options.judge ?? null, chooser: options.chooser ?? null })!;
  let request = 0;
  const say = (userId: string, name: string, message: string) => {
    request += 1;
    clock.at += 60_000;
    return people.ingest('owner', { platform: 'discord', requestId: `r-${request}`, payloadHash: `h-${request}`, threadKey: 'discord:111:222',
      label: 'テストサーバー（Discord）', conversationKind: 'channel', sourceUserId: userId, sourceDisplayName: name, sourceKind: 'person',
      message, shannonReply: 'うん', observedAt: now() });
  };
  const factRows = () => {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(`SELECT item_id, text, valid_at, invalid_at, expired_at, episode_ids_json, fact_revision FROM person_memory_items
        WHERE kind = 'fact' ORDER BY observed_at, item_id`).all() as Array<{ item_id: string; text: string; valid_at: string | null; invalid_at: string | null;
          expired_at: string | null; episode_ids_json: string | null; fact_revision: number }>;
    } finally { database.close(); }
  };
  return {
    directory, path, clock, now, store, peopleStore, ports, readers, people, writer, say, factRows,
    context: (userIds: readonly string[]) => people.contextLines('owner', 'discord', userIds, { kind: 'group', groupKey: 'discord:111:222' }, true),
    close: () => { peopleStore.close(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
