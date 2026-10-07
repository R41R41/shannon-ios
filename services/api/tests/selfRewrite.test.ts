import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SELF_REWRITE_SCHEMA, type SelfRewriteCandidate, type SelfRewriteChecks } from '../src/mind/inhibition/selfRewritePorts.js';
import { SelfRewriteService, selfRewriteContentHash, selfRewriteDiffHash } from '../src/mind/inhibition/selfRewriteService.js';
import { SelfRewriteStore } from '../src/mind/inhibition/store/selfRewriteStore.js';
import { selfRewriteWiring, selfRewriteTargets } from '../src/wiring/selfRewriteWiring.js';

const at = '2026-10-08T03:00:00.000Z';
const directories: string[] = [], connections: DatabaseSync[] = [], closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach(close => close()); connections.splice(0).forEach(connection => connection.isOpen && connection.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'shannon-rewrite-')); directories.push(path); return path; }
function candidate(id = 'candidate-one', path = '/isolated/tool.ts'): SelfRewriteCandidate {
  const files = [{ path, beforeHash: selfRewriteContentHash('old'), content: 'new' }];
  return { schema: SELF_REWRITE_SCHEMA, id, workId: 'canonical-work', scopeKey: 'owner', sourceId: 'source-task',
    origin: 'own_time', budgetLane: 'autonomy', baseRevision: 'base-one', diffHash: selfRewriteDiffHash(files), files };
}
function fixture(path = ':memory:') {
  const connection = new DatabaseSync(path); connections.push(connection); const store = new SelfRewriteStore(connection);
  const calls: string[] = [];
  const control = { enabled: true, stopped: false, banned: false, generation: 1 };
  let base = 'base-one', approval = false;
  const checks: SelfRewriteChecks = {
    authority: (_work, scope) => scope === 'owner' ? { sourceId: 'source-task', origin: 'own_time', budgetLane: 'autonomy', permissionId: 'original-right', ownerInformed: false } : null,
    control: () => control,
    budgetAndRights: () => { calls.push('authority'); return true; },
    targets: value => { calls.push('paths'); return { paths: value.files.map(file => file.path), isolated: true, approvalRequired: approval }; },
    currentBase: () => base,
    tests: async () => { calls.push('tests'); return true; }, safetyDiff: async () => { calls.push('safety'); return true; },
    snapshot: async (value, phase) => { calls.push(`snapshot:${phase}`); return { id: `snapshot-${phase}`,
      hashes: Object.fromEntries(value.files.map(file => [file.path, phase === 'before' ? file.beforeHash : file.content === null ? null : selfRewriteContentHash(file.content)])) }; },
    apply: async (_value, _targets, permit) => { if (!await permit()) return 'failed'; calls.push('apply'); return 'completed'; },
  };
  const service = new SelfRewriteService(store, checks, () => at);
  return { store, service, connection, checks, control, calls, setBase: (value: string) => { base = value; }, requireApproval: () => { approval = true; } };
}
describe('sequential self rewrite gates', () => {
  it('rejects schema, forged source/origin/budget and modified diff before downstream execution', () => {
    const context = fixture(), good = candidate();
    for (const bad of [{ ...good, schema: 'foreign' }, { ...good, sourceId: 'foreign' }, { ...good, origin: 'owner_request' },
      { ...good, budgetLane: 'owner' }, { ...good, diffHash: 'approved-in-a-document' }]) {
      expect(() => context.service.submit(bad as SelfRewriteCandidate)).toThrow('REWRITE_PROVENANCE_INVALID');
    }
    expect(context.calls).toEqual([]);
    expect(context.connection.prepare('SELECT count(*) AS n FROM self_rewrite_candidates').get()).toEqual({ n: 0 });
  });
  it.each(['stopped', 'banned', 'disabled'] as const)('closes %s before authority/tests/snapshots/apply', async flag => {
    const context = fixture(); context.service.submit(candidate());
    if (flag === 'disabled') context.control.enabled = false; else context.control[flag] = true;
    expect(await context.service.dispatch('owner', 'candidate-one')).toMatchObject({ state: 'refused', gate: 'stop' });
    expect(context.calls).toEqual([]);
  });
  it.each(['authority', 'paths', 'approval', 'tests', 'safety', 'snapshot'] as const)('fails %s with zero later side effects', async gate => {
    const context = fixture(); const value = candidate(); context.service.submit(value);
    if (gate === 'authority') context.checks.budgetAndRights = () => false;
    if (gate === 'paths') context.checks.targets = () => null;
    if (gate === 'approval') context.requireApproval();
    if (gate === 'tests') context.checks.tests = async () => false;
    if (gate === 'safety') context.checks.safetyDiff = async () => false;
    if (gate === 'snapshot') context.checks.snapshot = async () => null;
    expect(await context.service.dispatch('owner', value.id)).toMatchObject({ state: 'refused', gate });
    expect(context.calls).not.toContain('apply');
    if (['authority', 'paths', 'approval'].includes(gate)) expect(context.calls).not.toContain('tests');
    if (['authority', 'paths', 'approval', 'tests'].includes(gate)) expect(context.calls).not.toContain('safety');
    if (['authority', 'paths', 'approval', 'tests', 'safety'].includes(gate)) expect(context.calls).not.toContain('snapshot:before');
  });
  it('requires exact candidate/diff/base/scope/work generation grant and stops stale base before testing', async () => {
    const context = fixture(); const value = candidate(); context.service.submit(value); context.requireApproval();
    expect(context.store.grant('other', value.id, value.diffHash, value.baseRevision, 1, at)).toBe(false);
    expect(context.store.grant('owner', value.id, 'foreign', value.baseRevision, 1, at)).toBe(false);
    expect(context.store.grant('owner', value.id, value.diffHash, 'old-base', 1, at)).toBe(false);
    expect(context.store.grant('owner', value.id, value.diffHash, value.baseRevision, 2, at)).toBe(false);
    expect(context.store.grant('owner', value.id, value.diffHash, value.baseRevision, 1, at)).toBe(true);
    context.setBase('changed');
    expect(await context.service.dispatch('owner', value.id)).toMatchObject({ gate: 'approval', code: 'base_revision_changed' });
    expect(context.calls).not.toContain('tests');
  });
  it('preserves free isolated non-core positive flow without a grant and never reapplies a completed candidate', async () => {
    const context = fixture(); const value = candidate(); context.service.submit(value);
    expect(await context.service.dispatch('owner', value.id)).toMatchObject({ state: 'completed' });
    expect(await context.service.dispatch('owner', value.id)).toMatchObject({ state: 'refused' });
    expect(context.calls.filter(call => call === 'apply')).toHaveLength(1);
  });
  it('persists same-work five failures despite new diff IDs/restart and only explicit owner resume releases freeze', async () => {
    const path = join(directory(), 'db.sqlite'); let context = fixture(path); context.checks.tests = async () => false;
    for (let index = 0; index < 3; index++) { const value = candidate(`first-${index}`); context.service.submit(value); await context.service.dispatch('owner', value.id); }
    context.connection.close(); context = fixture(path); context.checks.tests = async () => false;
    for (let index = 0; index < 2; index++) { const value = candidate(`second-${index}`); context.service.submit(value); await context.service.dispatch('owner', value.id); }
    expect(context.store.work('owner', 'canonical-work')).toMatchObject({ failures: 5, frozen: true });
    const next = candidate('new-diff-after-five'); context.service.submit(next);
    expect(await context.service.dispatch('owner', next.id)).toMatchObject({ gate: 'freeze' });
    expect(context.store.ownerResume('owner', 'canonical-work', 2, at)).toBe(false);
    expect(context.store.ownerResume('owner', 'canonical-work', 1, at)).toBe(true);
    context.checks.tests = async () => true;
    expect(await context.service.dispatch('owner', next.id)).toMatchObject({ state: 'completed' });
    expect(context.store.work('owner', 'canonical-work')).toMatchObject({ failures: 0, frozen: false, generation: 2 });
  });
  it('rechecks stop, base, rights, paths and preimage after async tests and before real apply', async () => {
    const context = fixture(); context.service.submit(candidate());
    context.checks.tests = async () => { context.control.stopped = true; return true; };
    expect(await context.service.dispatch('owner', 'candidate-one')).toMatchObject({ gate: 'dispatch', state: 'refused' });
    expect(context.calls).not.toContain('apply');
  });
  it('holds a generic apply exception as unknown, never resumes/replays, and recovers only matching original ACK', async () => {
    const context = fixture(); const value = candidate(); context.service.submit(value);
    context.checks.apply = async () => { context.calls.push('apply'); throw new Error('transport'); };
    expect(await context.service.dispatch('owner', value.id)).toMatchObject({ state: 'unknown' });
    context.service.submit(candidate('new-diff'));
    expect(await context.service.dispatch('owner', 'new-diff')).toMatchObject({ gate: 'unknown' });
    expect(context.store.ownerResume('owner', value.workId, 1, at)).toBe(false);
    expect(context.service.acknowledge('owner', 'new-diff', 'completed', { id: 'foreign', hashes: {} })).toBe(false);
    expect(context.service.acknowledge('owner', value.id, 'completed', { id: 'original', hashes: { [value.files[0]!.path]: selfRewriteContentHash('new') } })).toBe(true);
    expect(context.service.acknowledge('owner', value.id, 'completed', { id: 'duplicate', hashes: {} })).toBe(false);
    expect(context.calls.filter(call => call === 'apply')).toHaveLength(1);
  });
  it('restores an interrupted applying record as unknown and keeps the same original candidate after reopening', () => {
    const path = join(directory(), 'db.sqlite'), original = fixture(path), value = candidate(); original.service.submit(value);
    expect(original.store.claim(value, at)).not.toBeNull(); expect(original.store.beginApply(value, 1, { id: 'pre', hashes: {} }, at)).toBe(true);
    original.connection.close(); const reopened = fixture(path); expect(reopened.store.recoverInterrupted(at)).toBe(1);
    expect(reopened.store.work('owner', value.workId)).toMatchObject({ activeCandidate: value.id, state: 'unknown' });
  });
  it('closes a pre-dispatch interrupted candidate, preserves failures, and requires a fresh candidate without replaying the old one', async () => {
    const path = join(directory(), 'db.sqlite'); let original = fixture(path);
    original.checks.tests = async () => false;
    for (const id of ['failed-one', 'failed-two']) { original.service.submit(candidate(id)); await original.service.dispatch('owner', id); }
    const value = candidate('only-validating'); original.service.submit(value);
    expect(original.store.claim(value, at)).toMatchObject({ state: 'validating', failures: 2 }); original.connection.close();
    original = fixture(path); expect(original.store.recoverInterrupted(at)).toBe(1);
    expect(original.store.work('owner', value.workId)).toMatchObject({ activeCandidate: null, state: 'idle', failures: 2, frozen: false, generation: 1 });
    expect(original.connection.prepare('SELECT state,before_json FROM self_rewrite_candidates WHERE candidate_id=?').get(value.id)).toEqual({ state: 'refused', before_json: null });
    expect(original.store.recoverInterrupted(at)).toBe(0);
    expect(await original.service.dispatch('owner', value.id)).toMatchObject({ state: 'refused', gate: 'dispatch' });
    expect(original.store.beginApply(value, 1, { id: 'stale', hashes: {} }, at)).toBe(false);
    const fresh = candidate('fresh-candidate'); original.service.submit(fresh);
    expect(await original.service.dispatch('owner', fresh.id)).toMatchObject({ state: 'completed' });
    expect(original.calls.filter(call => call === 'apply')).toHaveLength(1);
  });
  it('commits applying before dispatch and never grants an executor inside an outer transaction', async () => {
    const path = join(directory(), 'db.sqlite'), context = fixture(path), reader = fixture(path), value = candidate();
    context.service.submit(value); expect(context.store.claim(value, at)).not.toBeNull();
    context.connection.exec('BEGIN IMMEDIATE');
    expect(context.store.beginApply(value, 1, { id: 'not-durable', hashes: {} }, at)).toBe(false);
    expect(context.store.work('owner', value.workId).state).toBe('validating'); context.connection.exec('ROLLBACK');
    expect(context.store.beginApply(value, 1, { id: 'durable', hashes: {} }, at)).toBe(true);
    expect(reader.store.work('owner', value.workId)).toMatchObject({ state: 'applying', activeCandidate: value.id });
    expect(reader.store.recoverInterrupted(at)).toBe(1);
    expect(context.store.work('owner', value.workId)).toMatchObject({ state: 'unknown', activeCandidate: value.id });
    expect(context.store.ownerResume('owner', value.workId, 1, at)).toBe(false);
  });
  it('fences a stale validator across recovery and another same-work claim without releasing its replacement', async () => {
    const path = join(directory(), 'db.sqlite'), original = fixture(path), restarted = fixture(path);
    const old = candidate('old-validating'), fresh = candidate('new-validating'); let release!: () => void;
    original.checks.tests = async () => new Promise(resolve => { release = () => resolve(true); });
    original.service.submit(old); original.service.submit(fresh);
    const pending = original.service.dispatch('owner', old.id); await Promise.resolve(); await Promise.resolve();
    expect(restarted.store.claim(fresh, at)).toBeNull(); expect(restarted.store.recoverInterrupted(at)).toBe(1);
    expect(restarted.store.claim(fresh, at)).toMatchObject({ state: 'validating', activeCandidate: fresh.id });
    release(); expect(await pending).toMatchObject({ state: 'refused', gate: 'dispatch' });
    expect(original.calls).not.toContain('apply');
    expect(original.store.work('owner', old.workId)).toMatchObject({ state: 'validating', activeCandidate: fresh.id });
    expect(original.store.beginApply(old, 1, { id: 'stale', hashes: {} }, at)).toBe(false);
    expect(restarted.store.beginApply(fresh, 1, { id: 'current', hashes: {} }, at)).toBe(true);
    expect(original.store.work('owner', old.workId)).toMatchObject({ state: 'applying', activeCandidate: fresh.id });
  });
  it('serializes same-work candidates while verification waits, so another diff cannot bypass a live claim', async () => {
    const context = fixture(); let release!: () => void;
    context.checks.tests = async () => new Promise(resolve => { release = () => resolve(true); });
    context.service.submit(candidate('one')); context.service.submit(candidate('two'));
    const running = context.service.dispatch('owner', 'one'); await Promise.resolve(); await Promise.resolve();
    expect(await context.service.dispatch('owner', 'two')).toMatchObject({ state: 'refused' }); release();
    expect(await running).toMatchObject({ state: 'completed' });
    expect(context.calls.filter(call => call === 'apply')).toHaveLength(1);
  });
});
describe('actual isolated workspace executor', () => {
  it('writes real files with snapshots and original executable mode while respecting real-path core boundaries', async () => {
    const root = directory(), path = join(root, 'tool.ts'); writeFileSync(path, 'old'); chmodSync(path, 0o755);
    const context = fixture(), wiring = selfRewriteWiring({ enabled: true, path: ':memory:', ownerScope: 'owner', now: () => at,
      places: { isolatedRoot: root, repositoryRoots: [], productionRoots: [], protectedPaths: [] }, checks: context.checks }); closers.push(wiring.close);
    const value = candidate('actual', path); wiring.service!.submit(value);
    expect(await wiring.service!.dispatch('owner', value.id)).toMatchObject({ state: 'completed' });
    expect(readFileSync(path, 'utf8')).toBe('new'); expect(lstatSync(path).mode & 0o777).toBe(0o755);
  });
  it('refuses a symlink into production without exact approval and never falls back to the free writer for core', async () => {
    const root = directory(), outside = directory(), target = join(outside, 'core.ts'); writeFileSync(target, 'old');
    const link = join(root, 'linked.ts'); symlinkSync(target, link); const context = fixture();
    const wiring = selfRewriteWiring({ enabled: true, path: ':memory:', ownerScope: 'owner', now: () => at,
      places: { isolatedRoot: root, repositoryRoots: [], productionRoots: [outside], protectedPaths: [] }, checks: context.checks }); closers.push(wiring.close);
    const value = candidate('symlink', link); wiring.service!.submit(value);
    expect(await wiring.service!.dispatch('owner', value.id)).toMatchObject({ gate: 'approval' }); expect(readFileSync(target, 'utf8')).toBe('old');
    const corePath = join(root, 'services/api/src/mind/inhibition/autonomyCore.ts');
    expect(selfRewriteTargets(candidate('core', corePath), { isolatedRoot: root, repositoryRoots: [root], productionRoots: [], protectedPaths: [] })?.approvalRequired).toBe(true);
  });
  it('closes Stage5 OFF with no store/writer and rejects another owner before reading candidate data', async () => {
    const context = fixture(), wiring = selfRewriteWiring({ enabled: false, path: join(directory(), 'never-opened.sqlite'), ownerScope: 'owner', now: () => at,
      places: { isolatedRoot: null, repositoryRoots: [], productionRoots: [], protectedPaths: [] }, checks: context.checks });
    expect(wiring.service).toBeNull(); expect(await wiring.route({ method: 'GET', path: '/v1/autonomy/self-rewrite/work/work-one', query: new URLSearchParams({ scopeKey: 'owner' }) })).toMatchObject({ status: 503 });
    const on = selfRewriteWiring({ enabled: true, path: ':memory:', ownerScope: 'owner', now: () => at,
      places: { isolatedRoot: null, repositoryRoots: [], productionRoots: [], protectedPaths: [] }, checks: context.checks }); closers.push(on.close);
    expect(await on.route({ method: 'GET', path: '/v1/autonomy/self-rewrite/candidates/candidate-one', query: new URLSearchParams({ scopeKey: 'other' }) })).toMatchObject({ status: 403 });
  });
});
