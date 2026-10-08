import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteModelModeStore } from '../src/infra/sqlite/modelModeStore.js';
import { modelModePort, type ModelModePreference } from '../src/contracts/modelModeContract.js';
import { createModelModeRoute } from '../src/infra/http/modelModeRoutes.js';
import { SQLiteDeviceAuthStore } from '../src/infra/auth/deviceAuth.js';
import { sendJson } from '../src/infra/http/serverHttp.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function databasePath() { const directory = mkdtempSync(join(tmpdir(), 'shannon-model-mode-')); directories.push(directory); return join(directory, 'state.db'); }
const capability = (_scope: string, _preference: ModelModePreference) => ({
  available: { haiku: true, sonnet: true }, models: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' }, appliesTo: ['conversation'] as const,
});

describe('durable owner model preference', () => {
  it('is additive, persists across reopen, and changes only the selected scope', () => {
    const path = databasePath(), before = new DatabaseSync(path);
    before.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('existing'); PRAGMA user_version=42"); before.close();
    const store = new SQLiteModelModeStore(path);
    expect(store.read('owner')).toEqual({ mode: 'haiku', revision: 0 });
    expect(store.compareAndSet('owner', 0, 'sonnet')).toEqual({ mode: 'sonnet', revision: 1 });
    expect(store.compareAndSet('owner', 1, 'sonnet')).toEqual({ mode: 'sonnet', revision: 1 });
    expect(store.read('other')).toEqual({ mode: 'haiku', revision: 0 }); store.close();
    const reopened = new SQLiteModelModeStore(path); expect(reopened.read('owner')).toEqual({ mode: 'sonnet', revision: 1 }); reopened.close();
    const retained = new DatabaseSync(path, { readOnly: true });
    expect(retained.prepare('SELECT value FROM retained').all()).toEqual([{ value: 'existing' }]);
    expect(retained.prepare('PRAGMA user_version').get()).toEqual({ user_version: 42 }); retained.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('has one CAS winner across independent connections and preserves the winner after a failed save', () => {
    const path = databasePath(), one = new SQLiteModelModeStore(path), two = new SQLiteModelModeStore(path);
    const original = two.read('owner'); one.compareAndSet('owner', original.revision, 'sonnet');
    expect(two.compareAndSet('owner', original.revision, 'haiku')).toBeNull();
    const fault = new DatabaseSync(path); fault.exec("CREATE TRIGGER refuse_save BEFORE UPDATE ON primary_model_preferences BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    expect(() => two.compareAndSet('owner', 1, 'haiku')).toThrow();
    expect(one.read('owner')).toEqual({ mode: 'sonnet', revision: 1 }); fault.close(); one.close(); two.close();
    const reopened = new SQLiteModelModeStore(path, false); expect(reopened.read('owner')).toEqual({ mode: 'sonnet', revision: 1 }); reopened.close();
  });
  it('reads an older schema without changing it, then observes the API migration and commits', () => {
    const path = databasePath(), original = new DatabaseSync(path); original.exec('CREATE TABLE historical(id INTEGER)'); original.close();
    const worker = new SQLiteModelModeStore(path, false);
    expect(worker.read('owner')).toEqual({ mode: 'haiku', revision: 0 });
    const check = new DatabaseSync(path); expect(check.prepare("SELECT name FROM sqlite_master WHERE name='primary_model_preferences'").all()).toEqual([]); check.close();
    expect(() => worker.compareAndSet('owner', 0, 'sonnet')).toThrow('MODEL_MODE_READ_ONLY');
    const api = new SQLiteModelModeStore(path); api.compareAndSet('owner', 0, 'sonnet');
    expect(worker.read('owner')).toEqual({ mode: 'sonnet', revision: 1 }); api.close(); worker.close();
    expect(() => worker.read('owner')).toThrow(); // A failed read is never a default preference.
  });
  it('binds capabilities to the captured preference even if another writer changes it during projection', () => {
    const path = databasePath(), store = new SQLiteModelModeStore(path), other = new SQLiteModelModeStore(path);
    let changeAt = 0;
    const port = modelModePort(store, (scope, captured) => {
      if (captured.revision === changeAt) { changeAt = -1; other.compareAndSet(scope, captured.revision, captured.mode === 'haiku' ? 'sonnet' : 'haiku'); }
      return { ...capability(scope, captured), appliesTo: captured.mode === 'haiku' ? ['conversation'] : ['conversation', 'minecraft-planning'] };
    });
    expect(port.snapshot('owner')).toMatchObject({ mode: 'haiku', revision: 0, appliesTo: ['conversation'] });
    changeAt = 2;
    expect(port.change('owner', 1, 'haiku')).toMatchObject({ mode: 'haiku', revision: 2, appliesTo: ['conversation'] });
    expect(store.read('owner')).toEqual({ mode: 'sonnet', revision: 3 }); store.close(); other.close();
  });
});

async function withRoute(run: (request: (method: string, body?: unknown, token?: string, query?: string) => Promise<{ status: number; body: any }>, parts: { store: SQLiteModelModeStore; database: DatabaseSync; revoke(): void; unavailable(): void }) => Promise<void>) {
  const path = databasePath(), store = new SQLiteModelModeStore(path), database = new DatabaseSync(path);
  const auth = new SQLiteDeviceAuthStore({ path, pepper: 'synthetic-model-mode-pepper-longer-than-32-characters' });
  const owner = auth.pair(auth.issuePairingCode('owner').code)!, other = auth.pair(auth.issuePairingCode('other').code)!;
  let available = true;
  const modes = modelModePort(store, (scope, preference) => ({ ...capability(scope, preference), available: { haiku: true, sonnet: available } }));
  const route = createModelModeRoute({ modes, ownerScopeKey: 'owner' });
  const server = createServer((request, response) => {
    const principal = auth.authenticate(request.headers.authorization);
    if (!principal) { sendJson(response, 401, { error: 'UNAUTHORIZED' }); return; }
    void route(request, response, principal);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  const request = async (method: string, body?: unknown, token = owner.token, query = '') => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/model-mode${query}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run((method, body, token, query) => request(method, body, token === 'other' ? other.token : token, query), {
      store, database, revoke: () => { auth.revoke(owner.deviceId); }, unavailable: () => { available = false; },
    });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); auth.close(); database.close(); store.close(); }
}

describe('paired owner settings HTTP contract', () => {
  it('GET/PUT use the principal scope, refuse another owner and revocation, and never accept forged authority', async () => {
    await withRoute(async (request, parts) => {
      expect(await request('GET', undefined, 'other')).toEqual({ status: 403, body: { error: 'MODEL_MODE_OWNER_ONLY' } });
      expect(await request('PUT', { scopeKey: 'other', mode: 'sonnet', expectedRevision: 0 })).toMatchObject({ status: 400 });
      expect(await request('GET', undefined, undefined, '?scopeKey=other')).toMatchObject({ status: 200, body: { mode: 'haiku', revision: 0 } });
      expect(await request('PUT', { mode: 'sonnet', expectedRevision: 0 })).toMatchObject({ status: 200, body: { mode: 'sonnet', revision: 1 } });
      expect(parts.store.read('other')).toEqual({ mode: 'haiku', revision: 0 });
      parts.revoke(); expect(await request('GET')).toEqual({ status: 401, body: { error: 'UNAUTHORIZED' } });
    });
  });
  it('returns the current canonical value on stale CAS, unavailable selection, and rolled-back write failures', async () => {
    await withRoute(async (request, parts) => {
      parts.unavailable();
      expect(await request('PUT', { mode: 'sonnet', expectedRevision: 0 })).toMatchObject({ status: 409, body: { error: 'MODEL_MODE_UNAVAILABLE', current: { mode: 'haiku', revision: 0 } } });
      parts.store.compareAndSet('owner', 0, 'sonnet');
      expect(await request('PUT', { mode: 'haiku', expectedRevision: 0 })).toMatchObject({ status: 409, body: { error: 'MODEL_MODE_CONFLICT', current: { mode: 'sonnet', revision: 1 } } });
      parts.database.exec("CREATE TRIGGER refuse_save BEFORE UPDATE ON primary_model_preferences BEGIN SELECT RAISE(ABORT,'private fixture error'); END");
      const failed = await request('PUT', { mode: 'haiku', expectedRevision: 1 });
      expect(failed).toMatchObject({ status: 503, body: { error: 'MODEL_MODE_STORE_UNAVAILABLE', current: { mode: 'sonnet', revision: 1 } } });
      expect(JSON.stringify(failed)).not.toContain('private fixture');
      expect(await request('GET')).toMatchObject({ status: 200, body: { mode: 'sonnet', revision: 1 } });
    });
  });
  it('strictly validates closed modes and revisions before any write', async () => {
    await withRoute(async (request, parts) => {
      for (const body of [{ mode: ['haiku'], expectedRevision: 0 }, { mode: 'other', expectedRevision: 0 }, { mode: 'sonnet', expectedRevision: '0' },
        { mode: 'sonnet', expectedRevision: -1 }, { mode: 'sonnet', expectedRevision: 0.5 }, { mode: 'sonnet', expectedRevision: 0, model: 'other' }]) {
        expect(await request('PUT', body)).toEqual({ status: 400, body: { error: 'MODEL_MODE_INVALID' } });
      }
      expect(await request('POST', {})).toMatchObject({ status: 405 });
      expect(parts.store.read('owner')).toEqual({ mode: 'haiku', revision: 0 });
    });
  });
  it('returns a closed 503 for an unreadable stored setting instead of fabricating Haiku/current', async () => {
    await withRoute(async (request, parts) => {
      parts.store.compareAndSet('owner', 0, 'sonnet');
      parts.database.exec('ALTER TABLE primary_model_preferences RENAME COLUMN mode TO broken');
      expect(await request('GET')).toEqual({ status: 503, body: { error: 'MODEL_MODE_STORE_UNAVAILABLE' } });
      parts.database.exec('ALTER TABLE primary_model_preferences RENAME COLUMN broken TO mode');
      expect(await request('GET')).toMatchObject({ status: 200, body: { mode: 'sonnet', revision: 1 } });
    });
  });
});
