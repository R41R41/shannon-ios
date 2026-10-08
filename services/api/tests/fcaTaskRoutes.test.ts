import { createServer, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFcaTaskRoute, FCA_TASK_PATH } from '../src/infra/http/fcaTaskRoutes.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { alone?: () => boolean; stopWait?: () => Promise<void> } = {}) {
  const db = new DatabaseSync(':memory:'); cleanups.push(() => db.close()); migrateAgentTasks(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority: new SQLiteFcaTaskAuthority(db), leaseValid: () => true,
    now: () => '2026-10-09T00:00:00.000Z' });
  const wake = vi.fn();
  const stop = vi.fn(async (id: string, reason: string) => {
    const result = runtime.stop('owner', id, reason); await options.stopWait?.(); return result;
  });
  const route = createFcaTaskRoute({ runtime, ownerScope: 'owner', ownerAlone: options.alone ?? (() => true), stop, wake });
  const server = createServer((request, response) => {
    const value = request.headers['x-test-scope'];
    const principal = typeof value === 'string' ? { scopeKey: value } : null;
    void route(request, response, principal, new URL(request.url ?? '/', 'http://localhost'))
      .catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}${FCA_TASK_PATH}`;
  const call = (query = '', body?: unknown, scope: string | null = 'owner') => fetch(base + query, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(scope === null ? {} : { 'x-test-scope': scope }), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const child = (scope = 'owner') => {
    const root = runtime.ensureRoot(scope);
    return runtime.createChild(scope, root.id, { title: `${scope} task`, goal: `${scope} goal`, completionCriteria: 'Recorded result' }, `create:${scope}`);
  };
  return { runtime, wake, stop, base, call, child };
}
const create = { command: 'create', requestId: 'request-create', title: '調査', goal: '資料を確認する', completionCriteria: '結果を記録する' };

describe('FCA owner HTTP boundary', () => {
  it.each([null, 'guest', 'OWNER', 'owner-other'])('rejects an unpaired or nonexact owner principal (%s)', async scope => {
    const h = await fixture(); h.child();
    for (const body of [undefined, create]) {
      const response = await h.call('?scopeKey=owner', body, scope);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'FCA_OWNER_ALONE_REQUIRED' });
    }
    expect(h.runtime.list('owner')).toHaveLength(2); expect(h.wake).not.toHaveBeenCalled();
  });

  it('holds owner reads and mutations while someone else is present despite caller audience claims', async () => {
    const h = await fixture({ alone: () => false }); h.child();
    for (const body of [undefined, create]) {
      const response = await h.call('?audience=owner', body);
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain('owner goal');
    }
    expect(h.runtime.list('owner')).toHaveLength(2); expect(h.wake).not.toHaveBeenCalled();
  });

  it('binds read scope to the authenticated owner and never returns another scope by ID', async () => {
    const h = await fixture(); const own = h.child(), guest = h.child('guest');
    const response = await h.call('?scopeKey=guest');
    expect(response.status).toBe(200);
    const list = await response.json() as Array<{ id: string; scopeKey: string }>;
    expect(list.some(task => task.id === own.id)).toBe(true);
    expect(list.every(task => task.scopeKey === 'owner')).toBe(true);
    expect((await h.call(`?id=${guest.id}&scopeKey=guest`)).status).toBe(404);
    const before = h.runtime.snapshot('guest', guest.id);
    const sent = await h.call('', { command: 'send', id: guest.id, message: 'Cross-scope input', requestId: 'cross-scope' });
    expect(sent.status).toBe(409);
    expect(await sent.json()).toEqual({ error: 'FCA_TASK_NOT_FOUND' });
    expect(h.runtime.snapshot('guest', guest.id)).toEqual(before);
  });

  it.each(['scopeKey', 'parentId', 'origin', 'audience', 'history', 'checkpoint', 'lease'])('rejects caller authority/state field %s before creating work', async key => {
    const h = await fixture();
    const response = await h.call('', { ...create, [key]: 'caller-controlled' });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'FCA_INPUT' });
    expect(h.runtime.list('owner')).toEqual([]); expect(h.wake).not.toHaveBeenCalled();
  });

  it('admits one durable owner child per request and sends messages from the trusted root', async () => {
    const h = await fixture();
    const response = await h.call('', create); expect(response.status).toBe(202);
    const task = await response.json() as { id: string; parentId: string };
    expect(task).toMatchObject({ phase: 'ready', origin: 'owner_request', title: create.title, goal: create.goal });
    expect(h.runtime.get('owner', task.parentId)?.kind).toBe('root');
    expect(await (await h.call('', create)).json()).toMatchObject({ id: task.id });
    expect(h.runtime.list('owner')).toHaveLength(2);
    const message = { command: 'send', id: task.id, message: '追加の条件', requestId: 'owner-message' };
    expect(await (await h.call('', message)).json()).toMatchObject({ accepted: true, duplicate: false });
    expect(await (await h.call('', message)).json()).toMatchObject({ accepted: true, duplicate: true });
    expect(h.runtime.snapshot('owner', task.id)?.messages).toEqual([
      expect.objectContaining({ id: 'owner-message', sourceTaskId: task.parentId, targetTaskId: task.id, text: '追加の条件' }),
    ]);
    expect(h.wake).toHaveBeenCalledTimes(4);
  });

  it('returns public task views without opaque native history, checkpoint or inbox text', async () => {
    const h = await fixture(), task = h.child();
    const step = h.runtime.beginStep('owner', task.id, { id: 'action', holder: 'runner', generation: 1 })!;
    h.runtime.commitStep(step, { disposition: 'wait', history: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }] }],
      checkpoint: { body: 'PRIVATE_CHECKPOINT' }, summary: '結果待ち' });
    const root = h.runtime.ensureRoot('owner');
    h.runtime.send('owner', root.id, task.id, 'PRIVATE_INBOX', 'private-message');
    for (const query of ['', `?id=${task.id}`]) {
      const response = await h.call(query); expect(response.status).toBe(200);
      const raw = JSON.stringify(await response.json());
      expect(raw).not.toMatch(/PRIVATE_|"history"|"checkpoint"|"messages"|"lease"/u);
      expect(raw).toContain(task.id);
    }
    expect(h.runtime.snapshot('owner', task.id)?.history).toHaveLength(1);
  });

  it('stops then explicitly resumes known work and refuses unknown execution resume', async () => {
    const h = await fixture(), task = h.child();
    expect((await h.call('', { command: 'stop', id: task.id })).status).toBe(202);
    expect(h.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(await (await h.call('', { command: 'resume', id: task.id })).json()).toMatchObject({ id: task.id, phase: 'ready' });
    expect((await h.call('', { command: 'resume', id: task.id })).status).toBe(409);
    h.runtime.beginStep('owner', task.id, { id: 'uncertain-action', holder: 'runner', generation: 1 });
    h.runtime.recover('owner', () => 'unknown');
    const response = await h.call('', { command: 'resume', id: task.id });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'FCA_NOT_RESUMABLE' });
    expect(h.runtime.get('owner', task.id)?.phase).toBe('unknown');
  });

  it('rechecks audience after asynchronous stop and withholds the already accepted result', async () => {
    let alone = true; const entered = deferred(), release = deferred();
    const h = await fixture({ alone: () => alone, stopWait: async () => { entered.resolve(); await release.promise; } });
    const task = h.child();
    const pending = h.call('', { command: 'stop', id: task.id });
    await entered.promise; alone = false; release.resolve();
    const response = await pending;
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'FCA_OWNER_ALONE_REQUIRED' });
    expect(h.runtime.get('owner', task.id)?.phase).toBe('stopped');
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('rechecks audience after streaming the body and creates no task after an audience change', async () => {
    let alone = true; const entered = deferred();
    const h = await fixture({ alone: () => { entered.resolve(); return alone; } });
    const payload = JSON.stringify(create);
    const result = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest(h.base, { method: 'POST', headers: { 'x-test-scope': 'owner', 'content-type': 'application/json' } }, response => {
        let raw = ''; response.on('data', chunk => { raw += chunk; });
        response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(raw) }));
      });
      request.on('error', reject); request.write(payload.slice(0, 10));
      void entered.promise.then(() => { alone = false; request.end(payload.slice(10)); });
    });
    expect(await result).toEqual({ status: 403, body: { error: 'FCA_OWNER_ALONE_REQUIRED' } });
    expect(h.runtime.list('owner')).toEqual([]); expect(h.wake).not.toHaveBeenCalled();
  });
});
