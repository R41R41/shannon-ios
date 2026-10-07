import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SKILL_CAPACITY } from '../src/mind/memory/skillDocument.js';
import { createSkillsRoute, ownerSkillRecorder } from '../src/infra/http/skillRoutes.js';

/** The owner's view and pins of her skills, for the 学び tab (Syzygy ADR-0008 stage 2, review scope gap). */
const AT = '2026-10-07T03:00:00.000Z';
let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>(done => server!.close(() => done())); server = null; });

async function serve(route: ReturnType<typeof createSkillsRoute>, scopeKey: string | null) {
  server = createServer((request, response) => { void route(request, response, scopeKey ? { scopeKey } : null, new URL(request.url ?? '/', 'http://x').pathname); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return (method: string, path: string) => new Promise<{ status: number; body: Record<string, unknown> }>((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    request.on('error', fail);
    request.end();
  });
}

function world() {
  const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
  const store = new SQLiteAutonomyStore(':memory:');
  const config = configuredAutonomy({});
  const draft = (name: string) => ({ name, description: 'ふりかえりの時', steps: '1. 三つ挙げる', aids: '- なし', references: '- 会話から' });
  const id = (memory.create('owner', { draft: draft('weekly-review'), evidence: [] }, { carries: () => false }, AT) as { skillId: string }).skillId;
  const route = createSkillsRoute({ memory, record: ownerSkillRecorder(store.activity, config), ownerScopeKey: 'owner', now: () => AT });
  return { memory, store, id, route };
}

describe('the owner\'s skills route', () => {
  it('lists and reads her skills for the owner only, and pins and unpins them, each written to the activity record', async () => {
    const { memory, store, id, route } = world();
    const call = await serve(route, 'owner');
    const list = await call('GET', '/v1/autonomy/skills');
    expect(list).toMatchObject({ status: 200, body: { capacity: { used: 1, limit: SKILL_CAPACITY } } });
    expect((list.body.skills as Array<Record<string, unknown>>)[0]).toMatchObject({ id, name: 'weekly-review', status: 'trial', pinned: false, trial: { baseVersion: null, uses: 0, of: 3 } });
    const one = await call('GET', `/v1/autonomy/skills/${id}`);
    expect(one.body).toMatchObject({ id, body: expect.stringContaining('## 手順'), versions: [{ version: 1, actor: 'sleep', reason: 'built' }], audit: [{ kind: 'create', status: 'trial' }] });
    expect(await call('POST', `/v1/autonomy/skills/${id}/pin`)).toMatchObject({ status: 200, body: { pinned: true } });
    expect(memory.store.get('owner', id)!.pinned).toBe(true);
    expect(await call('POST', `/v1/autonomy/skills/${id}/unpin`)).toMatchObject({ status: 200, body: { pinned: false } });
    const controls = store.activity.days('owner', { sinceDayKey: '2026-10-01' }).flatMap(day => day.entries).filter(entry => entry.kind === 'control');
    expect(controls.map(entry => [entry.actor, entry.tool, entry.detail]).sort()).toEqual([['owner', 'skills.pin', id], ['owner', 'skills.unpin', id]]);
    expect(await call('GET', '/v1/autonomy/skills/nope')).toMatchObject({ status: 404 });
    expect(await call('DELETE', `/v1/autonomy/skills/${id}`)).toMatchObject({ status: 405 });
    expect(await call('GET', `/v1/autonomy/skills/${id}/pin`)).toMatchObject({ status: 405 });
  });

  it('answers no one else, and says when her skills are off', async () => {
    const { route } = world();
    expect(await (await serve(route, 'guest'))('GET', '/v1/autonomy/skills')).toMatchObject({ status: 403, body: { error: 'SKILLS_OWNER_ONLY' } });
    await new Promise<void>(done => server!.close(() => done()));
    expect(await (await serve(route, null))('GET', '/v1/autonomy/skills')).toMatchObject({ status: 403, body: { error: 'PAIRED_DEVICE_REQUIRED' } });
    await new Promise<void>(done => server!.close(() => done()));
    const off = createSkillsRoute({ memory: null, record: () => {}, ownerScopeKey: 'owner', now: () => AT });
    expect(await (await serve(off, 'owner'))('GET', '/v1/autonomy/skills')).toMatchObject({ status: 403, body: { error: 'SKILLS_DISABLED' } });
  });
});
