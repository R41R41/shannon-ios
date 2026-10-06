import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type PersonPlatform = 'discord';
export type PersonLifecycleStatus = 'candidate' | 'active' | 'revoked';
export type PlatformIdentityStatus = 'candidate' | 'confirmed' | 'revoked';
export type PersonIdentityEventAction =
  | 'candidate-created'
  | 'identity-confirmed'
  | 'identity-corrected'
  | 'person-corrected'
  | 'identity-revoked'
  | 'person-deleted';

export interface PersonPlatformIdentity {
  readonly platform: PersonPlatform;
  readonly externalUserId: string;
  readonly status: PlatformIdentityStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly revokedAt: string | null;
}

export interface PersonRecord {
  readonly id: string;
  readonly displayName: string;
  readonly status: PersonLifecycleStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly identities: readonly PersonPlatformIdentity[];
}

export interface PersonIdentityAuditEvent {
  readonly id: string;
  readonly personId: string;
  readonly action: PersonIdentityEventAction;
  readonly platform: PersonPlatform | null;
  readonly occurredAt: string;
}

export interface PersonIdentityStore {
  list(scopeKey: string): readonly PersonRecord[];
  audit(scopeKey: string, limit?: number): readonly PersonIdentityAuditEvent[];
  createCandidate(scopeKey: string, input: {
    displayName: string;
    platform: PersonPlatform;
    externalUserId: string;
  }, at: string): PersonRecord;
  confirm(scopeKey: string, personId: string, platform: PersonPlatform, expectedRevision: number, at: string): PersonRecord;
  correct(scopeKey: string, personId: string, platform: PersonPlatform, expectedRevision: number, input: {
    externalUserId?: string;
    displayName?: string;
  }, at: string): PersonRecord;
  revoke(scopeKey: string, personId: string, platform: PersonPlatform, expectedRevision: number, at: string): PersonRecord;
  delete(scopeKey: string, personId: string, expectedRevision: number, at: string): { deleted: true; personId: string };
}

export class PersonIdentityError extends Error {
  constructor(readonly code:
    | 'PERSON_NOT_FOUND'
    | 'PERSON_IDENTITY_NOT_FOUND'
    | 'PERSON_IDENTITY_CONFLICT'
    | 'PERSON_IDENTITY_STALE'
    | 'PERSON_STALE') {
    super(code);
    this.name = 'PersonIdentityError';
  }
}

interface PersonRow {
  person_id: string;
  display_name: string;
  lifecycle_status: PersonLifecycleStatus;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface IdentityRow {
  platform: PersonPlatform;
  external_user_id: string;
  verification_status: PlatformIdentityStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  revoked_at: string | null;
}

export class SQLitePersonIdentityStore implements PersonIdentityStore {
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
      CREATE TABLE IF NOT EXISTS person_platform_identities (
        scope_key TEXT NOT NULL,
        person_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('discord')),
        external_user_id TEXT NOT NULL,
        verification_status TEXT NOT NULL CHECK (verification_status IN ('candidate','confirmed','revoked')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        revoked_at TEXT,
        PRIMARY KEY (scope_key, person_id, platform),
        UNIQUE (scope_key, platform, external_user_id),
        FOREIGN KEY (scope_key, person_id) REFERENCES people(scope_key, person_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS person_identity_events (
        scope_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        action TEXT NOT NULL,
        platform TEXT,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, event_id)
      );
      CREATE INDEX IF NOT EXISTS person_identity_events_scope_time
        ON person_identity_events(scope_key, occurred_at DESC);
    `);
  }

  list(scopeKey: string): readonly PersonRecord[] {
    const rows = this.database.prepare(`
      SELECT person_id, display_name, lifecycle_status, revision, created_at, updated_at
      FROM people WHERE scope_key = ? ORDER BY display_name COLLATE NOCASE, person_id
    `).all(scopeKey) as unknown as PersonRow[];
    return Object.freeze(rows.map(row => this.person(scopeKey, row)));
  }

  audit(scopeKey: string, limit = 100): readonly PersonIdentityAuditEvent[] {
    const boundedLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT event_id, person_id, action, platform, occurred_at
      FROM person_identity_events WHERE scope_key = ?
      ORDER BY occurred_at DESC, event_id DESC LIMIT ?
    `).all(scopeKey, boundedLimit) as unknown as Array<{
      event_id: string;
      person_id: string;
      action: PersonIdentityEventAction;
      platform: PersonPlatform | null;
      occurred_at: string;
    }>;
    return Object.freeze(rows.map(row => Object.freeze({
      id: row.event_id,
      personId: row.person_id,
      action: row.action,
      platform: row.platform,
      occurredAt: row.occurred_at,
    })));
  }

