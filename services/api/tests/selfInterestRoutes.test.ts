import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSelfInterestRoute } from '../src/infra/http/selfInterestRoutes.js';
import { selfInterestWorld } from './support/selfInterestWorld.js';

const servers: Server[] = [];
const worlds: ReturnType<typeof selfInterestWorld>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const w of worlds.splice(0)) w.close();
});
async function serve(ownerScope: string | null, enabled = true, audience: { alone: boolean } = { alone: true }) {
  const w = selfInterestWorld(enabled); worlds.push(w);
  if (enabled) { w.add('天文'); await w.night(); }
  const route = createSelfInterestRoute({ ownerScopeKey: 'owner', interests: w.owner, ownerAlone: () => audience.alone });
  let arrived: (() => void) | null = null;
  const server = createServer((request, response) => {
    void route(request, response, ownerScope ? { scopeKey: ownerScope } : null, new URL(request.url ?? '/', 'http://local').pathname);
    arrived?.();
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: Record<string, any> }>((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.on('error', fail);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const duringBody = (path: string, body: unknown, change: () => void) => new Promise<{ status: number; body: Record<string, any> }>((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.on('error', fail);
    arrived = () => { arrived = null; change(); request.end(JSON.stringify(body).slice(1)); };
    request.write('{');
  });
  return { w, call, duringBody };
}

describe('owner self-interest route on the canonical SQLite memory writer', () => {
  it('lists/detail reads immutable versions and accepts one owner CAS operation with replay-safe IDs', async () => {
    const { w, call } = await serve('owner');
    const list = await call('GET', '/v1/autonomy/interests');
    expect(list).toMatchObject({ status: 200, body: { revision: 1, capacity: { used: 1, limit: 12, indexLimit: 1_000 } } });
    const item = list.body.items[0];
    expect(await call('GET', `/v1/autonomy/interests/${item.id}`)).toMatchObject({ status: 200, body: { item: { title: '天文', weight: 0.5 }, changes: [{ kind: 'add', actor: 'sleep' }] } });
    const body = { operationId: 'owner-pin', expectedRevision: item.revision };
    expect(await call('POST', `/v1/autonomy/interests/${item.id}/pin`, body)).toMatchObject({ status: 200, body: { code: 'changed', item: { pinned: true, revision: 2 } } });
    expect(await call('POST', `/v1/autonomy/interests/${item.id}/pin`, body)).toMatchObject({ status: 200, body: { code: 'changed' } });
    expect(w.memory!.store.revision('owner')).toBe(2);
    expect(await call('POST', `/v1/autonomy/interests/${item.id}/ban`, body)).toMatchObject({ status: 409, body: { code: 'operation_conflict', latest: { revision: 2 } } });
    expect(await call('POST', `/v1/autonomy/interests/${item.id}/ban`, { ...body, operationId: 'owner-ban-stale' })).toMatchObject({ status: 409, body: { code: 'stale', latest: { revision: 2 } } });
    expect(w.memory!.store.get('owner', item.id)?.banned).toBe(false);
  });

  it('refuses absent pairing, other scope and OFF reads or mutations', async () => {
    for (const [scope, enabled, error] of [[null, true, 'PAIRED_DEVICE_REQUIRED'], ['guest', true, 'INTERESTS_OWNER_ONLY'], ['owner', false, 'INTERESTS_DISABLED']] as const) {
      const { w, call } = await serve(scope, enabled);
      expect(await call('GET', '/v1/autonomy/interests')).toMatchObject({ status: 403, body: { error } });
      expect(await call('POST', '/v1/autonomy/interests/si-fake/ban', { operationId: 'control', expectedRevision: 1 })).toMatchObject({ status: 403 });
      if (enabled) expect(w.memory!.store.revision('owner')).toBe(1);
    }
  });

  it('rejects malformed edits, unknown fields, invalid revision and wrong methods without a write', async () => {
    const { w, call } = await serve('owner');
    const item = w.memory!.store.all('owner')[0]!;
    const path = `/v1/autonomy/interests/${item.id}`;
    for (const body of [null, [], {}, { operationId: 'x', expectedRevision: 0 }, { operationId: 'x', expectedRevision: 1.5 },
      { operationId: 'has space', expectedRevision: 1 }, { operationId: 'x', expectedRevision: 1, title: '別の題材' }]) {
      expect(await call('POST', `${path}/pin`, body)).toMatchObject({ status: 400, body: { error: 'INVALID_INTEREST_COMMAND' } });
    }
    expect(await call('POST', `${path}/undo`, { operationId: 'x', expectedRevision: 1 })).toMatchObject({ status: 400 });
    expect(await call('GET', `${path}/pin`)).toMatchObject({ status: 405 });
    expect(await call('DELETE', path)).toMatchObject({ status: 405 });
    expect(await call('GET', '/v1/autonomy/interests/si-missing')).toMatchObject({ status: 404 });
    expect(w.memory!.store.revision('owner')).toBe(1);
  });

  it('forgets through the owner writer and never reveals forgotten words in list/detail or replay response', async () => {
    const { w, call } = await serve('owner');
    const item = w.memory!.store.all('owner')[0]!;
    const path = `/v1/autonomy/interests/${item.id}`;
    const body = { operationId: 'owner-forget', expectedRevision: 1 };
    expect(await call('POST', `${path}/forget`, body)).toMatchObject({ status: 200, body: { item: { forgotten: true } } });
    for (const response of [await call('GET', '/v1/autonomy/interests'), await call('GET', path), await call('POST', `${path}/forget`, body)]) {
      expect(JSON.stringify(response.body)).not.toContain('天文');
      expect(JSON.stringify(response.body)).not.toContain('会話に共鳴した');
    }
  });

  it('reads the original operation receipt across later edits without replaying or exposing forgotten content', async () => {
    const { w, call } = await serve('owner');
    const item = w.memory!.store.all('owner')[0]!;
    const path = `/v1/autonomy/interests/${item.id}`;
    await call('POST', `${path}/pin`, { operationId: 'accepted-pin', expectedRevision: 1 });
    await call('POST', `${path}/unpin`, { operationId: 'later-edit', expectedRevision: 2 });
    expect(await call('GET', '/v1/autonomy/interests/operations/accepted-pin')).toMatchObject({ status: 200, body: {
      operationId: 'accepted-pin', found: true, result: { code: 'changed', revision: 2, item: { revision: 2, pinned: true } }, latest: { revision: 3 } } });
    expect(await call('GET', '/v1/autonomy/interests/operations/not-delivered')).toMatchObject({ status: 200, body: { found: false, result: null } });
    await call('POST', `${path}/forget`, { operationId: 'later-forget', expectedRevision: 3 });
    const read = await call('GET', '/v1/autonomy/interests/operations/accepted-pin');
    expect(read.body.result.item).toMatchObject({ revision: 2, pinned: true, title: '（表示しない関心）', evidenceRefs: [] });
    expect(JSON.stringify(read.body)).not.toContain('天文');
    expect(w.memory!.store.revision('owner')).toBe(4);
  });

  it('paginates individual history without hiding it behind another item and validates cursors', async () => {
    const { w, call } = await serve('owner');
    const item = w.memory!.store.all('owner')[0]!;
    for (let i = 0; i < 105; i += 1) w.mutate({ itemId: item.id, expectedRevision: i + 1, action: i % 2 ? 'unpin' : 'pin' });
    const first = await call('GET', `/v1/autonomy/interests/${item.id}`);
    expect(first.body.changes).toHaveLength(100);
    const second = await call('GET', `/v1/autonomy/interests/${item.id}?cursor=${first.body.nextCursor}`);
    expect(second.body.changes).toHaveLength(6);
    expect(second.body.nextCursor).toBeNull();
    expect(new Set([...first.body.changes, ...second.body.changes].map(change => change.seq)).size).toBe(106);
    for (const cursor of ['0', '-1', '1.5', '9007199254740993', 'x']) expect(await call('GET', `/v1/autonomy/interests?cursor=${cursor}`)).toMatchObject({ status: 400 });
  });

  it('returns an unavailable operation read as 503 instead of reporting an absent or accepted receipt', async () => {
    const { w, call } = await serve('owner');
    w.owner!.operation = () => { throw new Error('sqlite unavailable'); };
    expect(await call('GET', '/v1/autonomy/interests/operations/undelivered')).toEqual({ status: 503, body: { error: 'INTEREST_OPERATION_UNAVAILABLE' } });
    expect(w.memory!.store.revision('owner')).toBe(1);
  });

  it('rechecks audience after body wait before mutation and keeps unknown audience read-only', async () => {
    const audience = { alone: true };
    const { w, call, duringBody } = await serve('owner', true, audience);
    const item = w.memory!.snapshot('owner').items[0]!;
    const result = await duringBody(`/v1/autonomy/interests/${item.id}/pin`, { operationId: 'audience-wait', expectedRevision: 1 }, () => { audience.alone = false; });
    expect(result).toEqual({ status: 403, body: { error: 'INTERESTS_OWNER_ALONE_REQUIRED' } });
    expect(w.memory!.store.get('owner', item.id)?.pinned).toBe(false);
    for (const path of ['/v1/autonomy/interests', `/v1/autonomy/interests/${item.id}`, '/v1/autonomy/interests/operations/audience-wait']) {
      expect(await call('GET', path)).toEqual({ status: 403, body: { error: 'INTERESTS_OWNER_ALONE_REQUIRED' } });
    }
    audience.alone = true;
    expect((await call('GET', '/v1/autonomy/interests/operations/audience-wait')).body.found).toBe(false);
  });

  it('withholds the response if audience changes after acceptance, retaining exact receipt for later read-back', async () => {
    const audience = { alone: true };
    const { w, call } = await serve('owner', true, audience);
    const item = w.memory!.snapshot('owner').items[0]!;
    const mutate = w.owner!.mutate;
    w.owner!.mutate = (...args) => { const result = mutate(...args); audience.alone = false; return result; };
    expect(await call('POST', `/v1/autonomy/interests/${item.id}/pin`, { operationId: 'accepted-before-others', expectedRevision: 1 }))
      .toEqual({ status: 403, body: { error: 'INTERESTS_OWNER_ALONE_REQUIRED' } });
    expect(w.memory!.store.get('owner', item.id)?.pinned).toBe(true);
    audience.alone = true;
    expect(await call('GET', '/v1/autonomy/interests/operations/accepted-before-others')).toMatchObject({ status: 200, body: { found: true, result: { code: 'changed', revision: 2 } } });
    const detail = w.owner!.detail;
    w.owner!.detail = (...args) => { const result = detail(...args); audience.alone = false; return result; };
    expect(await call('GET', `/v1/autonomy/interests/${item.id}`)).toEqual({ status: 403, body: { error: 'INTERESTS_OWNER_ALONE_REQUIRED' } });
  });
});
