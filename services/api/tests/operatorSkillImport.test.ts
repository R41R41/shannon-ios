import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { createSkillsRoute } from '../src/infra/http/skillRoutes.js';
import { skillImportEndpoint } from '../src/infra/http/skillImportCommand.js';
import { OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { operatorEnvelope, runOperatorCli } from '../src/infra/ops/operatorCli.js';
import { parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';

/** `opsCli.ts skills import`: the paired route's own import, through the operator's socket (coordinator's choice, 2026-10-14). */
const AT = '2026-10-14T10:00:00.000Z';
const PACK = { packId: 'legacy-minecraft', revision: 'draft-1' };
let server: Server | null = null;
afterEach(async () => { if (server) await new Promise<void>(done => server!.close(() => done())); server = null; });

function world() {
  const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
  const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => ({ carries: () => false }), tools: () => [] });
  return { memory, importer, deps: { memory, importer, pack: standardSkillPack, now: () => AT } };
}

async function paired() {
  const w = world(), recorded: string[] = [];
  const route = createSkillsRoute({ ...w.deps, record: (_scope, action, id) => recorded.push(`${action}:${id}`), ownerScopeKey: 'owner' });
  server = createServer((request, response) => { void route(request, response, { scopeKey: 'owner' }, new URL(request.url ?? '/', 'http://x').pathname); });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const post = (phase: string, body: unknown) => new Promise<{ status: number; body: unknown }>((done, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: `/v1/autonomy/skills/import/${phase}`, method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += String(chunk); });
      response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
    });
    request.on('error', fail);
    request.end(JSON.stringify(body));
  });
  return { ...w, post, recorded };
}

function operator(options: { skills?: boolean } = {}) {
  const w = world(), audit = new OperatorAuditStore(new DatabaseSync(':memory:')), activity: OperatorActivity[] = [];
  const parts: OperatorMinecraftParts = {
    scopeKey: 'owner', enabled: () => true, ownerAlone: () => true, now: () => AT, audit, lifecycle: null, requests: null, actions: null,
    lifecycleUnresolved: () => false, activity: (_at, entry) => activity.push(entry), note: () => {},
    skillImport: options.skills === false ? null : w.deps,
  };
  const service = createOperatorMinecraft(parts);
  const run = (phase: string, args: Record<string, unknown> = {}) => service.handle({ v: 1, operator: 'ops-claude', domain: 'skills', op: 'import', args: { phase, ...PACK, ...args } });
  return { ...w, audit, activity, service, run };
}
const events = (audit: OperatorAuditStore) => audit.recent('owner', 50).reverse().map(row => `${row.command}/${row.event}/${row.code}`);