  createCandidate(scopeKey: string, input: {
    displayName: string;
    platform: PersonPlatform;
    externalUserId: string;
  }, at: string): PersonRecord {
    const personId = randomUUID();
    return this.transaction(() => {
      try {
        this.database.prepare(`
          INSERT INTO people
            (scope_key, person_id, display_name, lifecycle_status, revision, created_at, updated_at)
          VALUES (?, ?, ?, 'candidate', 1, ?, ?)
        `).run(scopeKey, personId, input.displayName, at, at);
        this.database.prepare(`
          INSERT INTO person_platform_identities
            (scope_key, person_id, platform, external_user_id, verification_status, revision,
             created_at, updated_at, confirmed_at, revoked_at)
          VALUES (?, ?, ?, ?, 'candidate', 1, ?, ?, NULL, NULL)
        `).run(scopeKey, personId, input.platform, input.externalUserId, at, at);
      } catch (error) {
        if (isUniqueConstraint(error)) throw new PersonIdentityError('PERSON_IDENTITY_CONFLICT');
        throw error;
      }
      this.appendEvent(scopeKey, personId, 'candidate-created', input.platform, at);
      return this.requiredPerson(scopeKey, personId);
    });
  }

  confirm(
    scopeKey: string,
    personId: string,
    platform: PersonPlatform,
    expectedRevision: number,
    at: string,
  ): PersonRecord {
    return this.transaction(() => {
      const identity = this.requiredIdentity(scopeKey, personId, platform);
      this.assertIdentityRevision(identity, expectedRevision);
      if (identity.verification_status === 'confirmed') return this.requiredPerson(scopeKey, personId);
      this.database.prepare(`
        UPDATE person_platform_identities SET verification_status = 'confirmed', revision = revision + 1,
          updated_at = ?, confirmed_at = ?, revoked_at = NULL
        WHERE scope_key = ? AND person_id = ? AND platform = ?
      `).run(at, at, scopeKey, personId, platform);
      this.database.prepare(`
        UPDATE people SET lifecycle_status = 'active', revision = revision + 1, updated_at = ?
        WHERE scope_key = ? AND person_id = ?
      `).run(at, scopeKey, personId);
      this.appendEvent(scopeKey, personId, 'identity-confirmed', platform, at);
      return this.requiredPerson(scopeKey, personId);
    });
  }

  correct(
    scopeKey: string,
    personId: string,
    platform: PersonPlatform,
    expectedRevision: number,
    input: { externalUserId?: string; displayName?: string },
    at: string,
  ): PersonRecord {
    return this.transaction(() => {
      const identity = this.requiredIdentity(scopeKey, personId, platform);
      this.assertIdentityRevision(identity, expectedRevision);
      const externalUserId = input.externalUserId ?? identity.external_user_id;
      const identityChanged = externalUserId !== identity.external_user_id;
      try {
        this.database.prepare(`
          UPDATE person_platform_identities SET external_user_id = ?,
            verification_status = CASE WHEN ? THEN 'candidate' ELSE verification_status END,
            revision = revision + 1, updated_at = ?,
            confirmed_at = CASE WHEN ? THEN NULL ELSE confirmed_at END,
            revoked_at = CASE WHEN ? THEN NULL ELSE revoked_at END
          WHERE scope_key = ? AND person_id = ? AND platform = ?
        `).run(externalUserId, identityChanged ? 1 : 0, at, identityChanged ? 1 : 0,
          identityChanged ? 1 : 0, scopeKey, personId, platform);
      } catch (error) {
        if (isUniqueConstraint(error)) throw new PersonIdentityError('PERSON_IDENTITY_CONFLICT');
        throw error;
      }
      this.database.prepare(`
        UPDATE people SET display_name = COALESCE(?, display_name),
          lifecycle_status = CASE WHEN ? THEN 'candidate' ELSE lifecycle_status END,
          revision = revision + 1, updated_at = ?
        WHERE scope_key = ? AND person_id = ?
      `).run(input.displayName ?? null, identityChanged ? 1 : 0, at, scopeKey, personId);
      this.appendEvent(
        scopeKey,
        personId,
        identityChanged ? 'identity-corrected' : 'person-corrected',
        platform,
        at,
      );
      return this.requiredPerson(scopeKey, personId);
    });
  }

