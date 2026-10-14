import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SKILL_CAPACITY, encodeSkill } from '../src/mind/memory/skillDocument.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { ensureSkillSchema } from '../src/mind/memory/store/sqliteSkills.js';

const at = '2026-10-09T00:00:00.000Z';
const pass = { carries: () => false };
const document = (name: string) => ({ name, description: '予定を確かめる時', steps: '1. task.list で結果を確かめる', aids: '- 失敗なら制限を示す', references: '- 運用作成。実績は未記録。' });
function pack(...names: string[]): SkillPack {
  return { schemaVersion: 1, packId: 'test-pack', revision: 'v1', sourceAuthor: 'operator', sourceReference: 'https://example.com/contracts',
    referenceRevision: 'b85625ad', validatorRevision: 'skill-import-v1', skills: names.map(name => {
      const body = encodeSkill(document(name));
      return { name, body, sha256: skillArtifactSha256(body), tools: ['task.list'] };
    }) };
}
function world() {
  const database = new DatabaseSync(':memory:');
  const memory = new SkillMemory({ database, createsSchema: true, defer: task => task(), log: () => {} });
  const dependencies = { memory, ownerScopeKey: 'owner', check: () => pass as { carries(text: string): boolean } | null,
    tools: (_scope: string, tools: readonly string[], _body: string): readonly string[] | null => tools.every(tool => tool === 'task.list') ? [] : ['unknown_tool'] };
  return { database, memory, dependencies, importer: new SkillImporter(dependencies) };
}
function apply(importer: SkillImporter, candidate: SkillPack) {
  return importer.apply('owner', candidate, { planHash: importer.dryRun('owner', candidate).planHash, approvalReference: 'owner-request-20261009' }, at);
}

