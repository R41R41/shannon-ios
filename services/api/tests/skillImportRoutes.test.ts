import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import { encodeSkill } from '../src/mind/memory/skillDocument.js';
import { createSkillsRoute } from '../src/infra/http/skillRoutes.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>(done => server!.close(() => done())); server = null; });
const at = '2026-10-09T00:00:00.000Z';
async function serve(principal: string | null) {
  const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
  const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => ({ carries: () => false }), tools: () => [] });
  const body = encodeSkill({ name: 'first', description: '予定を確かめる時', steps: '1. 結果を確かめる', aids: 'なし', references: '運用作成。実績なし。' });
  const pack: SkillPack = { schemaVersion: 1, packId: 'standard10', revision: 'draft-2', sourceAuthor: 'operator', sourceReference: 'https://example.com/source',
    referenceRevision: 'b85625ad', validatorRevision: 'v1', skills: [{ name: 'first', body, sha256: skillArtifactSha256(body), tools: [] }] };
  const records: string[][] = [];
  const route = createSkillsRoute({ memory, importer, pack: (id, revision) => id === pack.packId && revision === pack.revision ? pack : null,
    record: (scope, action, id) => { records.push([scope, action, id]); }, ownerScopeKey: 'owner', now: () => at });
  server = createServer((request, response) => { void route(request, response, principal ? { scopeKey: principal } : null, new URL(request.url ?? '/', 'http://local').pathname); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, command: unknown, method = 'POST') => {
    const response = await fetch(base + path, { method, ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { memory, records, call };
}
it('selects only a bundled version, fixes the dry-run plan, exposes provenance, and records one owner import', async () => {
  const { call, memory, records } = await serve('owner');
  expect(await call('/v1/autonomy/skills/import/dry-run', { packId: '../file', revision: 'draft-2' })).toMatchObject({ status: 404 });
  expect(await call('/v1/autonomy/skills/import/dry-run', { packId: 'standard10', revision: 'draft-2' }, 'GET')).toMatchObject({ status: 405 });
  const command = { packId: 'standard10', revision: 'draft-2' };
  const dry = await call('/v1/autonomy/skills/import/dry-run', command);
  expect(dry).toMatchObject({ status: 200, body: { problems: [] } });
  expect(memory.store.all('owner')).toEqual([]);
  expect(await call('/v1/autonomy/skills/import/apply', command)).toMatchObject({ status: 400 });
  const adopted = { ...command, planHash: dry.body.planHash, approvalReference: 'owner-request' };
  const result = await call('/v1/autonomy/skills/import/apply', adopted);
  expect(result).toMatchObject({ status: 200, body: { idempotent: false } });
  expect(await call('/v1/autonomy/skills/import/apply', adopted)).toMatchObject({ status: 200, body: { idempotent: true } });
  expect(records).toHaveLength(1);
  expect(records[0]).toEqual(['owner', 'import', expect.stringMatching(/^import_/u)]);
  const id = memory.store.all('owner')[0]!.skillId;
  expect(await call(`/v1/autonomy/skills/${id}`, null, 'GET')).toMatchObject({ status: 200, body: { madeBy: 'operator_authored', provenance: { origin: 'operator_authored' },
    versions: [{ actor: 'operator_authored', provenance: { origin: 'operator_authored' } }], uses: 0, successes: 0 } });
  memory.store.setExportHold('owner', id, 'withdrawn');
  expect(await call(`/v1/autonomy/skills/${id}`, null, 'GET')).toMatchObject({ status: 200, body: { provenance: null, bodyHidden: true, versions: [{ provenance: null }] } });
});
it.each(['guest', null])('rejects import before reading the pack or command for principal %s', async principal => {
  const { call, memory } = await serve(principal);
  expect(await call('/v1/autonomy/skills/import/apply', { packId: 'standard10', revision: 'draft-2' })).toMatchObject({ status: 403 });
  expect(memory.store.all('owner')).toEqual([]);
});
