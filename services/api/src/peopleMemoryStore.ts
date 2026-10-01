import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeDisclosure, type MemoryDisclosure } from '@shannon/cognition';

/** A person Shannon has met with the owner. Rows live in the existing `people` table. */
export interface RememberedPerson {
  id: string;
  displayName: string;
  aliases: readonly string[];
  howKnown: string;
  createdAt: string;
  updatedAt: string;
  /** Set while the owner has asked Shannon to forget this person. Nothing about them is used. */
  forgottenAt?: string;
}

export type PersonCallStatus = 'open' | 'remembered' | 'discarded';

/** One 「友人も一緒」 period of a call, or one day of a platform conversation. */
export interface PersonCall {
  callId: string;
  threadId?: string;
  /** Where it took place: absent for a voice call, otherwise the platform (`discord`, `line`, …). */
  source?: string;
  /** How the place is shown to the owner, for example 「友人グループ（Discord）」. */
  label?: string;
  status: PersonCallStatus;
  personIds: readonly string[];
  /** People this call created; removed again if the owner chooses 「今回は残さない」. */
  createdPersonIds: readonly string[];
  /** A name that matched more than one remembered person and is still unresolved. */
  pendingName?: string;
  startedAt: string;
  updatedAt: string;
}

export type PersonMemoryKind = 'summary' | 'turn' | 'fact' | 'promise' | 'topic';

export interface PersonMemoryItem {
  id: string;
  callId: string;
  kind: PersonMemoryKind;
  /** Who a fact or promise is about. Absent for the call's summary and turns. */
  personId?: string;
  text: string;
  evidence?: string;
  disclosure: MemoryDisclosure;
  observedAt: string;
}

export interface PeopleMemoryStore {
  listPeople(scopeKey: string): readonly RememberedPerson[];
  person(scopeKey: string, personId: string): RememberedPerson | null;
  createPerson(scopeKey: string, input: { displayName: string; howKnown: string; aliases?: readonly string[] }, at: string): RememberedPerson;
  updatePerson(scopeKey: string, personId: string, input: { displayName?: string; aliases?: readonly string[]; forgottenAt?: string | null }, at: string): RememberedPerson | null;
  /** Moves every call and item of `fromId` to `intoId`, keeps its names as aliases, and removes it. */
  mergePeople(scopeKey: string, intoId: string, fromId: string, at: string): RememberedPerson | null;
  call(scopeKey: string, callId: string): PersonCall | null;
  saveCall(scopeKey: string, call: PersonCall): PersonCall;
  /** Replaces what is remembered from one call. */
  replaceCallItems(scopeKey: string, callId: string, items: readonly Omit<PersonMemoryItem, 'callId'>[]): void;
  /** Removes a call's items and the people it created, leaving only a content-free tombstone. */
  discardCall(scopeKey: string, callId: string, at: string): boolean;
  items(scopeKey: string): readonly PersonMemoryItem[];
  setItemDisclosure(scopeKey: string, itemId: string, disclosure: MemoryDisclosure): boolean;
  /** Adds items to a call, or rewrites the text of an item that already exists. The owner's own label is kept. */
  upsertCallItems(scopeKey: string, callId: string, items: readonly Omit<PersonMemoryItem, 'callId'>[]): void;
  /** Remembered platform conversation periods that were updated inside a window. */
  platformCalls(scopeKey: string, startAt: string, endAt: string): readonly PersonCall[];
  /** The person a platform account belongs to, if it has been seen. */
  platformPerson(scopeKey: string, platform: string, userId: string): PlatformPersonLink | null;
  linkPlatformPerson(scopeKey: string, link: PlatformPersonLink): void;
  platformLinks(scopeKey: string): readonly PlatformPersonLink[];
  /** The owner-managed identity registry: the person an account was registered for, and a candidate row for a new one. */
  registryPersonId(scopeKey: string, platform: string, userId: string): string | null;
  recordRegistryCandidate(scopeKey: string, platform: string, userId: string, personId: string, at: string): void;
  /** Records one mirrored message once. Returns the earlier record when the request was already seen. */
  platformReceipt(scopeKey: string, platform: string, requestId: string): PlatformTurnReceipt | null;
  recordPlatformReceipt(scopeKey: string, receipt: PlatformTurnReceipt): void;
  /** Stored non-owner messages of one local day: in one conversation, and in all. */
  platformTurnCounts(scopeKey: string, dayKey: string, threadKey: string): { conversation: number; total: number };
}

