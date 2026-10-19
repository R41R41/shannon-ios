import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredPreviousAuthPepper, normalizePairingCode, SQLiteDeviceAuthStore } from '../src/infra/auth/deviceAuth.js';

const temporaryDirectories: string[] = [];
const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const pepper = 'test-pepper-that-is-longer-than-thirty-two-characters';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('paired device authentication', () => {
  it('issues a single-use code and persists only keyed hashes', () => {
    const path = databasePath();
    let timestamp = Date.parse('2026-08-31T00:00:00.000Z');
    const auth = new SQLiteDeviceAuthStore({ path, pepper, now: () => timestamp });
    const issued = auth.issuePairingCode('owner-a');
    expect(issued.code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);

    const paired = auth.pair(issued.code.toLowerCase(), 'RyoのiPhone');
    expect(paired).toMatchObject({ scopeKey: 'owner-a', displayName: 'RyoのiPhone' });
    expect(paired?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.pair(issued.code, 'second device')).toBeNull();
    expect(auth.authenticate(`Bearer ${paired?.token}`)).toMatchObject({
      deviceId: paired?.deviceId,
      scopeKey: 'owner-a',
    });
    expect(auth.authenticate('Bearer invalid')).toBeNull();

    const database = new DatabaseSync(path, { readOnly: true });
    const tokenRow = database.prepare('SELECT token_hash FROM device_tokens').get() as unknown as { token_hash: string };
    expect(tokenRow.token_hash).not.toContain(paired?.token);
    expect(tokenRow.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM device_pairing').get()).toEqual({ count: 0 });
    database.close();

    expect(auth.listDevices()).toHaveLength(1);
    expect(auth.revoke(paired?.deviceId ?? '')).toBe(true);
    expect(auth.authenticate(`Bearer ${paired?.token}`)).toBeNull();
    auth.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('expires codes and tokens and locks a code after ten failures', () => {
    const path = databasePath();
    let timestamp = Date.parse('2026-08-31T00:00:00.000Z');
    const auth = new SQLiteDeviceAuthStore({ path, pepper, now: () => timestamp });
    const expired = auth.issuePairingCode();
    timestamp += 30 * 60_000;
    expect(auth.pair(expired.code)).toBeNull();

    const locked = auth.issuePairingCode();
    for (let attempt = 0; attempt < 10; attempt += 1) expect(auth.pair('AAAA-BBBB-CCCC')).toBeNull();
    expect(auth.pair(locked.code)).toBeNull();

    const valid = auth.issuePairingCode();
    const paired = auth.pair(valid.code);
    timestamp += 366 * 24 * 60 * 60_000;
    expect(auth.authenticate(`Bearer ${paired?.token}`)).toBeNull();
    auth.close();
  });

  it('normalizes only a twelve-digit hexadecimal code', () => {
    expect(normalizePairingCode('abcd-1234-ef90')).toBe('ABCD1234EF90');
    expect(normalizePairingCode('ABCD 1234 EF90')).toBe('ABCD1234EF90');
    expect(normalizePairingCode('not-a-code')).toBeNull();
    expect(normalizePairingCode(undefined)).toBeNull();
  });

  it('lists and revokes active devices only inside the authenticated scope', () => {
    const path = databasePath();
    let timestamp = Date.parse('2026-08-31T00:00:00.000Z');
    const auth = new SQLiteDeviceAuthStore({ path, pepper, now: () => timestamp });
    const ownerA1 = auth.pair(auth.issuePairingCode('owner-a').code, 'iPhone');
    timestamp += 1_000;
    const ownerA2 = auth.pair(auth.issuePairingCode('owner-a').code, 'Mac');
    const ownerB = auth.pair(auth.issuePairingCode('owner-b').code, 'Other owner');

    expect(auth.listActiveDevicesForScope('owner-a').map(device => device.deviceId)).toEqual([
      ownerA2?.deviceId,
      ownerA1?.deviceId,
    ]);
    expect(auth.revokeForScope(ownerB?.deviceId ?? '', 'owner-a')).toBe(false);
    expect(auth.revokeForScope(ownerA2?.deviceId ?? '', 'owner-a')).toBe(true);
    expect(auth.listActiveDevicesForScope('owner-a').map(device => device.deviceId)).toEqual([
      ownerA1?.deviceId,
    ]);
    expect(auth.authenticate(`Bearer ${ownerA2?.token}`)).toBeNull();
    expect(auth.authenticate(`Bearer ${ownerB?.token}`)).not.toBeNull();
    auth.close();
  });
});

describe('pepper rotation (SHANNON_AUTH_PEPPER_PREVIOUS)', () => {
  const oldPepper = 'old-pepper-that-is-longer-than-thirty-two-characters';
  const newPepper = 'new-pepper-that-is-longer-than-thirty-two-characters';
  const start = Date.parse('2026-10-20T00:00:00.000Z');

  function pairedUnder(path: string, names: readonly string[]) {
    const auth = new SQLiteDeviceAuthStore({ path, pepper: oldPepper, now: () => start });
    const paired = names.map(name => auth.pair(auth.issuePairingCode('owner').code, name));
    auth.close();
    return paired;
  }

  function tokenHashes(path: string): Record<string, string> {
    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare('SELECT device_id, token_hash FROM device_tokens').all() as unknown as { device_id: string; token_hash: string }[];
    database.close();
    return Object.fromEntries(rows.map(row => [row.device_id, row.token_hash]));
  }

  it('matches under the new pepper alone, as before', () => {
    const path = databasePath();
    const auth = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: oldPepper, now: () => start });
    const paired = auth.pair(auth.issuePairingCode('owner').code, 'Mac');
    expect(auth.authenticate(`Bearer ${paired?.token}`)).toMatchObject({ deviceId: paired?.deviceId });
    expect(auth.pepperMigration()).toMatchObject({ previousPepperConfigured: true, activeDevices: 1, onCurrentPepper: 1, remaining: [] });
    auth.close();
  });

  it('rekeys a token made under the previous pepper on its first use, then matches it under the new one alone', () => {
    const path = databasePath();
    const [iphone, mac] = pairedUnder(path, ['iPhone', 'Mac']);
    const before = tokenHashes(path);
    const rotating = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: oldPepper, now: () => start + 1_000 });
    expect(rotating.pepperMigration()).toMatchObject({ activeDevices: 2, onCurrentPepper: 0 });
    expect(rotating.pepperMigration().remaining.map(device => device.displayName)).toEqual(['iPhone', 'Mac']);

    expect(rotating.authenticate(`Bearer ${iphone?.token}`)).toMatchObject({ deviceId: iphone?.deviceId, scopeKey: 'owner', displayName: 'iPhone' });
    const after = tokenHashes(path);
    expect(after[iphone?.deviceId ?? '']).not.toBe(before[iphone?.deviceId ?? '']);
    expect(after[mac?.deviceId ?? '']).toBe(before[mac?.deviceId ?? '']);
    const status = rotating.pepperMigration();
    expect(status).toMatchObject({ activeDevices: 2, onCurrentPepper: 1 });
    expect(status.remaining.map(device => device.deviceId)).toEqual([mac?.deviceId]);
    // The status carries no secret, token or digest.
    expect(JSON.stringify(status)).not.toMatch(/[a-f0-9]{32}|pepper-that/u);
    rotating.close();

    // PREVIOUS removed: the moved device still matches; the one that never came back does not.
    const rotated = new SQLiteDeviceAuthStore({ path, pepper: newPepper, now: () => start + 2_000 });
    expect(rotated.authenticate(`Bearer ${iphone?.token}`)).toMatchObject({ deviceId: iphone?.deviceId });
    expect(rotated.authenticate(`Bearer ${mac?.token}`)).toBeNull();
    expect(rotated.pepperMigration()).toMatchObject({ previousPepperConfigured: false, activeDevices: 2, onCurrentPepper: 1 });
    rotated.close();
  });

  it('without PREVIOUS behaves as before: a token from another pepper is refused and nothing is rewritten', () => {
    const path = databasePath();
    const [iphone] = pairedUnder(path, ['iPhone']);
    const before = tokenHashes(path);
    const auth = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: '', now: () => start + 1_000 });
    expect(auth.authenticate(`Bearer ${iphone?.token}`)).toBeNull();
    expect(tokenHashes(path)).toEqual(before);
    expect(auth.pepperMigration()).toMatchObject({ previousPepperConfigured: false, activeDevices: 1, onCurrentPepper: 0 });
    auth.close();
  });

  it('marks a row from before the pepper_id column once it matches under the current pepper', () => {
    const path = databasePath();
    const [iphone] = pairedUnder(path, ['iPhone']);
    const database = new DatabaseSync(path);
    database.exec('UPDATE device_tokens SET pepper_id = NULL');
    database.close();
    const auth = new SQLiteDeviceAuthStore({ path, pepper: oldPepper, now: () => start + 1_000 });
    expect(auth.pepperMigration()).toMatchObject({ activeDevices: 1, onCurrentPepper: 0 });
    expect(auth.authenticate(`Bearer ${iphone?.token}`)).toMatchObject({ deviceId: iphone?.deviceId });
    expect(auth.pepperMigration()).toMatchObject({ activeDevices: 1, onCurrentPepper: 1, remaining: [] });
    auth.close();
  });

  it('adds pepper_id to a table made before it, keeping the rows', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE device_tokens (
        device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, scope_key TEXT NOT NULL, display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
      );
      INSERT INTO device_tokens VALUES ('d1', 'aa', 'owner', 'Old Mac', 1, ${start + 60_000}, NULL, NULL);
    `);
    database.close();
    const auth = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: oldPepper, now: () => start });
    expect(auth.pepperMigration()).toMatchObject({ activeDevices: 1, onCurrentPepper: 0, remaining: [{ deviceId: 'd1', displayName: 'Old Mac', lastUsedAt: null }] });
    auth.close();
    const reopened = new SQLiteDeviceAuthStore({ path, pepper: newPepper, now: () => start });
    expect(reopened.listDevices()).toHaveLength(1);
    reopened.close();
  });

  it('never lets the previous pepper pass a revoked or expired token, and does not rekey it', () => {
    const path = databasePath();
    const [revoked, expiring] = pairedUnder(path, ['Revoked', 'Expiring']);
    const old = new SQLiteDeviceAuthStore({ path, pepper: oldPepper, now: () => start });
    expect(old.revoke(revoked?.deviceId ?? '')).toBe(true);
    old.close();
    const before = tokenHashes(path);
    const late = start + 366 * 24 * 60 * 60_000;
    const auth = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: oldPepper, now: () => late });
    expect(auth.authenticate(`Bearer ${revoked?.token}`)).toBeNull();
    expect(auth.authenticate(`Bearer ${expiring?.token}`)).toBeNull();
    expect(tokenHashes(path)).toEqual(before);
    expect(auth.pepperMigration()).toMatchObject({ activeDevices: 0, remaining: [] });
    auth.close();
  });

  it('accepts a pairing code issued under the previous pepper, and a fresh token is keyed by the new one', () => {
    const path = databasePath();
    const old = new SQLiteDeviceAuthStore({ path, pepper: oldPepper, now: () => start });
    const code = old.issuePairingCode('owner').code;
    old.close();
    const rotating = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: oldPepper, now: () => start + 1_000 });
    expect(rotating.pair('AAAA-BBBB-CCCC')).toBeNull();
    const paired = rotating.pair(code, 'iPad');
    expect(paired).toMatchObject({ displayName: 'iPad' });
    rotating.close();
    const rotated = new SQLiteDeviceAuthStore({ path, pepper: newPepper, now: () => start + 2_000 });
    expect(rotated.authenticate(`Bearer ${paired?.token}`)).toMatchObject({ deviceId: paired?.deviceId });
    expect(rotated.pepperMigration()).toMatchObject({ onCurrentPepper: 1, remaining: [] });
    rotated.close();
  });

  it('refuses a previous pepper equal to the current one or shorter than 32 characters, without echoing it', () => {
    const path = databasePath();
    expect(() => new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: newPepper })).toThrow('must differ');
    expect(() => new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: 'short' })).toThrow('at least 32');
    expect(configuredPreviousAuthPepper({ SHANNON_AUTH_PEPPER: newPepper })).toBeNull();
    expect(configuredPreviousAuthPepper({ SHANNON_AUTH_PEPPER: newPepper, SHANNON_AUTH_PEPPER_PREVIOUS: '  ' })).toBeNull();
    expect(configuredPreviousAuthPepper({ SHANNON_AUTH_PEPPER: newPepper, SHANNON_AUTH_PEPPER_PREVIOUS: ` ${oldPepper} ` })).toBe(oldPepper);
    for (const previous of [newPepper, ` ${newPepper}`, 'short']) {
      let message = '';
      try { configuredPreviousAuthPepper({ SHANNON_AUTH_PEPPER: newPepper, SHANNON_AUTH_PEPPER_PREVIOUS: previous }); } catch (error) { message = String(error); }
      expect(message).toMatch(/SHANNON_AUTH_PEPPER_PREVIOUS must/u);
      expect(message).not.toContain('pepper-that');
    }
  });
});

describe('authCli pepper-status', () => {
  it('prints counts and display names only, and says when PREVIOUS can go', () => {
    const path = databasePath();
    const oldPepper = 'old-pepper-that-is-longer-than-thirty-two-characters';
    const newPepper = 'new-pepper-that-is-longer-than-thirty-two-characters';
    const old = new SQLiteDeviceAuthStore({ path, pepper: oldPepper });
    const iphone = old.pair(old.issuePairingCode('owner').code, 'RyoのiPhone');
    old.pair(old.issuePairingCode('owner').code, 'Minecraft の体');
    old.close();
    const environment = { ...process.env, SHANNON_AUTH_MODE: 'paired', SHANNON_DATABASE_PATH: path, SHANNON_AUTH_PEPPER: newPepper, SHANNON_AUTH_PEPPER_PREVIOUS: oldPepper };
    const run = () => execFileSync(process.execPath, ['--import', 'tsx', 'src/authCli.ts', 'pepper-status'], { cwd: apiRoot, env: environment, encoding: 'utf8' });

    const first = run();
    expect(first).toContain('SHANNON_AUTH_PEPPER_PREVIOUS: あり');
    expect(first).toContain('有効な端末: 2（新しい値に移った: 0、まだ: 2）');
    expect(first).toContain('RyoのiPhone');
    expect(first).toContain('Minecraft の体');
    expect(first).toMatch(/^remaining=2$/mu);
    expect(first).not.toMatch(/[a-f0-9]{32}|pepper-that/u);
    expect(first).not.toContain(iphone?.token);

    const rotating = new SQLiteDeviceAuthStore({ path, pepper: newPepper, previousPepper: oldPepper });
    rotating.revoke(rotating.listDevices().find(device => device.displayName === 'Minecraft の体')?.deviceId ?? '');
    expect(rotating.authenticate(`Bearer ${iphone?.token}`)).not.toBeNull();
    rotating.close();
    const done = run();
    expect(done).toMatch(/^remaining=0$/mu);
    expect(done).toContain('SHANNON_AUTH_PEPPER_PREVIOUS を外せます');
  });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-device-auth-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'shannon.sqlite');
}