describe('owner-only provenance-bearing skill import on real SQLite', () => {
  it('does not create schema or import while the existing skill memory is disabled/uninitialized', () => {
    const database = new DatabaseSync(':memory:');
    const memory = new SkillMemory({ database, createsSchema: false, log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    expect(importer.dryRun('owner', pack('first')).problems).toContainEqual({ name: null, code: 'unavailable' });
    expect(apply(importer, pack('first'))).toEqual({ rejected: 'unavailable' });
    expect(database.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get()).toEqual({ n: 0 });
    database.close();
  });

  it('dry-runs without writes, imports all on trial with zero outcomes, and persists real provenance on the index and revision', () => {
    const { memory, importer, database } = world();
    const candidate = pack('first', 'second');
    const plan = importer.dryRun('owner', candidate);
    expect(plan.problems).toEqual([]);
    expect(plan.capacity).toEqual({ used: 0, added: 2, limit: SKILL_CAPACITY });
    expect(memory.store.all('owner')).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) n FROM shannon_skill_imports').get()).toEqual({ n: 0 });
    const result = apply(importer, candidate);
    expect(result).toMatchObject({ idempotent: false, receipt: { approvalReference: 'owner-request-20261009', skills: [{ name: 'first' }, { name: 'second' }] } });
    const skills = memory.store.all('owner');
    for (const skill of skills) {
      expect(skill).toMatchObject({ madeBy: 'operator_authored', status: 'trial', uses: [], successes: 0, sources: [expect.stringMatching(/^import:import_/u)],
        provenance: { origin: 'operator_authored', packId: 'test-pack', packRevision: 'v1', referenceRevision: 'b85625ad' } });
      expect(memory.store.revisions('owner', skill.skillId)).toMatchObject([{ actor: 'operator_authored', evidence: [], uses: 0, successes: 0, provenance: skill.provenance }]);
    }
    expect(memory.index('owner')).toContain('first（試し）（運用作成）');
    expect(memory.store.proposedSince('owner', at)).toEqual({ created: 0, updated: 0 });
  });

  it('retries the exact import without overwriting an owner edit or pin, and keeps revision/snapshot ancestry', () => {
    const { importer, memory } = world();
    const candidate = pack('first');
    const result = apply(importer, candidate);
    if ('rejected' in result) throw new Error(result.rejected);
    const id = result.receipt.skills[0]!.skillId;
    const first = memory.store.get('owner', id)!;
    expect(memory.adoptOwnerEdit('owner', id, first.body.replace('結果を確かめる', '一覧を確かめる'), { documentId: 'copy-first', version: 2 }, pass, at)).toBe('adopted');
    memory.store.setPinned('owner', id, true);
    expect(apply(importer, candidate)).toEqual({ receipt: result.receipt, idempotent: true });
    expect(memory.store.get('owner', id)).toMatchObject({ madeBy: 'owner_edit', pinned: true, version: 2, provenance: first.provenance });
    expect(memory.rollback('owner', id, 1, 'owner', at, pass)).toBe('restored');
    expect(memory.store.revisions('owner', id).every(revision => revision.provenance?.importReceiptId === result.receipt.receiptId)).toBe(true);
  });

  it('lets actual uses run the existing trial lifecycle, and records no successes from import', () => {
    const { importer, memory } = world();
    apply(importer, pack('first'));
    expect(memory.lifecycle('owner', at, pass)).toEqual({ accepted: [], reverted: [], retired: [] });
    for (let i = 0; i < 2; i++) {
      memory.used('owner', 'first', { talk: `talk-${i}`, growth: 1 }, at);
      memory.nextTurn('owner', `talk-${i}`, 1, at);
    }
    expect(memory.lifecycle('owner', at, pass).accepted).toHaveLength(1);
    expect(memory.store.byName('owner', 'first')).toMatchObject({ status: 'active', successes: 2 });
  });

  it('rejects non-owner scopes, hash changes, unsafe/check-unavailable bodies and unrecognized tools without writes', () => {
    const { importer, dependencies, memory } = world();
    const candidate = pack('first');
    expect(() => importer.dryRun('guest', candidate)).toThrow('SKILL_IMPORT_OWNER_ONLY');
    expect(importer.apply('guest', candidate, { planHash: 'a'.repeat(64), approvalReference: 'owner' }, at)).toEqual({ rejected: 'owner_only' });
    const corrupted = { ...candidate, skills: [{ ...candidate.skills[0]!, body: candidate.skills[0]!.body + 'x' }] };
    expect(importer.dryRun('owner', corrupted).problems).toContainEqual({ name: 'first', code: 'hash_mismatch' });
    dependencies.check = () => null;
    expect(apply(importer, candidate)).toMatchObject({ rejected: 'validation_failed', plan: { problems: [{ name: 'first', code: 'check_unavailable' }] } });
    dependencies.check = () => ({ carries: () => true });
    expect(importer.dryRun('owner', candidate).problems).toContainEqual({ name: 'first', code: 'unsafe_body' });
    dependencies.check = () => pass;
    const unknown = { ...candidate, skills: [{ ...candidate.skills[0]!, tools: ['unrecognized.tool'] }] };
    expect(apply(importer, unknown)).toMatchObject({ rejected: 'validation_failed' });
    dependencies.tools = () => null;
    expect(importer.dryRun('owner', candidate).problems).toContainEqual({ name: 'first', code: 'tools_unavailable' });
    expect(memory.store.all('owner', { includeRetired: true })).toEqual([]);
  });

  it('rejects lint, duplicates, pinned/owner/trial name collisions, and capacity without retiring any existing skill', () => {
    const { importer, memory } = world();
    const candidate = pack('first');
    const body = candidate.skills[0]!.body.replace('実績は未記録。', '2026-10-01 と2026-10-02 の記録。');
    expect(importer.dryRun('owner', { ...candidate, skills: [{ ...candidate.skills[0]!, body, sha256: skillArtifactSha256(body) }] }).problems).toContainEqual({ name: 'first', code: 'lint_incident_log' });
    expect(importer.dryRun('owner', pack('first', 'first')).problems).toContainEqual({ name: 'first', code: 'duplicate_name' });
    const created = memory.create('owner', { draft: document('first'), evidence: [] }, pass, at);
    if ('rejected' in created) throw new Error(created.rejected);
    expect(importer.dryRun('owner', candidate).problems).toContainEqual({ name: 'first', code: 'on_trial' });
    memory.store.setPinned('owner', created.skillId, true);
    expect(importer.dryRun('owner', candidate).problems).toContainEqual({ name: 'first', code: 'pinned' });
    memory.store.setPinned('owner', created.skillId, false);
    memory.adoptOwnerEdit('owner', created.skillId, encodeSkill(document('first')).replace('結果を確かめる', '一覧を確かめる'), { documentId: 'copy-first', version: 2 }, pass, at);
    expect(importer.dryRun('owner', candidate).problems).toContainEqual({ name: 'first', code: 'owner_edited' });
    for (let i = 0; i < SKILL_CAPACITY - 1; i++) memory.create('owner', { draft: document(`existing-${i}`), evidence: [] }, pass, at);
    expect(apply(importer, pack('second'))).toMatchObject({ rejected: 'validation_failed', plan: { problems: [{ name: null, code: 'over_capacity' }] } });
    expect(memory.store.all('owner')).toHaveLength(SKILL_CAPACITY);
  });

  it('rejects stale plans and changed revisions, never overrides or creates another version', () => {
    const { importer, memory } = world();
    const candidate = pack('first');
    const plan = importer.dryRun('owner', candidate);
    memory.create('owner', { draft: document('existing'), evidence: [] }, pass, at);
    expect(importer.apply('owner', candidate, { planHash: plan.planHash, approvalReference: 'owner' }, at)).toMatchObject({ rejected: 'stale_plan' });
    apply(importer, candidate);
    const changedBody = candidate.skills[0]!.body.replace('結果', '一覧');
    const changed = { ...candidate, skills: [{ ...candidate.skills[0]!, body: changedBody, sha256: skillArtifactSha256(changedBody) }] };
    expect(importer.dryRun('owner', changed).problems).toContainEqual({ name: null, code: 'pack_revision_conflict' });
    expect(apply(importer, changed)).toMatchObject({ rejected: 'validation_failed' });
    expect(memory.store.byName('owner', 'first')!.version).toBe(1);
  });

  it('rolls back the whole pack on a real SQLite failure partway through insert', () => {
    const { importer, memory, database } = world();
    database.exec("CREATE TRIGGER fail_second BEFORE INSERT ON shannon_skills WHEN NEW.name = 'second' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(apply(importer, pack('first', 'second'))).toEqual({ rejected: 'unavailable' }); } finally { quiet.mockRestore(); }
    expect(memory.store.all('owner', { includeRetired: true })).toEqual([]);
    expect(memory.store.audits('owner')).toEqual([]);
    expect(memory.store.revisions('owner')).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) n FROM shannon_skill_imports').get()).toEqual({ n: 0 });
  });

  it('reports no receipt when SQLite rejects COMMIT after the callback wrote every row', () => {
    const { importer, memory, database } = world();
    database.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE commit_parent (id TEXT PRIMARY KEY);
      CREATE TABLE commit_guard (id TEXT REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON shannon_skills BEGIN INSERT INTO commit_guard VALUES (NEW.skill_id); END`);
    expect(apply(importer, pack('first'))).toEqual({ rejected: 'unavailable' });
    expect(memory.store.all('owner')).toEqual([]);
    expect(memory.store.revisions('owner')).toEqual([]);
    expect(memory.store.audits('owner')).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) n FROM shannon_skill_imports').get()).toEqual({ n: 0 });
  });

  it('keeps forgotten/withdrawn and unknown-source skills out of the index and body', () => {
    const { importer, memory, database } = world();
    apply(importer, pack('first'));
    const id = memory.store.byName('owner', 'first')!.skillId;
    memory.store.setExportHold('owner', id, 'withdrawn');
    expect(memory.index('owner')).toBe('');
    expect(memory.open('owner', 'first')).toBeNull();
    memory.store.setExportHold('owner', id, null);
    database.prepare('UPDATE shannon_skills SET sources_json = ? WHERE skill_id = ?').run('["unknown:source"]', id);
    expect(memory.open('owner', 'first')).toBeNull();
    database.prepare('UPDATE shannon_skills SET sources_json = ? WHERE skill_id = ?').run('["import:missing"]', id);
    expect(memory.open('owner', 'first')).toBeNull();
    const learned = memory.create('owner', { draft: document('learned'), evidence: ['experience:turn-forgotten'] }, pass, at);
    expect(learned).toHaveProperty('skillId');
    expect(memory.open('owner', 'learned', () => false)).toBeNull();
  });

  it('bundles ten exact validated versioned artifacts without an automatic live DB import, independent of cwd', () => {
    const { importer, memory, dependencies } = world();
    dependencies.tools = () => [];
    const candidate = standardSkillPack('standard10', 'draft-2')!;
    expect(candidate.skills).toHaveLength(10);
    expect(candidate.skills.every(entry => skillArtifactSha256(entry.body) === entry.sha256)).toBe(true);
    expect(importer.dryRun('owner', candidate).problems).toEqual([]);
    expect(memory.store.all('owner')).toEqual([]);
    expect(standardSkillPack('../standard10', 'draft-2')).toBeNull();
    expect(standardSkillPack('standard10', 'latest')).toBeNull();
  });

  it('migrates historic constraints atomically, retaining rows, revisions, indexes and triggers, and is restart-safe', () => {
    const { database, memory } = world();
    const created = memory.create('owner', { draft: document('historic'), evidence: [] }, pass, at);
    if ('rejected' in created) throw new Error(created.rejected);
    const historic = new DatabaseSync(':memory:');
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('shannon_skills', 'shannon_skill_revisions')").all() as { name: string; sql: string }[];
    for (const table of tables) {
      historic.exec(table.sql.replaceAll(", 'operator_authored'", ''));
      const rows = database.prepare(`SELECT * FROM ${table.name}`).all();
      for (const row of rows) historic.prepare(`INSERT INTO ${table.name} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    }
    historic.exec('CREATE INDEX historic_index ON shannon_skills(name); CREATE TRIGGER historic_trigger AFTER UPDATE OF pinned ON shannon_skills BEGIN SELECT 1; END');
    const migrated = new SkillMemory({ database: historic, createsSchema: true, log: () => {} });
    expect(migrated.store.get('owner', created.skillId)).toEqual(memory.store.get('owner', created.skillId));
    expect(migrated.store.revisions('owner')).toEqual(memory.store.revisions('owner'));
    expect(historic.prepare("SELECT name FROM sqlite_master WHERE name IN ('historic_index','historic_trigger') ORDER BY name").all()).toEqual([{ name: 'historic_index' }, { name: 'historic_trigger' }]);
    const importer = new SkillImporter({ memory: migrated, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    expect(apply(importer, pack('operator'))).toHaveProperty('receipt');
    const restarted = new SkillMemory({ database: historic, createsSchema: true, log: () => {} });
    expect(restarted.store.all('owner')).toHaveLength(2);
    expect(restarted.store.byName('owner', 'operator')!.madeBy).toBe('operator_authored');
  });

  it('preserves the supported pre-lineage unconstrained revision schema while rejecting an unrecognized variant', () => {
    const legacy = `CREATE TABLE shannon_skill_revisions (revision_id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, scope_key TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
      body TEXT NOT NULL, body_hash TEXT NOT NULL, made_by TEXT NOT NULL, actor TEXT NOT NULL, evidence_json TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT NOT NULL,
      pinned INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`;
    const database = new DatabaseSync(':memory:');
    database.exec(legacy);
    database.prepare('INSERT INTO shannon_skill_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('r1', 's1', 'owner', 1, 'version', 'Historic body', 'hash', 'sleep', 'owner', '[]', null, 'hash', 1, 'Historic reason', at);
    ensureSkillSchema(database); ensureSkillSchema(database);
    expect(database.prepare('SELECT body,pinned,actor,provenance_json,uses,successes FROM shannon_skill_revisions').get()).toEqual({ body: 'Historic body', pinned: 1, actor: 'owner', provenance_json: null, uses: 0, successes: 0 });
    database.close();
    const unknown = new DatabaseSync(':memory:');
    unknown.exec(legacy.replace('reason TEXT NOT NULL', "reason TEXT NOT NULL CHECK(reason != 'custom')"));
    expect(() => ensureSkillSchema(unknown)).toThrow('SKILL_IMPORT_SCHEMA_UNRECOGNIZED');
    expect(unknown.prepare('PRAGMA table_info(shannon_skill_revisions)').all().some(column => column.name === 'provenance_json')).toBe(false);
    unknown.close();
  });
});