export interface PlatformPersonLink {
  platform: string;
  userId: string;
  personId: string;
  displayName: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PlatformTurnReceipt {
  platform: string;
  requestId: string;
  payloadHash: string;
  threadKey: string;
  dayKey: string;
  /** Empty when the message was received but not stored (a bot, a cap, a forgotten person). */
  itemId: string;
  outcome: string;
  createdAt: string;
}

interface PersonRow { person_id: string; display_name: string; aliases_json: string | null; how_known: string | null;
  created_at: string; updated_at: string; forgotten_at: string | null; }
interface CallRow { call_id: string; thread_id: string | null; status: PersonCallStatus; person_ids_json: string;
  created_person_ids_json: string; pending_name: string | null; started_at: string; updated_at: string; source?: string | null; label?: string | null; }
interface LinkRow { platform: string; external_user_id: string; person_id: string; display_name: string; first_seen_at: string; last_seen_at: string; }
interface ItemRow { item_id: string; call_id: string; kind: PersonMemoryKind; person_id: string | null; text: string;
  evidence: string | null; disclosure_json: string; observed_at: string; }

const strings = (raw: string | null): string[] => {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
};

/**
 * People and what was talked about with them. Additive: it adds three nullable columns to
 * the existing `people` table and two new tables, outside the numbered migrations, so an
 * older API binary still opens the database and the person identity registry is unchanged.
 */
export class SQLitePeopleMemoryStore implements PeopleMemoryStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS people (
        scope_key TEXT NOT NULL,
        person_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('candidate','active','revoked')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, person_id)
      );
      CREATE TABLE IF NOT EXISTS person_calls (
        scope_key TEXT NOT NULL,
        call_id TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('open','remembered','discarded')),
        person_ids_json TEXT NOT NULL DEFAULT '[]',
        created_person_ids_json TEXT NOT NULL DEFAULT '[]',
        pending_name TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, call_id)
      );
      CREATE TABLE IF NOT EXISTS person_memory_items (
        scope_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('summary','turn','fact','promise','topic')),
        person_id TEXT,
        text TEXT NOT NULL,
        evidence TEXT,
        disclosure_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope_key, item_id)
      );
      CREATE INDEX IF NOT EXISTS person_memory_items_call ON person_memory_items(scope_key, call_id, ordinal);
      CREATE TABLE IF NOT EXISTS person_platform_links (
        scope_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, platform, external_user_id)
      );
      CREATE TABLE IF NOT EXISTS person_platform_turns (
        scope_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        item_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, platform, request_id)
      );
      CREATE INDEX IF NOT EXISTS person_platform_turns_day ON person_platform_turns(scope_key, day_key, thread_key);
    `);
    this.addColumns('person_calls', ['source', 'label']);
    this.addColumns('people', ['aliases_json', 'how_known', 'forgotten_at']);
  }

  /** Additive, nullable columns only, so an older API binary keeps opening the database. */
  private addColumns(table: 'people' | 'person_calls', names: readonly string[]): void {
    const columns = new Set((this.database.prepare(`PRAGMA table_info('${table}')`).all() as unknown as Array<{ name: string }>).map(column => column.name));
    for (const column of names) {
      if (columns.has(column)) continue;
      try { this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`); } catch (error) {
        // Another process added it between the check and the statement.
        if (!(error instanceof Error && error.message.includes('duplicate column'))) throw error;
      }
    }
  }

  close(): void { this.database.close(); }

  /** People met in person. Candidates and revoked rows of the platform identity registry are not listed. */
  listPeople(scopeKey: string): readonly RememberedPerson[] {
    const rows = this.database.prepare(`
      SELECT person_id, display_name, aliases_json, how_known, created_at, updated_at, forgotten_at
      FROM people WHERE scope_key = ? AND lifecycle_status = 'active' ORDER BY updated_at DESC, person_id
    `).all(scopeKey) as unknown as PersonRow[];
    return Object.freeze(rows.map(person));
  }

  person(scopeKey: string, personId: string): RememberedPerson | null {
    const row = this.database.prepare(`
      SELECT person_id, display_name, aliases_json, how_known, created_at, updated_at, forgotten_at
      FROM people WHERE scope_key = ? AND person_id = ? AND lifecycle_status = 'active'
    `).get(scopeKey, personId) as unknown as PersonRow | undefined;
    return row ? person(row) : null;
  }

  createPerson(scopeKey: string, input: { displayName: string; howKnown: string; aliases?: readonly string[] }, at: string): RememberedPerson {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO people (scope_key, person_id, display_name, lifecycle_status, revision, created_at, updated_at, aliases_json, how_known)
      VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?)
    `).run(scopeKey, id, input.displayName.slice(0, 80), at, at, JSON.stringify(uniqueNames(input.aliases ?? [])), input.howKnown.slice(0, 120));
    return this.person(scopeKey, id)!;
  }

  updatePerson(scopeKey: string, personId: string, input: { displayName?: string; aliases?: readonly string[]; forgottenAt?: string | null }, at: string): RememberedPerson | null {
    const current = this.person(scopeKey, personId);
    if (!current) return null;
    this.database.prepare(`
      UPDATE people SET display_name = ?, aliases_json = ?, forgotten_at = ?, revision = revision + 1, updated_at = ?
      WHERE scope_key = ? AND person_id = ?
    `).run((input.displayName ?? current.displayName).slice(0, 80),
      JSON.stringify(uniqueNames(input.aliases ?? current.aliases).filter(alias => alias !== (input.displayName ?? current.displayName))),
      input.forgottenAt === undefined ? current.forgottenAt ?? null : input.forgottenAt, at, scopeKey, personId);
    return this.person(scopeKey, personId);
  }

  mergePeople(scopeKey: string, intoId: string, fromId: string, at: string): RememberedPerson | null {
    const into = this.person(scopeKey, intoId);
    const from = this.person(scopeKey, fromId);
    if (!into || !from || intoId === fromId) return null;
    const replace = (ids: readonly string[]) => [...new Set(ids.map(id => id === fromId ? intoId : id))];
    return this.transaction(() => {
      for (const row of this.database.prepare('SELECT call_id, person_ids_json, created_person_ids_json FROM person_calls WHERE scope_key = ?')
        .all(scopeKey) as unknown as CallRow[]) {
        const personIds = strings(row.person_ids_json);
        const created = strings(row.created_person_ids_json);
        if (!personIds.includes(fromId) && !created.includes(fromId)) continue;
        this.database.prepare('UPDATE person_calls SET person_ids_json = ?, created_person_ids_json = ? WHERE scope_key = ? AND call_id = ?')
          .run(JSON.stringify(replace(personIds)), JSON.stringify(created.filter(id => id !== fromId)), scopeKey, row.call_id);
      }
      for (const row of this.database.prepare('SELECT item_id, person_id, text, disclosure_json FROM person_memory_items WHERE scope_key = ?')
        .all(scopeKey) as unknown as ItemRow[]) {
        const disclosure = parsedDisclosure(row.disclosure_json);
        const audience = disclosure.audience;
        const inAudience = audience?.kind === 'people' && audience.personIds.includes(fromId);
        if (!inAudience && row.person_id !== fromId) continue;
        const next = inAudience && audience?.kind === 'people'
          ? { ...disclosure, audience: { ...audience, personIds: replace(audience.personIds).sort() } } : disclosure;
        this.database.prepare('UPDATE person_memory_items SET person_id = ?, disclosure_json = ? WHERE scope_key = ? AND item_id = ?')
          .run(row.person_id === fromId ? intoId : row.person_id, JSON.stringify(next), scopeKey, row.item_id);
      }
      this.database.prepare('UPDATE person_platform_links SET person_id = ? WHERE scope_key = ? AND person_id = ?').run(intoId, scopeKey, fromId);
      // A platform identity of the merged person moves with it when the registry table exists and has no clash.
      try {
        this.database.prepare('UPDATE OR IGNORE person_platform_identities SET person_id = ? WHERE scope_key = ? AND person_id = ?')
          .run(intoId, scopeKey, fromId);
      } catch { /* the identity registry has not been created in this database */ }
      this.database.prepare('DELETE FROM people WHERE scope_key = ? AND person_id = ?').run(scopeKey, fromId);
      return this.updatePerson(scopeKey, intoId, { aliases: [...into.aliases, from.displayName, ...from.aliases] }, at);
    });
  }

  call(scopeKey: string, callId: string): PersonCall | null {
    const row = this.database.prepare(`
      SELECT call_id, thread_id, status, person_ids_json, created_person_ids_json, pending_name, started_at, updated_at, source, label
      FROM person_calls WHERE scope_key = ? AND call_id = ?
    `).get(scopeKey, callId) as unknown as CallRow | undefined;
    return row ? callOf(row) : null;
  }

  platformCalls(scopeKey: string, startAt: string, endAt: string): readonly PersonCall[] {
    return Object.freeze((this.database.prepare(`
      SELECT call_id, thread_id, status, person_ids_json, created_person_ids_json, pending_name, started_at, updated_at, source, label
      FROM person_calls WHERE scope_key = ? AND status = 'remembered' AND source IS NOT NULL AND updated_at >= ? AND updated_at < ?
      ORDER BY updated_at ASC LIMIT 200
    `).all(scopeKey, startAt, endAt) as unknown as CallRow[]).map(callOf));
  }

  upsertCallItems(scopeKey: string, callId: string, items: readonly Omit<PersonMemoryItem, 'callId'>[]): void {
    this.transaction(() => {
      const next = (this.database.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM person_memory_items WHERE scope_key = ? AND call_id = ?')
        .get(scopeKey, callId) as unknown as { next: number }).next;
      const statement = this.database.prepare(`
        INSERT INTO person_memory_items (scope_key, item_id, call_id, kind, person_id, text, evidence, disclosure_json, observed_at, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, item_id) DO UPDATE SET text = excluded.text, observed_at = excluded.observed_at,
          disclosure_json = CASE WHEN json_extract(person_memory_items.disclosure_json, '$.decidedBy') = 'owner'
            THEN person_memory_items.disclosure_json ELSE excluded.disclosure_json END
      `);
      items.forEach((item, index) => statement.run(scopeKey, item.id, callId, item.kind, item.personId ?? null, item.text.slice(0, 600),
        item.evidence?.slice(0, 600) ?? null, JSON.stringify(item.disclosure), item.observedAt, Number(next) + index));
    });
  }

  platformPerson(scopeKey: string, platform: string, userId: string): PlatformPersonLink | null {
    const row = this.database.prepare(`
      SELECT platform, external_user_id, person_id, display_name, first_seen_at, last_seen_at
      FROM person_platform_links WHERE scope_key = ? AND platform = ? AND external_user_id = ?
    `).get(scopeKey, platform, userId) as unknown as LinkRow | undefined;
    return row ? linkOf(row) : null;
  }

  platformLinks(scopeKey: string): readonly PlatformPersonLink[] {
    return Object.freeze((this.database.prepare(`
      SELECT platform, external_user_id, person_id, display_name, first_seen_at, last_seen_at
      FROM person_platform_links WHERE scope_key = ?
    `).all(scopeKey) as unknown as LinkRow[]).map(linkOf));
  }

  registryPersonId(scopeKey: string, platform: string, userId: string): string | null {
    try {
      const row = this.database.prepare(`SELECT person_id FROM person_platform_identities
        WHERE scope_key = ? AND platform = ? AND external_user_id = ? AND verification_status <> 'revoked'`).get(scopeKey, platform, userId);
      return typeof row?.person_id === 'string' ? row.person_id : null;
    } catch { return null; }
  }

  recordRegistryCandidate(scopeKey: string, platform: string, userId: string, personId: string, at: string): void {
    // Unconfirmed until the owner confirms it in the registry. The registry accepts Discord only; others keep the link alone.
    try {
      this.database.prepare(`INSERT OR IGNORE INTO person_platform_identities
        (scope_key, person_id, platform, external_user_id, verification_status, revision, created_at, updated_at, confirmed_at, revoked_at)
        VALUES (?, ?, ?, ?, 'candidate', 1, ?, ?, NULL, NULL)`).run(scopeKey, personId, platform, userId, at, at);
    } catch { /* the registry table is absent, or the platform is not one it accepts */ }
  }

  linkPlatformPerson(scopeKey: string, link: PlatformPersonLink): void {
    this.database.prepare(`
      INSERT INTO person_platform_links (scope_key, platform, external_user_id, person_id, display_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, platform, external_user_id) DO UPDATE SET person_id = excluded.person_id,
        display_name = excluded.display_name, last_seen_at = excluded.last_seen_at
    `).run(scopeKey, link.platform, link.userId, link.personId, link.displayName.slice(0, 80), link.firstSeenAt, link.lastSeenAt);
  }

  platformReceipt(scopeKey: string, platform: string, requestId: string): PlatformTurnReceipt | null {
    const row = this.database.prepare(`
      SELECT platform, request_id, payload_hash, thread_key, day_key, item_id, outcome, created_at
      FROM person_platform_turns WHERE scope_key = ? AND platform = ? AND request_id = ?
    `).get(scopeKey, platform, requestId) as unknown as { platform: string; request_id: string; payload_hash: string; thread_key: string;
      day_key: string; item_id: string; outcome: string; created_at: string } | undefined;
    return row ? { platform: row.platform, requestId: row.request_id, payloadHash: row.payload_hash, threadKey: row.thread_key,
      dayKey: row.day_key, itemId: row.item_id, outcome: row.outcome, createdAt: row.created_at } : null;
  }

  recordPlatformReceipt(scopeKey: string, receipt: PlatformTurnReceipt): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO person_platform_turns (scope_key, platform, request_id, payload_hash, thread_key, day_key, item_id, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, receipt.platform, receipt.requestId, receipt.payloadHash, receipt.threadKey, receipt.dayKey, receipt.itemId,
      receipt.outcome, receipt.createdAt);
  }

  platformTurnCounts(scopeKey: string, dayKey: string, threadKey: string): { conversation: number; total: number } {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN thread_key = ? THEN 1 ELSE 0 END), 0) AS conversation
      FROM person_platform_turns WHERE scope_key = ? AND day_key = ? AND outcome = 'stored'
    `).get(threadKey, scopeKey, dayKey) as unknown as { total: number; conversation: number };
    return { conversation: Number(row.conversation), total: Number(row.total) };
  }

  saveCall(scopeKey: string, call: PersonCall): PersonCall {
    this.database.prepare(`
      INSERT INTO person_calls (scope_key, call_id, thread_id, status, person_ids_json, created_person_ids_json, pending_name, started_at, updated_at, source, label)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, call_id) DO UPDATE SET thread_id = excluded.thread_id, status = excluded.status,
        person_ids_json = excluded.person_ids_json, created_person_ids_json = excluded.created_person_ids_json,
        pending_name = excluded.pending_name, updated_at = excluded.updated_at, source = excluded.source, label = excluded.label
    `).run(scopeKey, call.callId, call.threadId ?? null, call.status, JSON.stringify(call.personIds),
      JSON.stringify(call.createdPersonIds), call.pendingName ?? null, call.startedAt, call.updatedAt, call.source ?? null, call.label ?? null);
    return this.call(scopeKey, call.callId)!;
  }

  replaceCallItems(scopeKey: string, callId: string, items: readonly Omit<PersonMemoryItem, 'callId'>[]): void {
    this.transaction(() => {
      // The owner's own 機微／ふつう on an item survives the same period being saved again.
      const chosen = new Map((this.database.prepare('SELECT item_id, disclosure_json FROM person_memory_items WHERE scope_key = ? AND call_id = ?')
        .all(scopeKey, callId) as unknown as ItemRow[]).map(row => [row.item_id, parsedDisclosure(row.disclosure_json)] as const)
        .filter(([, disclosure]) => disclosure.decidedBy === 'owner'));
      items = items.map(item => chosen.has(item.id) ? { ...item, disclosure: { ...item.disclosure, sensitivity: chosen.get(item.id)!.sensitivity, decidedBy: 'owner' as const, reason: 'ライ氏が選んだ扱い' } } : item);
      this.database.prepare('DELETE FROM person_memory_items WHERE scope_key = ? AND call_id = ?').run(scopeKey, callId);
      const insert = this.database.prepare(`
        INSERT INTO person_memory_items (scope_key, item_id, call_id, kind, person_id, text, evidence, disclosure_json, observed_at, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      items.forEach((item, index) => insert.run(scopeKey, item.id, callId, item.kind, item.personId ?? null, item.text.slice(0, 600),
        item.evidence?.slice(0, 600) ?? null, JSON.stringify(item.disclosure), item.observedAt, index));
    });
  }

  discardCall(scopeKey: string, callId: string, at: string): boolean {
    return this.transaction(() => {
      const call = this.call(scopeKey, callId);
      this.database.prepare('DELETE FROM person_memory_items WHERE scope_key = ? AND call_id = ?').run(scopeKey, callId);
      for (const personId of call?.createdPersonIds ?? []) {
        // A person this call introduced is removed unless another call has remembered them since.
        const elsewhere = (this.database.prepare('SELECT call_id, person_ids_json FROM person_calls WHERE scope_key = ? AND call_id <> ?')
          .all(scopeKey, callId) as unknown as CallRow[]).some(row => strings(row.person_ids_json).includes(personId));
        if (!elsewhere) this.database.prepare('DELETE FROM people WHERE scope_key = ? AND person_id = ?').run(scopeKey, personId);
      }
      this.database.prepare(`
        INSERT INTO person_calls (scope_key, call_id, thread_id, status, person_ids_json, created_person_ids_json, pending_name, started_at, updated_at)
        VALUES (?, ?, NULL, 'discarded', '[]', '[]', NULL, ?, ?)
        ON CONFLICT(scope_key, call_id) DO UPDATE SET thread_id = NULL, status = 'discarded', person_ids_json = '[]',
          created_person_ids_json = '[]', pending_name = NULL, updated_at = excluded.updated_at
      `).run(scopeKey, callId, call?.startedAt ?? at, at);
      return call !== null && call.status !== 'discarded';
    });
  }

  items(scopeKey: string): readonly PersonMemoryItem[] {
    const rows = this.database.prepare(`
      SELECT i.item_id, i.call_id, i.kind, i.person_id, i.text, i.evidence, i.disclosure_json, i.observed_at
      FROM person_memory_items i JOIN person_calls c ON c.scope_key = i.scope_key AND c.call_id = i.call_id
      WHERE i.scope_key = ? AND c.status = 'remembered' ORDER BY i.observed_at DESC, i.ordinal ASC LIMIT 2000
    `).all(scopeKey) as unknown as ItemRow[];
    return Object.freeze(rows.map(row => Object.freeze({
      id: row.item_id, callId: row.call_id, kind: row.kind, text: row.text, disclosure: parsedDisclosure(row.disclosure_json),
      observedAt: row.observed_at, ...(row.person_id ? { personId: row.person_id } : {}), ...(row.evidence ? { evidence: row.evidence } : {}),
    })));
  }

  setItemDisclosure(scopeKey: string, itemId: string, disclosure: MemoryDisclosure): boolean {
    return Number(this.database.prepare('UPDATE person_memory_items SET disclosure_json = ? WHERE scope_key = ? AND item_id = ?')
      .run(JSON.stringify(disclosure), scopeKey, itemId).changes) > 0;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function callOf(row: CallRow): PersonCall {
  return Object.freeze({
    callId: row.call_id, status: row.status, personIds: Object.freeze(strings(row.person_ids_json)),
    createdPersonIds: Object.freeze(strings(row.created_person_ids_json)), startedAt: row.started_at, updatedAt: row.updated_at,
    ...(row.thread_id ? { threadId: row.thread_id } : {}), ...(row.pending_name ? { pendingName: row.pending_name } : {}),
    ...(row.source ? { source: row.source } : {}), ...(row.label ? { label: row.label } : {}),
  });
}

function linkOf(row: LinkRow): PlatformPersonLink {
  return Object.freeze({ platform: row.platform, userId: row.external_user_id, personId: row.person_id, displayName: row.display_name,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at });
}

function uniqueNames(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim().slice(0, 80)).filter(Boolean))].slice(0, 12);
}

/** An unreadable label is empty, which the disclosure rule reads as owner-only and sensitive. */
function parsedDisclosure(raw: string): MemoryDisclosure {
  try { return normalizeDisclosure(JSON.parse(raw)) ?? {}; } catch { return {}; }
}

function person(row: PersonRow): RememberedPerson {
  return Object.freeze({
    id: row.person_id, displayName: row.display_name, aliases: Object.freeze(strings(row.aliases_json)),
    howKnown: row.how_known ?? '', createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.forgotten_at ? { forgottenAt: row.forgotten_at } : {}),
  });
}
