import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SELF_REWRITE_SCHEMA, type SelfRewriteCandidate } from '../src/mind/inhibition/selfRewritePorts.js';
import { selfRewriteContentHash, selfRewriteDiffHash } from '../src/mind/inhibition/selfRewriteService.js';
import { configuredAutonomy } from '../src/mind/inhibition/inhibitionPorts.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { createAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { rewriteBaseRevision, rewriteDocumentKey, selfRewriteRuntimeWiring } from '../src/wiring/selfRewriteRuntimeWiring.js';
import { resolvePhysicalPath } from '../src/mind/inhibition/autonomyReadPorts.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { toolSessionMemory } from '../src/mind/tools/executionPorts.js';
import { SHANNON_TOOLS, toolDoing, toolSummary } from '../src/mind/tools/shannonTools.js';
import { AutonomyToolResults, plannedToolStep, toolThinking } from '../src/mind/action/ownTime/autonomyLoopToolStep.js';
import type { StepDependencies } from '../src/mind/action/ownTime/autonomyLoopSteps.js';
import { SHANNON_STAGE5_CAPABILITIES } from '@shannon/cognition';
import { checkRewriteData } from '../src/mind/inhibition/selfRewriteDataChecks.js';

const at = '2026-10-08T03:00:00.000Z';
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).reverse().forEach(close => close()));
async function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'shannon-rewrite-runtime-')); closers.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'isolated'), production = join(root, 'production'); mkdirSync(workspace); mkdirSync(production);
  const path = join(root, 'runtime.sqlite'), store = createAutonomyStore(path); closers.push(() => store.close());
  const config = { ...configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), places: { workspaceRoot: workspace,
    repositoryRoots: [], productionRoots: [production], protectedPaths: [path], hostFolders: {} } };
  const service = new ShannonAutonomyService({ store, config, now: () => at });
  const pursuit = store.pursuits.add('owner', { kind: 'work', origin: 'self', title: 'check my own data utility', why: 'format' }, at);
  if (typeof pursuit === 'string') throw new Error(pursuit);
  const cycle = store.loop.startCycle('owner', '2026-10-08', 'activity', [], at);
  const h = actionHarness(() => at); closers.push(h.close);
  const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'ownTime', origin: 'own_time', sourceId: cycle.id })).id);
  const lease = leaseOf(action!), controller = new AbortController();
  const execution: ActionExecution = { lease, signal: controller.signal, permit: keys => h.actions.dispatch(lease, keys) };
  const wiring = selfRewriteRuntimeWiring({ environment: { SHANNON_ADR8_STAGE5: enabled ? 'on' : 'off' },
    path: enabled ? path : join(root, 'never-opened.sqlite'), ownerScope: 'owner', now: () => at,
    config, autonomy: service, autonomyStore: store, tasks: null, actions: h.actions, recoverInterrupted: true }); closers.push(wiring.close);
  const file = join(workspace, 'data.json'); writeFileSync(file, '{"items":[1]}');
  const make = (id = 'data-candidate', target = file, content = '{"items":[1,2]}'): SelfRewriteCandidate => {
    const files = [{ path: target, beforeHash: existsSync(target) ? selfRewriteContentHash(readFileSync(target, 'utf8')) : null, content }];
    return { schema: SELF_REWRITE_SCHEMA, id, workId: `pursuit:${pursuit.id}`, scopeKey: 'owner', sourceId: pursuit.id,
      origin: 'own_time', budgetLane: 'autonomy', files, diffHash: selfRewriteDiffHash(files), baseRevision: rewriteBaseRevision(files) };
  };
  const run = <T>(work: () => Promise<T>) => inActionExecution(execution, work);
  return { root, workspace, production, path, store, config, service, pursuit, cycle, h, controller, execution, wiring, file, make, run };
}
describe('self rewrite through the existing live action and tool gate', () => {
  it('keeps the OFF registry, prompts and schema unchanged, and closes direct REST without new execution', async () => {
    const off = await fixture(false);
    expect(off.wiring.service).toBeNull(); expect(off.wiring.port).toBeNull(); expect(existsSync(join(off.root, 'never-opened.sqlite'))).toBe(false);
    expect(off.service.tools.offered('autonomy', 'owner_alone', 'owner').some(tool => tool.name.startsWith('workspace.'))).toBe(false);
    expect(SHANNON_TOOLS.some(tool => tool.name.startsWith('workspace.'))).toBe(false);
    const on = await fixture(); const value = on.make();
    on.wiring.service!.submit(value);
    const response = await on.wiring.route({ method: 'POST', path: `/v1/autonomy/self-rewrite/candidates/${value.id}/dispatch`, body: { scopeKey: 'owner' } });
    expect(response?.body).toMatchObject({ state: 'refused', gate: 'authority' });
    expect(readFileSync(on.file, 'utf8')).toBe('{"items":[1]}'); expect(on.h.store.list('owner')).toHaveLength(1);
  });
  it('passes actual data checks, original source/lease and snapshots through an existing permitted tool without owner grant', async () => {
    const f = await fixture(); const offered = f.service.tools.offered('autonomy', 'owner_alone', 'owner').filter(tool => tool.name.startsWith('workspace.'));
    expect(offered.map(tool => tool.name)).toEqual(['workspace.inspect', 'workspace.rewrite', 'workspace.propose']);
    expect(f.service.tools.offered('text', 'owner_alone', 'owner').some(tool => tool.name.startsWith('workspace.'))).toBe(false);
    expect(f.service.tools.offered('autonomy', 'others', 'owner').some(tool => tool.name.startsWith('workspace.'))).toBe(false);
    for (const tool of offered) { expect(toolSummary(tool)).not.toBe(tool.name); expect(toolDoing(tool.name)).toBe(tool.effect === 'write' ? 'acts' : 'describes'); }
    const inspected = await f.run(() => f.wiring.port!.inspect('owner', `pursuit:${f.pursuit.id}`, [f.file]));
    expect(inspected).toMatchObject({ baseRevision: f.make().baseRevision, authority: { origin: 'own_time', budgetLane: 'autonomy' } });
    const value = f.make(), ready = f.service.tools.prepare('workspace.rewrite', { candidate: JSON.stringify(value) },
      { scopeKey: 'owner', surface: 'autonomy', audience: 'owner_alone', memory: toolSessionMemory() });
    if ('result' in ready) throw new Error(ready.result.failure);
    expect(ready.prepared.paths).toEqual([f.file]);
    const result = await f.run(() => ready.prepared.run()); expect(result.result.ok).toBe(true); expect(result.acknowledged).toBe(true);
    expect(readFileSync(f.file, 'utf8')).toBe('{"items":[1,2]}');
    expect(f.h.store.get(f.execution.lease.id)!.resources).toContain(actionResource('owner', 'folder:vm'));
    expect(await f.run(() => f.wiring.port!.execute('owner', value))).toMatchObject({ state: 'refused' });
    expect(f.wiring.service!.store.work('owner', value.workId)).toMatchObject({ state: 'idle', failures: 0, frozen: false });
  });
  it('describes the actual own-time rewrite port from the single capability source, and leaves OFF sections unchanged', async () => {
    const enabled = await fixture(), off = await fixture(false);
    const prompt = (f: typeof enabled) => toolThinking({ service: f.service, toolResults: new AutonomyToolResults(),
      loop: { ownerDocuments: false } } as StepDependencies, f.cycle)!;
    const capability = SHANNON_STAGE5_CAPABILITIES.find(item => item.id === 'self_rewrite')!.text;
    expect(prompt(enabled).sections[0]).toBe(`[ボクにできること]\n- ${capability}`);
    expect(prompt(off).sections.every(section => !section.includes(capability))).toBe(true);
    expect(prompt(off).sections[0]).toMatch(/^\[ボクの道具\]/u);
  });
  it('supports multiple actual files without mistaking its own first write for a changed baseline', async () => {
    const f = await fixture(), other = join(f.workspace, 'notes.txt'); writeFileSync(other, 'before');
    const a = f.make(), files = [...a.files, { path: other, beforeHash: selfRewriteContentHash('before'), content: 'after' }];
    const value = { ...a, files, diffHash: selfRewriteDiffHash(files), baseRevision: rewriteBaseRevision(files) };
    expect(await f.run(() => f.wiring.port!.execute('owner', value))).toMatchObject({ state: 'completed' });
    expect(readFileSync(other, 'utf8')).toBe('after'); expect(readFileSync(f.file, 'utf8')).toBe('{"items":[1,2]}');
  });
  it('tests and applies isolated numeric code through the original action, and leaves failed candidates unwritten', async () => {
    const f = await fixture(), target = join(f.workspace, 'numeric.mjs');
    const source = 'export function plus(a,b){return a+b} export function bounded(x){return Math.min(Math.max(x,0),10)}';
    const candidate = (id: string, expected: number) => {
      const original = f.make(id, target, source), files = [...original.files, { path: `${target}.test.json`, beforeHash: null,
        content: JSON.stringify({ schema: 'shannon.numeric-tests.v1', cases: [{ export: 'plus', args: [2, 3], expected },
          { export: 'bounded', args: [-1], expected: 0 }, { export: 'bounded', args: [20], expected: 10 }] }) }];
      return { ...original, files, diffHash: selfRewriteDiffHash(files), baseRevision: rewriteBaseRevision(files) };
    };
    expect(await f.run(() => f.wiring.port!.execute('owner', candidate('wrong-result', 6)))).toMatchObject({ state: 'refused', gate: 'tests' });
    expect(existsSync(target)).toBe(false); expect(existsSync(`${target}.test.json`)).toBe(false);
    const actual = candidate('verified-result', 5);
    expect(await f.run(() => f.wiring.port!.execute('owner', actual))).toMatchObject({ state: 'completed' });
    expect(readFileSync(target, 'utf8')).toBe(source); expect(JSON.parse(readFileSync(`${target}.test.json`, 'utf8')).cases).toHaveLength(3);
    const utility = await import(pathToFileURL(target).href);
    expect(utility.plus(3, 4)).toBe(7); expect(utility.bounded(11)).toBe(10);
    expect(f.h.store.list('owner')).toHaveLength(1);
    expect(await f.run(() => f.wiring.port!.execute('owner', actual))).toMatchObject({ state: 'refused' });
    expect(f.wiring.service!.store.work('owner', actual.workId)).toMatchObject({ state: 'idle', failures: 0 });
  });
  it.each(['pause', 'expired', 'foreign', 'budget', 'dropped', 'resource'] as const)('closes %s with zero file side effects', async reason => {
    const f = await fixture(), value = f.make();
    if (reason === 'pause') f.store.setPaused('owner', true, at);
    if (reason === 'expired') f.execution.lease = { ...f.execution.lease, generation: 2 };
    if (reason === 'foreign') { const view = await f.h.actions.claim((await f.h.actions.enqueue({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'foreign' })).id); f.execution.lease = leaseOf(view!); }
    if (reason === 'budget') f.store.recordSpend('owner', '2026-10-08', at, { model: 'test', inputTokens: 0, outputTokens: 0, costUsd: 1, costYen: 999_999 });
    if (reason === 'dropped') f.store.pursuits.update('owner', f.pursuit.id, { status: 'dropped' }, at);
    if (reason === 'resource') { const view = await f.h.actions.claim((await f.h.actions.enqueue({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'lock' })).id); await f.h.actions.dispatch(leaseOf(view!), [actionResource('owner', 'folder:vm')]); }
    expect(await f.run(() => f.wiring.port!.execute('owner', value))).toMatchObject({ state: 'refused' });
    expect(readFileSync(f.file, 'utf8')).toBe('{"items":[1]}');
  });
  it('rejects malformed data, security-policy content, unverified executable code and symlink escapes', async () => {
    const f = await fixture();
    for (const [id, content, target] of [['invalid', '{invalid', f.file], ['policy', '{"permission":"allow"}', f.file],
      ['code', 'export function useful(){return 1}', join(f.workspace, 'tool.mjs')]] as const) {
      expect(await f.run(() => f.wiring.port!.execute('owner', f.make(id, target, content)))).toMatchObject({ state: 'refused' });
    }
    const secret = join(f.production, 'private.json'); writeFileSync(secret, '{"private":true}'); const alias = join(f.workspace, 'alias.json'); symlinkSync(secret, alias);
    expect(await f.run(() => f.wiring.port!.inspect('owner', `pursuit:${f.pursuit.id}`, [alias]))).toBeNull();
    expect(await f.run(() => f.wiring.port!.execute('owner', f.make('symlink', alias)))).toMatchObject({ state: 'refused' });
    expect(readFileSync(secret, 'utf8')).toBe('{"private":true}'); expect(existsSync(join(f.workspace, 'tool.mjs'))).toBe(false);
  });
  it('records an exact unverified code candidate in existing proposals once, without a new task/claim/apply', async () => {
    const f = await fixture(), target = join(f.workspace, 'tool.mjs'), value = f.make('code-proposal', target, 'export function useful(){return 1}');
    const first = await f.run(() => f.wiring.port!.propose('owner', value)); expect(first?.proposalId).toBeTruthy();
    expect(await f.run(() => f.wiring.port!.propose('owner', value))).toEqual(first);
    const proposals = f.store.proposals.list('owner'); expect(proposals).toHaveLength(1);
    expect(proposals[0]!.goal).toContain(value.diffHash); expect(proposals[0]!.goal).toContain(value.baseRevision);
    expect(f.h.store.list('owner')).toHaveLength(1); expect(existsSync(target)).toBe(false);
    f.controller.abort(); expect(await f.run(() => f.wiring.port!.propose('owner', { ...value, id: 'stopped' }))).toBeNull();
  });
  it('preserves unknown original work across reader/restart and never writes a new candidate automatically', async () => {
    const f = await fixture(), value = f.make(); f.wiring.service!.submit(value);
    const work = f.wiring.service!.store.claim(value, at)!;
    f.wiring.service!.store.beginApply(value, work.generation, { id: 'before', hashes: { [f.file]: value.files[0]!.beforeHash } }, at);
    const reader = selfRewriteRuntimeWiring({ environment: { SHANNON_ADR8_STAGE5: 'on' }, path: f.path, ownerScope: 'owner', now: () => at,
      config: f.config, autonomy: f.service, autonomyStore: f.store, tasks: null, actions: f.h.actions, recoverInterrupted: false }); closers.push(reader.close);
    expect(reader.service!.store.work('owner', value.workId).state).toBe('applying');
    reader.service!.store.recoverInterrupted(at);
    const next = f.make('different-candidate'); expect(await f.run(() => reader.port!.execute('owner', next))).toMatchObject({ state: 'unknown', gate: 'unknown' });
    expect(readFileSync(f.file, 'utf8')).toBe('{"items":[1]}');
  });
  it('retains a partial real write as unknown, propagates the acknowledgement boundary and never replays it', async () => {
    const f = await fixture(), other = join(f.workspace, 'other.txt'); writeFileSync(other, 'before');
    const original = f.make(), files = [...original.files, { path: other, beforeHash: selfRewriteContentHash('before'), content: 'after' }];
    const value = { ...original, files, diffHash: selfRewriteDiffHash(files), baseRevision: rewriteBaseRevision(files) };
    f.execution.permit = async keys => {
      if (readFileSync(f.file, 'utf8') === '{"items":[1,2]}') { f.controller.abort(); return false; }
      return f.h.actions.dispatch(f.execution.lease, keys);
    };
    const ready = f.service.tools.prepare('workspace.rewrite', { candidate: JSON.stringify(value) },
      { scopeKey: 'owner', surface: 'autonomy', audience: 'owner_alone', memory: toolSessionMemory() });
    if ('result' in ready) throw new Error(ready.result.failure);
    const result = await f.run(() => ready.prepared.run()); expect(result.acknowledged).toBe(false); expect(result.result.ok).toBe(false);
    expect(f.wiring.service!.store.work('owner', value.workId)).toMatchObject({ state: 'unknown', activeCandidate: value.id });
    expect(readFileSync(other, 'utf8')).toBe('before');
    expect(await f.wiring.port!.execute('owner', { ...value, id: 'fresh-diff' })).toMatchObject({ state: 'unknown' });
    expect(readFileSync(other, 'utf8')).toBe('before');
  });
  it('sticks owner provenance before a write and explicitly marks the next original cycle before reading through an alias', async () => {
    const f = await fixture(), key = rewriteDocumentKey(resolvePhysicalPath(f.file)!);
    f.store.informed.markSession(f.cycle.id, at);
    expect(await f.run(() => f.wiring.port!.execute('owner', f.make()))).toMatchObject({ state: 'completed' });
    expect(f.store.informed.marked('owner', key)).toBe(true); expect(key).not.toContain(f.file);
    const alias = join(f.workspace, 'same-file.json'); symlinkSync(f.file, alias);
    await f.h.actions.finish(f.execution.lease, 'completed', 'cycle_done'); f.store.loop.endCycle(f.cycle.id, 'rest', at);
    const next = f.store.loop.startCycle('owner', '2026-10-08', 'activity', [], at);
    const action = await f.h.actions.claim((await f.h.actions.enqueue({ scopeKey: 'owner', kind: 'ownTime', origin: 'own_time', sourceId: next.id })).id);
    f.execution.lease = leaseOf(action!); f.execution.permit = keys => f.h.actions.dispatch(f.execution.lease, keys);
    expect(f.store.informed.sessionInformedAt(next.id)).toBeNull();
    const read = await f.run(() => f.wiring.port!.inspect('owner', `pursuit:${f.pursuit.id}`, [alias]));
    expect(read?.files[0]?.content).toBe('{"items":[1,2]}'); expect(f.store.informed.sessionInformedAt(next.id)).toBe(at);
    expect(f.service.authorize('owner', { domain: 'outreach', summary: 'synthetic', reachesOthers: true }).reason).toBe('owner_informed');
    expect(await f.run(() => f.wiring.port!.execute('owner', f.make('later-write', f.file, '{"items":[3]}')))).toMatchObject({ state: 'completed' });
    expect(f.store.informed.marked('owner', key)).toBe(true);
  });
  it('keeps unmarked files/session unmarked and closes provenance failure before read or write', async () => {
    const f = await fixture(), key = rewriteDocumentKey(resolvePhysicalPath(f.file)!);
    expect(await f.run(() => f.wiring.port!.execute('owner', f.make()))).toMatchObject({ state: 'completed' });
    expect(f.store.informed.marked('owner', key)).toBe(false); expect(f.store.informed.sessionInformedAt(f.cycle.id)).toBeNull();
    const marked = f.store.informed.marked; f.store.informed.marked = () => { throw new Error('synthetic_unavailable'); };
    expect(await f.run(() => f.wiring.port!.inspect('owner', `pursuit:${f.pursuit.id}`, [f.file]))).toBeNull();
    f.store.informed.marked = marked;
    f.store.informed.markSession(f.cycle.id, at); f.store.informed.markDocuments = () => { throw new Error('synthetic_unavailable'); };
    expect(await f.run(() => f.wiring.port!.execute('owner', f.make('mark-failed', f.file, '{"items":[4]}')))).toMatchObject({ state: 'refused' });
    expect(readFileSync(f.file, 'utf8')).toBe('{"items":[1,2]}');
  });
  it('does not read marked content if the durable session mark cannot be confirmed', async () => {
    const f = await fixture(), key = rewriteDocumentKey(resolvePhysicalPath(f.file)!);
    f.store.informed.markDocuments('owner', [key], 'previous-cycle', at);
    f.store.informed.markSession = () => {};
    expect(await f.run(() => f.wiring.port!.inspect('owner', `pursuit:${f.pursuit.id}`, [f.file]))).toBeNull();
    expect(f.store.informed.sessionInformedAt(f.cycle.id)).toBeNull();
  });
  it('applies the existing secret predicate to decoded candidate content before a tool step is planned', () => {
    const candidate = '{"schema":"shannon.self-rewrite.v1","files":[{"content":"\\u0073\\u0065\\u0063\\u0072\\u0065\\u0074"}]}';
    expect(candidate).not.toContain('secret');
    expect(plannedToolStep({ name: 'workspace.rewrite', input: { candidate } }, ['workspace.rewrite'], value => !value.includes('secret'))).toBe('secret');
  });
  it('decodes JSON file keys and values before the original secret predicate and leaves escaped owner content unwritten', async () => {
    const f = await fixture(), secret = 'PRIVATE_SYNTHETIC_SENTINEL';
    const escaped = [...secret].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const content = `{"text":"${escaped}"}`, value = f.make('hidden-owner-data', f.file, content);
    expect(content).not.toContain(secret); expect(JSON.parse(content).text).toBe(secret);
    const planned = plannedToolStep({ name: 'workspace.rewrite', input: { candidate: JSON.stringify(value) } }, ['workspace.rewrite'], word => !word.includes(secret));
    let called = false;
    if (typeof planned === 'object') {
      called = true; const ready = f.service.tools.prepare(planned.tool!, planned.input ?? {},
        { scopeKey: 'owner', surface: 'autonomy', audience: 'owner_alone', memory: toolSessionMemory() });
      if (!('result' in ready)) await f.run(() => ready.prepared.run());
    }
    expect(planned).toBe('secret'); expect(called).toBe(false); expect(readFileSync(f.file, 'utf8')).toBe('{"items":[1]}');
    expect(plannedToolStep({ name: 'workspace.rewrite', input: { candidate: JSON.stringify(f.make('hidden-key', f.file, `{"${escaped}":1}`)) } },
      ['workspace.rewrite'], word => !word.includes(secret))).toBe('secret');
    const duplicate = f.make('hidden-duplicate', f.file, `{"text":"${escaped}","text":"public"}`);
    expect(checkRewriteData(duplicate)).toBe(true);
    expect(plannedToolStep({ name: 'workspace.rewrite', input: { candidate: JSON.stringify(duplicate) } },
      ['workspace.rewrite'], word => !word.includes(secret))).toBe('secret');
    const outerDuplicate = JSON.stringify(value).replace('"files":', `"ignored":"${escaped}","ignored":"public","files":`);
    expect(plannedToolStep({ name: 'workspace.rewrite', input: { candidate: outerDuplicate } },
      ['workspace.rewrite'], word => !word.includes(secret))).toBe('secret');
    for (const depth of [29, 30, 31, 32]) {
      const deep = `${'['.repeat(depth)}"${escaped}"${']'.repeat(depth)}`, original = f.make(`deep-${depth}`, f.file, deep);
      expect(checkRewriteData(original)).toBe(true);
      expect(plannedToolStep({ name: 'workspace.rewrite', input: { candidate: JSON.stringify(original) } },
        ['workspace.rewrite'], word => !word.includes(secret))).toBe('secret');
    }
    const overDepth = f.make('over-depth', f.file, `${'['.repeat(33)}1${']'.repeat(33)}`);
    expect(plannedToolStep({ name: 'workspace.rewrite', input: { candidate: JSON.stringify(overDepth) } },
      ['workspace.rewrite'], () => true)).toBe('secret');
  });
});
