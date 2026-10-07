/** Paired devices and pairing codes, kept (Syzygy ADR-0008 stage 3, S2: the SQLite part of `deviceAuth.ts` and the pairing code's normal form, moved unchanged into the auth store folder; the pepper stays there). */
import { DatabaseSync } from 'node:sqlite';
import type { IssuedPairingCode, ShannonDevicePrincipal, ShannonDeviceRecord, ShannonPairingResult, SQLiteDeviceAuthOptions } from '../deviceAuth.js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';

const PAIRING_LIFETIME_MS = 30 * 60_000;

const DEVICE_LIFETIME_MS = 365 * 24 * 60 * 60_000;

const MAXIMUM_PAIRING_ATTEMPTS = 10;

const MAXIMUM_ACTIVE_DEVICES = 8;

const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface PairingRow {
  code_hash: string;
  scope_key: string;
  expires_at: number;
  failed_attempts: number;
}

interface DeviceRow {
  device_id: string;
  scope_key: string;
  display_name: string;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * Device credentials live beside Shannon's durable state, but only keyed hashes
 * are persisted. The short-lived pairing code and device token are returned once.
 */
export class SQLiteDeviceAuthStore {
  private readonly database: DatabaseSync;
  private readonly now: () => number;

  constructor(private readonly options: SQLiteDeviceAuthOptions) {
    if (!options.path.trim()) throw new Error('SHANNON_DATABASE_PATH is required');
    if (options.pepper.trim().length < 32) throw new Error('SHANNON_AUTH_PEPPER must contain at least 32 characters');
    this.now = options.now ?? Date.now;
    prepareDatabaseLocation(options.path);
    this.database = new DatabaseSync(options.path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS device_pairing (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        code_hash TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0)
      );

      CREATE TABLE IF NOT EXISTS device_tokens (
        device_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS device_tokens_active_expiry
        ON device_tokens (revoked_at, expires_at);
    `);
    secureDatabaseFiles(options.path);
  }

  issuePairingCode(scopeKey = 'owner'): IssuedPairingCode {
    const normalizedScopeKey = validateScopeKey(scopeKey);
    const issuedAt = this.now();
    const expiresAt = issuedAt + PAIRING_LIFETIME_MS;
    const normalizedCode = randomBytes(6).toString('hex').toUpperCase();
    this.database.prepare(`
      INSERT INTO device_pairing
        (singleton, code_hash, scope_key, created_at, expires_at, failed_attempts)
      VALUES (1, ?, ?, ?, ?, 0)
      ON CONFLICT(singleton) DO UPDATE SET
        code_hash = excluded.code_hash,
        scope_key = excluded.scope_key,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        failed_attempts = 0
    `).run(this.digest(normalizedCode), normalizedScopeKey, issuedAt, expiresAt);
    secureDatabaseFiles(this.options.path);
    return Object.freeze({
      code: normalizedCode.match(/.{4}/g)?.join('-') ?? normalizedCode,
      scopeKey: normalizedScopeKey,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  pair(code: string, displayName = 'iPhone'): ShannonPairingResult | null {
    const normalizedCode = normalizePairingCode(code);
    if (!normalizedCode) return null;
    const pairedAt = this.now();
    let result: ShannonPairingResult | null = null;

    this.transaction(() => {
      const row = this.database.prepare(`
        SELECT code_hash, scope_key, expires_at, failed_attempts
        FROM device_pairing
        WHERE singleton = 1
      `).get() as unknown as PairingRow | undefined;
      if (!row || row.expires_at <= pairedAt || row.failed_attempts >= MAXIMUM_PAIRING_ATTEMPTS) return;

      this.database.prepare(`
        UPDATE device_pairing SET failed_attempts = failed_attempts + 1 WHERE singleton = 1
      `).run();
      if (!safeHashEqual(row.code_hash, this.digest(normalizedCode))) return;

      this.database.prepare(`
        DELETE FROM device_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL
      `).run(pairedAt);
      const active = this.database.prepare(`
        SELECT COUNT(*) AS count FROM device_tokens WHERE expires_at > ? AND revoked_at IS NULL
      `).get(pairedAt) as unknown as { count: number };
      if (Number(active.count) >= MAXIMUM_ACTIVE_DEVICES) return;

      const token = randomBytes(32).toString('base64url');
      const deviceId = randomBytes(8).toString('hex');
      const expiresAt = pairedAt + DEVICE_LIFETIME_MS;
      const name = normalizeDisplayName(displayName);
      this.database.prepare(`
        INSERT INTO device_tokens
          (device_id, token_hash, scope_key, display_name, created_at, expires_at, last_used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(deviceId, this.digest(token), row.scope_key, name, pairedAt, expiresAt);
      this.database.prepare('DELETE FROM device_pairing WHERE singleton = 1').run();
      result = Object.freeze({
        token,
        deviceId,
        scopeKey: row.scope_key,
        displayName: name,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    });
    return result;
  }

  authenticate(header: string | undefined): ShannonDevicePrincipal | null {
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length);
    if (!DEVICE_TOKEN_PATTERN.test(token)) return null;
    const authenticatedAt = this.now();
    const row = this.database.prepare(`
      SELECT device_id, scope_key, display_name, expires_at, last_used_at, revoked_at
      FROM device_tokens
      WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL
    `).get(this.digest(token), authenticatedAt) as unknown as DeviceRow | undefined;
    if (!row) return null;
    if (row.last_used_at === null || authenticatedAt - row.last_used_at >= 5 * 60_000) {
      this.database.prepare('UPDATE device_tokens SET last_used_at = ? WHERE device_id = ?')
        .run(authenticatedAt, row.device_id);
    }
    return Object.freeze({
      deviceId: row.device_id,
      scopeKey: row.scope_key,
      displayName: row.display_name,
    });
  }

  revoke(deviceId: string): boolean {
    const result = this.database.prepare(`
      UPDATE device_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL
    `).run(this.now(), deviceId);
    secureDatabaseFiles(this.options.path);
    return Number(result.changes) > 0;
  }

  revokeForScope(deviceId: string, scopeKey: string): boolean {
    const result = this.database.prepare(`
      UPDATE device_tokens SET revoked_at = ?
      WHERE device_id = ? AND scope_key = ? AND revoked_at IS NULL
    `).run(this.now(), deviceId, scopeKey);
    secureDatabaseFiles(this.options.path);
    return Number(result.changes) > 0;
  }

  listDevices(): readonly ShannonDeviceRecord[] {
    const rows = this.database.prepare(`
      SELECT device_id, scope_key, display_name, expires_at, last_used_at, revoked_at
      FROM device_tokens
      ORDER BY created_at ASC
    `).all() as unknown as DeviceRow[];
    return Object.freeze(rows.map(deviceRecord));
  }

  listActiveDevicesForScope(scopeKey: string): readonly ShannonDeviceRecord[] {
    const timestamp = this.now();
    const rows = this.database.prepare(`
      SELECT device_id, scope_key, display_name, expires_at, last_used_at, revoked_at
      FROM device_tokens
      WHERE scope_key = ? AND expires_at > ? AND revoked_at IS NULL
      ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC
    `).all(scopeKey, timestamp) as unknown as DeviceRow[];
    return Object.freeze(rows.map(deviceRecord));
  }

  close(): void {
    if (!this.database.isOpen) return;
    secureDatabaseFiles(this.options.path);
    this.database.close();
  }

  private digest(value: string): string {
    return createHmac('sha256', this.options.pepper).update(value).digest('hex');
  }

  private transaction(operation: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.database.exec('COMMIT');
      secureDatabaseFiles(this.options.path);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function deviceRecord(row: DeviceRow): Readonly<ShannonDeviceRecord> {
  return Object.freeze({
    deviceId: row.device_id,
    scopeKey: row.scope_key,
    displayName: row.display_name,
    expiresAt: new Date(row.expires_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  });
}

export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-F0-9]{12}$/.test(normalized) ? normalized : null;
}

function validateScopeKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) throw new Error('scopeKey must be 1..160 characters');
  return normalized;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  return normalized && normalized.length <= 80 ? normalized : 'iPhone';
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function prepareDatabaseLocation(path: string): void {
  if (path === ':memory:') return;
  const directory = dirname(path);
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(directory, 0o700);
}

function secureDatabaseFiles(path: string): void {
  if (path === ':memory:') return;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}