  revoke(
    scopeKey: string,
    personId: string,
    platform: PersonPlatform,
    expectedRevision: number,
    at: string,
  ): PersonRecord {
    return this.transaction(() => {
      const identity = this.requiredIdentity(scopeKey, personId, platform);
      this.assertIdentityRevision(identity, expectedRevision);
      if (identity.verification_status === 'revoked') return this.requiredPerson(scopeKey, personId);
      this.database.prepare(`
        UPDATE person_platform_identities SET verification_status = 'revoked', revision = revision + 1,
          updated_at = ?, revoked_at = ?
        WHERE scope_key = ? AND person_id = ? AND platform = ?
      `).run(at, at, scopeKey, personId, platform);
      const confirmed = (this.database.prepare(`
        SELECT COUNT(*) AS count FROM person_platform_identities
        WHERE scope_key = ? AND person_id = ? AND verification_status = 'confirmed'
      `).get(scopeKey, personId) as unknown as { count: number }).count;
      this.database.prepare(`
        UPDATE people SET lifecycle_status = ?, revision = revision + 1, updated_at = ?
        WHERE scope_key = ? AND person_id = ?
      `).run(confirmed > 0 ? 'active' : 'revoked', at, scopeKey, personId);
      this.appendEvent(scopeKey, personId, 'identity-revoked', platform, at);
      return this.requiredPerson(scopeKey, personId);
    });
  }

  delete(scopeKey: string, personId: string, expectedRevision: number, at: string): { deleted: true; personId: string } {
    return this.transaction(() => {
      const person = this.requiredPersonRow(scopeKey, personId);
      if (person.revision !== expectedRevision) throw new PersonIdentityError('PERSON_STALE');
      this.database.prepare('DELETE FROM people WHERE scope_key = ? AND person_id = ?').run(scopeKey, personId);
      this.appendEvent(scopeKey, personId, 'person-deleted', null, at);
      return { deleted: true as const, personId };
    });
  }

  close(): void {
    this.database.close();
  }

  private person(scopeKey: string, row: PersonRow): PersonRecord {
    const identities = this.database.prepare(`
      SELECT platform, external_user_id, verification_status, revision, created_at, updated_at,
        confirmed_at, revoked_at
      FROM person_platform_identities WHERE scope_key = ? AND person_id = ? ORDER BY platform
    `).all(scopeKey, row.person_id) as unknown as IdentityRow[];
    return Object.freeze({
      id: row.person_id,
      displayName: row.display_name,
      status: row.lifecycle_status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      identities: Object.freeze(identities.map(identity => Object.freeze({
        platform: identity.platform,
        externalUserId: identity.external_user_id,
        status: identity.verification_status,
        revision: identity.revision,
        createdAt: identity.created_at,
        updatedAt: identity.updated_at,
        confirmedAt: identity.confirmed_at,
        revokedAt: identity.revoked_at,
      }))),
    });
  }

  private requiredPerson(scopeKey: string, personId: string): PersonRecord {
    return this.person(scopeKey, this.requiredPersonRow(scopeKey, personId));
  }

  private requiredPersonRow(scopeKey: string, personId: string): PersonRow {
    const row = this.database.prepare(`
      SELECT person_id, display_name, lifecycle_status, revision, created_at, updated_at
      FROM people WHERE scope_key = ? AND person_id = ?
    `).get(scopeKey, personId) as unknown as PersonRow | undefined;
    if (!row) throw new PersonIdentityError('PERSON_NOT_FOUND');
    return row;
  }

  private requiredIdentity(scopeKey: string, personId: string, platform: PersonPlatform): IdentityRow {
    this.requiredPersonRow(scopeKey, personId);
    const row = this.database.prepare(`
      SELECT platform, external_user_id, verification_status, revision, created_at, updated_at,
        confirmed_at, revoked_at
      FROM person_platform_identities WHERE scope_key = ? AND person_id = ? AND platform = ?
    `).get(scopeKey, personId, platform) as unknown as IdentityRow | undefined;
    if (!row) throw new PersonIdentityError('PERSON_IDENTITY_NOT_FOUND');
    return row;
  }

  private assertIdentityRevision(identity: IdentityRow, expectedRevision: number): void {
    if (identity.revision !== expectedRevision) throw new PersonIdentityError('PERSON_IDENTITY_STALE');
  }

  private appendEvent(
    scopeKey: string,
    personId: string,
    action: PersonIdentityEventAction,
    platform: PersonPlatform | null,
    at: string,
  ): void {
    this.database.prepare(`
      INSERT INTO person_identity_events (scope_key, event_id, person_id, action, platform, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scopeKey, randomUUID(), personId, action, platform, at);
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

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}
