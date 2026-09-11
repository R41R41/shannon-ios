import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePairingCode, SQLiteDeviceAuthStore } from '../src/deviceAuth.js';

const temporaryDirectories: string[] = [];
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

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-device-auth-test-'));
  temporaryDirectories.push(directory);
  return join(directory, 'shannon.sqlite');
}