describe('skills import over the operator socket', () => {
  it('answers the dry-run and the apply exactly as the paired route does, and audits the operator', async () => {
    const http = await paired(), ops = operator();
    const httpPlan = await http.post('dry-run', PACK);
    const opsPlan = await ops.run('dry-run');
    expect(httpPlan.status).toBe(200);
    expect(opsPlan).toMatchObject({ status: 202, body: { outcome: 'accepted', code: 'accepted', skillImport: httpPlan.body } });
    const planHash = (httpPlan.body as { planHash: string }).planHash;
    const httpApplied = await http.post('apply', { ...PACK, planHash, approvalReference: 'owner-form-20261014' });
    const opsApplied = await ops.run('apply', { planHash, approvalReference: 'owner-form-20261014' });
    expect(httpApplied).toMatchObject({ status: 200, body: { idempotent: false, receipt: { approvalReference: 'owner-form-20261014' } } });
    expect((opsApplied.body as { skillImport: unknown }).skillImport).toEqual(httpApplied.body);
    expect(ops.memory.store.all('owner').map(skill => skill.name)).toEqual(http.memory.store.all('owner').map(skill => skill.name));
    expect(ops.memory.store.all('owner')).toHaveLength(4);
    expect(events(ops.audit)).toEqual(['skill_import/invoked/invoked', 'skill_import/accepted/accepted', 'skill_import/invoked/invoked', 'skill_import/accepted/accepted']);
    const receiptId = (httpApplied.body as { receipt: { receiptId: string } }).receipt.receiptId;
    expect(ops.audit.recent('owner', 1)[0]).toMatchObject({ operator: 'ops-claude', detail: expect.stringContaining(`receipt=${receiptId}`) });
    expect(ops.activity).toEqual([expect.objectContaining({ tool: 'operator.skills.import', outcome: 'done', detail: receiptId,
      summary: expect.stringContaining('運用者（ops-claude）経由') })]);
    expect(http.recorded).toEqual([`import:${receiptId}`]);
  });

  it('is idempotent: the same apply again answers the same receipt, writes nothing and records no second adoption', async () => {
    const ops = operator();
    const planHash = ((await ops.run('dry-run')).body as { skillImport: { planHash: string } }).skillImport.planHash;
    const first = await ops.run('apply', { planHash, approvalReference: 'owner-form-20261014' });
    const again = await ops.run('apply', { planHash, approvalReference: 'owner-form-20261014' });
    const receipt = (first.body as { skillImport: { receipt: unknown } }).skillImport.receipt;
    expect(again).toMatchObject({ status: 202, body: { outcome: 'accepted', skillImport: { idempotent: true, receipt } } });
    expect(ops.memory.store.all('owner')).toHaveLength(4);
    expect(ops.activity).toHaveLength(1);
  });

  it('refuses a stale plan, as the paired route does, and imports nothing', async () => {
    const http = await paired(), ops = operator();
    const stale = 'a'.repeat(64);
    const httpStale = await http.post('apply', { ...PACK, planHash: stale, approvalReference: 'owner-form-20261014' });
    const opsStale = await ops.run('apply', { planHash: stale, approvalReference: 'owner-form-20261014' });
    expect(httpStale).toMatchObject({ status: 409, body: { rejected: 'stale_plan' } });
    expect(opsStale).toMatchObject({ status: 409, body: { outcome: 'refused', code: 'stale_plan', skillImport: httpStale.body } });
    expect(ops.memory.store.all('owner')).toEqual([]);
    expect(events(ops.audit).at(-1)).toBe('skill_import/refused/stale_plan');
  });

  it('refuses an unknown pack, skills switched off, and malformed or other skills operations', async () => {
    const ops = operator();
    expect(await ops.service.handle({ v: 1, operator: 'ops', domain: 'skills', op: 'import', args: { phase: 'dry-run', packId: 'nope', revision: 'draft-1' } }))
      .toMatchObject({ body: { outcome: 'refused', code: 'not_found', skillImport: { error: 'SKILL_PACK_NOT_FOUND' } } });
    expect(await operator({ skills: false }).run('dry-run')).toMatchObject({ body: { outcome: 'refused', code: 'disabled' } });
    expect(parseOperatorEnvelope({ v: 1, operator: 'ops', domain: 'skills', op: 'delete', args: {} })).toMatchObject({ ok: false, code: 'out_of_scope' });
    expect(parseOperatorEnvelope({ v: 1, operator: 'ops', domain: 'skills', op: 'import', args: { phase: 'apply', ...PACK } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope({ v: 1, operator: 'ops', domain: 'skills', op: 'import', args: { phase: 'dry-run', ...PACK, planHash: 'a'.repeat(64) } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope({ v: 1, operator: 'ops', domain: 'skills', op: 'import', args: { phase: 'dry-run', packId: '../x', revision: 'draft-1' } })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope({ v: 1, operator: 'ops', domain: 'notes', op: 'import', args: {} })).toMatchObject({ ok: false, code: 'out_of_scope' });
  });

  it('builds the command line envelopes and prints the plan, the receipt and the exit code', async () => {
    expect(operatorEnvelope(['skills', 'import', 'dry-run', '--operator', 'ops', '--pack', 'legacy-minecraft', '--revision', 'draft-2'], {}))
      .toEqual({ v: 1, operator: 'ops', domain: 'skills', op: 'import', args: { phase: 'dry-run', packId: 'legacy-minecraft', revision: 'draft-2' } });
    expect(operatorEnvelope(['skills', 'import', 'apply', '--pack', 'p', '--revision', 'r', '--plan-hash', 'h', '--approval-reference', 'ref'], { SHANNON_OPERATOR: 'ops' }))
      .toMatchObject({ args: { phase: 'apply', planHash: 'h', approvalReference: 'ref' } });
    expect(() => operatorEnvelope(['skills', 'import', 'apply', '--operator', 'ops', '--pack', 'p', '--revision', 'r'], {})).toThrow('--plan-hash');
    expect(() => operatorEnvelope(['skills', 'import', 'dry-run', '--operator', 'ops', '--pack', 'p'], {})).toThrow('--revision');
    const ops = operator(), dir = mkdtempSync(join(tmpdir(), 'ops-skills-')), database = join(dir, 'shannon.sqlite');
    writeFileSync(database, '');
    try {
      const lines: string[] = [];
      const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(`err ${line}`) };
      const deps = { send: async (_path: string, body: unknown) => ops.service.handle(body), inspect: () => { throw new Error('unused'); }, socketPresent: () => true, now: () => AT };
      const env = { SHANNON_DATABASE_PATH: database, SHANNON_OPERATOR: 'ops' };
      expect(await runOperatorCli(['skills', 'import', 'dry-run', '--pack', 'legacy-minecraft', '--revision', 'draft-1'], env, io, deps)).toBe(0);
      const planHash = lines.find(line => line.startsWith('planHash: '))!.slice(10);
      expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^ {2}skill: mc-early-toolchain [a-f0-9]{64}$/u), 'capacity: {"used":0,"added":4,"limit":25}']));
      expect(lines.join('\n')).not.toContain('## 手順');
      lines.length = 0;
      expect(await runOperatorCli(['skills', 'import', 'apply', '--pack', 'legacy-minecraft', '--revision', 'draft-1', '--plan-hash', planHash,
        '--approval-reference', 'owner-form-20261014'], env, io, deps)).toBe(0);
      expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^receipt: import_[a-f0-9]{40} idempotent=false approval=owner-form-20261014$/u)]));
      lines.length = 0;
      expect(await runOperatorCli(['skills', 'import', 'apply', '--pack', 'legacy-minecraft', '--revision', 'draft-1', '--plan-hash', 'b'.repeat(64),
        '--approval-reference', 'x'], env, io, deps)).toBe(0);
      expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('idempotent=true')]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the paired-device import client', () => {
  it('keeps the server base path, and refuses plain HTTP off the loopback or credentials in the URL', () => {
    expect(skillImportEndpoint('https://sh4nnon.com/companion', 'dry-run').href).toBe('https://sh4nnon.com/companion/v1/autonomy/skills/import/dry-run');
    expect(skillImportEndpoint('https://sh4nnon.com/companion/?x=1#y', 'apply').href).toBe('https://sh4nnon.com/companion/v1/autonomy/skills/import/apply');
    expect(skillImportEndpoint('https://sh4nnon.com', 'apply').href).toBe('https://sh4nnon.com/v1/autonomy/skills/import/apply');
    expect(skillImportEndpoint('http://127.0.0.1:4319', 'dry-run').href).toBe('http://127.0.0.1:4319/v1/autonomy/skills/import/dry-run');
    expect(() => skillImportEndpoint('http://sh4nnon.com/companion', 'dry-run')).toThrow('HTTPS');
    expect(() => skillImportEndpoint('https://user:pw@sh4nnon.com', 'dry-run')).toThrow('credentials');
  });
});
