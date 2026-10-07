import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SkillStatus } from '../skillDocument.js';
import { ensureColumns } from '../../../infra/sqlite/schemaColumns.js';
import { ensureSkillSleepUsageSchema } from './sqliteSkillSleepUsage.js';
import { versionRevisionId } from '../skillLineage.js';

/**
 * Her skills, their versions, the pattern wiki they come from, and the audit of every change (Syzygy ADR-0008 stage 2, step 6;
 * `docs/skill-and-routing-contract.md`, 「スキル記憶」, after WikiSkill's three layers). Core: memory.
 *
 * - `shannon_skills`: one row per skill: its current SKILL.md, its status (`trial`, `active`, `retired`), the patterns that
 *   motivated it (`purpose_pattern_ids_json`), the version its trial would revert to, the outcomes of its recent uses (a short JSON
 *   array of ids, instants, numbers and closed values: never words), its sources (ids), and where its copy in Aether is (step 7).
 * - `shannon_skill_revisions`: every version, with who made it (`sleep` or `owner_edit`) and a closed reason; with ADR-0008 §14 its
 *   lineage (`parent_revision_id`, the version it restores `variant_of`) and its settled uses and successes (`skillLineage.ts`).
 * - `shannon_skill_patterns` and `shannon_skill_pattern_log`: the wiki layer, pages of a failure mode or a strategy with what to do
 *   about it, and the log of how each page evolved (created, patched, appended, merged, deprecated). Never given to a turn.
 * - `shannon_skill_audit`: each skill change the sleep proposed, its diff, the patterns it was for, the rate it had to reach, what
 *   its trial measured and whether it was accepted or reverted, so that a reverted change is not proposed again.
 *
 * - `shannon_skill_copy_writes` (review M2): her own `aetherFolder.update` and `.delete` of one of her skills' copies, with the
 *   hash of the body she wrote, so that the export reads that change as hers (`shannon_copy`) and never as the owner's.
 *
 * Nothing is deleted: a retired skill and a deprecated page are kept for reference. The raw experience (turns, choices, tool and
 * step outcomes) lives in its own tables and is only read. Additive, created by the API process only, outside the numbered migrations.
 */
export const SKILLS_TABLE = 'shannon_skills';

export function ensureSkillSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_skills (
      skill_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('trial', 'active', 'retired')),
      version INTEGER NOT NULL,
      body TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      made_by TEXT NOT NULL CHECK (made_by IN ('sleep', 'owner_edit')),
      sources_json TEXT NOT NULL,
      purpose_pattern_ids_json TEXT NOT NULL DEFAULT '[]',
      trial_base_version INTEGER,
      trial_audit_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      uses_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status_at TEXT NOT NULL,
      status_reason TEXT,
      aether_document_id TEXT,
      aether_version INTEGER,
      exported_hash TEXT,
      exported_at TEXT,
      export_hold TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_skills_scope ON shannon_skills (scope_key, status);
    CREATE TABLE IF NOT EXISTS shannon_skill_revisions (
      revision_id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('version', 'snapshot')),
      body TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      made_by TEXT NOT NULL CHECK (made_by IN ('sleep', 'owner_edit')),
      actor TEXT NOT NULL CHECK (actor IN ('sleep', 'conversation', 'owner', 'shannon_copy')),
      evidence_json TEXT NOT NULL,
      before_sha256 TEXT,
      after_sha256 TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      parent_revision_id TEXT,
      variant_of TEXT,
      uses INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS shannon_skill_revisions_skill ON shannon_skill_revisions (skill_id, version);
    CREATE INDEX IF NOT EXISTS shannon_skill_revisions_scope ON shannon_skill_revisions (scope_key, created_at);
    CREATE TABLE IF NOT EXISTS shannon_skill_patterns (
      pattern_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('failure', 'strategy')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'deprecated')),
      superseded_by TEXT,
      version INTEGER NOT NULL,
      sources_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shannon_skill_patterns_scope ON shannon_skill_patterns (scope_key, status);
    CREATE TABLE IF NOT EXISTS shannon_skill_pattern_log (
      log_id TEXT PRIMARY KEY,
      pattern_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('create', 'patch', 'append', 'merge', 'deprecate')),
      body TEXT NOT NULL,
      related_id TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shannon_skill_pattern_log_scope ON shannon_skill_pattern_log (scope_key, at);
    CREATE TABLE IF NOT EXISTS shannon_skill_audit (
      audit_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'patch', 'copy_delete')),
      from_version INTEGER,
      to_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      diff TEXT NOT NULL,
      purpose_pattern_ids_json TEXT NOT NULL,
      baseline_rate REAL,
      lint_json TEXT NOT NULL DEFAULT '[]',
      trial_uses INTEGER NOT NULL DEFAULT 0,
      trial_successes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('trial', 'accepted', 'reverted', 'superseded')),
      proposed_at TEXT NOT NULL,
      decided_at TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_skill_audit_scope ON shannon_skill_audit (scope_key, status);
    CREATE TABLE IF NOT EXISTS shannon_skill_copy_writes (
      write_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('update', 'delete')),
      body_hash TEXT,
      at TEXT NOT NULL,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS shannon_skill_copy_writes_skill ON shannon_skill_copy_writes (scope_key, skill_id, processed_at);
  `);
  ensureSkillSleepUsageSchema(database);
  // ADR-0008 §14's lineage columns, added when the table already existed without them.
  ensureColumns(database, 'shannon_skill_revisions', { parent_revision_id: 'TEXT', variant_of: 'TEXT', uses: 'INTEGER NOT NULL DEFAULT 0', successes: 'INTEGER NOT NULL DEFAULT 0' });
}

/** One use of a skill: when, in which Talk, of which version, G at the turn's end, and its outcome once settled (`tierOutcome`). */
export interface SkillUse { id: string; at: string; talk: string; v: number; g: number; o: 0 | 1 | null }

export interface StoredSkill {
  skillId: string;
  scopeKey: string;
  name: string;
  description: string;
  status: SkillStatus;
  version: number;
  body: string;
  bodyHash: string;
  madeBy: 'sleep' | 'owner_edit';
  /** What it was built from, by id: `experience:<id>`, `knowledge:<id>`, `pattern:<id>`, `sequence:<symbols>`. */
  sources: readonly string[];
  /** The pattern pages that motivated it (its PURPOSE). */
  purposePatternIds: readonly string[];
  /** While its version is on trial: the version a failed trial reverts to (null for a new skill), and the audit entry. */
  trialBaseVersion: number | null;
  trialAuditId: string | null;
  /** Pinned (by the owner): the sleep never writes to it. */
  pinned: boolean;
  successes: number;
  uses: readonly SkillUse[];
  createdAt: string;
  updatedAt: string;
  statusAt: string;
  statusReason: string | null;
  aetherDocumentId: string | null;
  aetherVersion: number | null;
  exportedHash: string | null;
  exportedAt: string | null;
  /** Why its copy is not written: `owner_deleted` (the owner removed it), `owner_edit_unadopted` (his edit could not be adopted). */
  exportHold: string | null;
}

/** Who made a revision (Hermes Agent's provenance, adapted): her sleep, a conversation, the owner, or her own edit of a copy (M2). */
export type SkillActor = 'sleep' | 'conversation' | 'owner' | 'shannon_copy';


/**
 * A revision: a version, or a safety snapshot of the current state taken before a rollback. Each records who made it, the
 * evidence ids it was made from, the sha256 of the body before and after, and whether the skill was pinned.
 */
export interface SkillRevision {
  revisionId: string; skillId: string; version: number; kind: 'version' | 'snapshot'; body: string; bodyHash: string; madeBy: 'sleep' | 'owner_edit';
  actor: SkillActor; evidence: readonly string[]; beforeSha256: string | null; afterSha256: string; pinned: boolean; reason: string; createdAt: string;
  /** ADR-0008 §14: the version it was derived from, the version it restores, and its settled uses and successes. */
  parentRevisionId: string | null; variantOf: string | null; uses: number; successes: number;
}

/** The revision id of a version of a skill. */

export interface StoredPattern {
  patternId: string; scopeKey: string; kind: 'failure' | 'strategy'; title: string; body: string; status: 'active' | 'deprecated';
  supersededBy: string | null; version: number; sources: readonly string[]; createdAt: string; updatedAt: string;
}

export interface PatternLogEntry { logId: string; patternId: string; version: number; operation: 'create' | 'patch' | 'append' | 'merge' | 'deprecate'; body: string; relatedId: string | null; at: string }

export interface SkillAuditEntry {
  auditId: string; scopeKey: string; skillId: string; target: string; kind: 'create' | 'patch' | 'copy_delete'; fromVersion: number | null; toVersion: number;
  proposalHash: string; diff: string; purposePatternIds: readonly string[]; baselineRate: number | null; lint: readonly string[]; trialUses: number; trialSuccesses: number;
  status: 'trial' | 'accepted' | 'reverted' | 'superseded'; proposedAt: string; decidedAt: string | null; reason: string | null;
}

const CLOSED = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u;

export class SQLiteSkills {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureSkillSchema(database);
  }

  all(scopeKey: string, options: { includeRetired?: boolean } = {}): StoredSkill[] {
    const rows = this.database.prepare(`SELECT * FROM shannon_skills WHERE scope_key = ? ${options.includeRetired ? '' : "AND status != 'retired'"} ORDER BY created_at, skill_id`).all(scopeKey) as Array<Record<string, unknown>>;
    return rows.map(parsed);
  }

  scopes(): string[] {
    return (this.database.prepare('SELECT DISTINCT scope_key FROM shannon_skills').all() as Array<{ scope_key: string }>).map(row => row.scope_key);
  }

  get(scopeKey: string, skillId: string): StoredSkill | null {
    const row = this.database.prepare('SELECT * FROM shannon_skills WHERE scope_key = ? AND skill_id = ?').get(scopeKey, skillId) as Record<string, unknown> | undefined;
    return row ? parsed(row) : null;
  }

  /** The skill whose copy a document of Aether is (any status), or null. */
  byCopy(scopeKey: string, documentId: string): string | null {
    const row = this.database.prepare('SELECT skill_id FROM shannon_skills WHERE scope_key = ? AND aether_document_id = ? LIMIT 1').get(scopeKey, documentId) as { skill_id: string } | undefined;
    return row?.skill_id ?? null;
  }

  /** The copy is gone (she deleted it): the skill keeps no pointer, so the next export may create one again. */
  clearExport(scopeKey: string, skillId: string): void {
    this.database.prepare('UPDATE shannon_skills SET aether_document_id = NULL, aether_version = NULL, exported_hash = NULL, exported_at = NULL, export_hold = NULL WHERE scope_key = ? AND skill_id = ?')
      .run(scopeKey, skillId);
  }

  byName(scopeKey: string, name: string): StoredSkill | null {
    const row = this.database.prepare("SELECT * FROM shannon_skills WHERE scope_key = ? AND name = ? AND status != 'retired' ORDER BY created_at DESC LIMIT 1").get(scopeKey, name) as Record<string, unknown> | undefined;
    return row ? parsed(row) : null;
  }

  /** A new skill, on trial. */
  insert(skill: Pick<StoredSkill, 'skillId' | 'scopeKey' | 'name' | 'description' | 'body' | 'bodyHash' | 'sources' | 'purposePatternIds' | 'trialAuditId'>,
    provenance: { actor: SkillActor; evidence: readonly string[] }, reason: string, at: string): void {
    identifier(skill.skillId);
    symbol(reason);
    this.database.prepare(`INSERT INTO shannon_skills (skill_id, scope_key, name, description, status, version, body, body_hash, made_by, sources_json, purpose_pattern_ids_json, trial_audit_id, created_at, updated_at, status_at)
      VALUES (?, ?, ?, ?, 'trial', 1, ?, ?, 'sleep', ?, ?, ?, ?, ?, ?)`).run(skill.skillId, skill.scopeKey, skill.name, skill.description, skill.body, skill.bodyHash,
      JSON.stringify(skill.sources), JSON.stringify(skill.purposePatternIds), skill.trialAuditId, at, at, at);
    this.revision({ scopeKey: skill.scopeKey, skillId: skill.skillId, version: 1, kind: 'version', body: skill.body, bodyHash: skill.bodyHash, madeBy: 'sleep',
      actor: provenance.actor, evidence: provenance.evidence, before: null, pinned: false, reason }, at);
  }

  /** A new version; false when the version moved since it was read (another writer). */
  update(scopeKey: string, skillId: string, expectedVersion: number, next: {
    name: string; description: string; body: string; bodyHash: string; madeBy: 'sleep' | 'owner_edit'; sources?: readonly string[]; purposePatternIds?: readonly string[];
    /** The trial this version starts (`{ base, audit }`), or null to end any trial. */ trial: { base: number | null; audit: string } | null;
    actor: SkillActor; evidence: readonly string[];
    /** ADR-0008 §14: the version it was derived from (default: the current one), or the one it restores. */ lineage?: { parent?: string; restores?: string };
  }, reason: string, at: string, status?: SkillStatus): boolean {
    symbol(reason);
    const before = this.get(scopeKey, skillId);
    if (!before || before.version !== expectedVersion) return false;
    const changed = Number(this.database.prepare(`UPDATE shannon_skills SET name = ?, description = ?, body = ?, body_hash = ?, made_by = ?, version = version + 1, updated_at = ?,
      trial_base_version = ?, trial_audit_id = ?
      ${next.sources ? ', sources_json = ?' : ''} ${next.purposePatternIds ? ', purpose_pattern_ids_json = ?' : ''} ${status ? ', status = ?, status_at = ?, status_reason = ?' : ''}
      WHERE scope_key = ? AND skill_id = ? AND version = ?`).run(next.name, next.description, next.body, next.bodyHash, next.madeBy, at,
      next.trial?.base ?? null, next.trial?.audit ?? null,
      ...(next.sources ? [JSON.stringify(next.sources)] : []), ...(next.purposePatternIds ? [JSON.stringify(next.purposePatternIds)] : []),
      ...(status ? [status, at, reason] : []), scopeKey, skillId, expectedVersion).changes);
    if (changed) {
      const restores = next.lineage?.restores ? this.node(next.lineage.restores) : null;
      this.revision({ scopeKey, skillId, version: expectedVersion + 1, kind: 'version', body: next.body, bodyHash: next.bodyHash, madeBy: next.madeBy,
        actor: next.actor, evidence: next.evidence, before: before.body, pinned: before.pinned, reason,
        parent: restores ?? next.lineage?.parent ?? this.node(versionRevisionId(skillId, expectedVersion)), variantOf: restores }, at);
    }
    return changed > 0;
  }

  /** A safety snapshot of a skill's current state (taken before a rollback); throws when it cannot be written. */
  snapshot(scopeKey: string, skillId: string, actor: SkillActor, reason: string, at: string): void {
    symbol(reason);
    const current = this.get(scopeKey, skillId);
    if (!current) throw new Error('SKILL_NOT_FOUND');
    this.revision({ scopeKey, skillId, version: current.version, kind: 'snapshot', body: current.body, bodyHash: current.bodyHash, madeBy: current.madeBy,
      actor, evidence: [], before: current.body, pinned: current.pinned, reason }, at);
  }

  /** Pinned by the owner (or unpinned): the sleep never writes to a pinned skill. */
  setPinned(scopeKey: string, skillId: string, pinned: boolean): boolean {
    return Number(this.database.prepare('UPDATE shannon_skills SET pinned = ? WHERE scope_key = ? AND skill_id = ?').run(pinned ? 1 : 0, scopeKey, skillId).changes) > 0;
  }

  /** A status change (a trial accepted, a retirement); ends any trial. */
  setStatus(scopeKey: string, skillId: string, status: SkillStatus, reason: string, at: string): boolean {
    symbol(reason);
    return Number(this.database.prepare('UPDATE shannon_skills SET status = ?, status_at = ?, status_reason = ?, trial_base_version = NULL, trial_audit_id = NULL WHERE scope_key = ? AND skill_id = ? AND status != ?')
      .run(status, at, reason, scopeKey, skillId, status).changes) > 0;
  }

  setUses(scopeKey: string, skillId: string, uses: readonly SkillUse[], successes: number): void {
    for (const use of uses) {
      identifier(use.id);
      identifier(use.talk);
      if (!Number.isFinite(Date.parse(use.at)) || !(use.g >= 0 && use.g <= 1) || ![0, 1, null].includes(use.o) || !Number.isSafeInteger(use.v)) throw new Error('SKILL_USE');
    }
    this.database.prepare('UPDATE shannon_skills SET uses_json = ?, successes = ? WHERE scope_key = ? AND skill_id = ?')
      .run(JSON.stringify(uses), Math.max(0, Math.trunc(successes)), scopeKey, skillId);
  }

  /** Where its readable copy is now and what was written there (step 7). */
  setExport(scopeKey: string, skillId: string, copy: { documentId: string; version: number; hash: string }, at: string): void {
    this.database.prepare('UPDATE shannon_skills SET aether_document_id = ?, aether_version = ?, exported_hash = ?, exported_at = ?, export_hold = NULL WHERE scope_key = ? AND skill_id = ?')
      .run(copy.documentId, copy.version, copy.hash, at, scopeKey, skillId);
  }

  setExportHold(scopeKey: string, skillId: string, hold: string | null): void {
    if (hold !== null) symbol(hold);
    this.database.prepare('UPDATE shannon_skills SET export_hold = ? WHERE scope_key = ? AND skill_id = ?').run(hold, scopeKey, skillId);
  }

  /** The node a version belongs to: itself, or the version it restores. */
  node(revisionId: string): string {
    const row = this.database.prepare('SELECT variant_of FROM shannon_skill_revisions WHERE revision_id = ?').get(revisionId) as { variant_of: string | null } | undefined;
    return row?.variant_of ?? revisionId;
  }

  /** ADR-0008 §14: one settled use of a version, counted on its node. */
  tally(skillId: string, version: number, outcome: 0 | 1): void {
    this.database.prepare('UPDATE shannon_skill_revisions SET uses = uses + 1, successes = successes + ? WHERE revision_id = ?')
      .run(outcome, this.node(versionRevisionId(skillId, version)));
  }

  revisions(scopeKey: string, skillId?: string): SkillRevision[] {
    const rows = (skillId
      ? this.database.prepare('SELECT * FROM shannon_skill_revisions WHERE scope_key = ? AND skill_id = ? ORDER BY version, created_at, kind DESC').all(scopeKey, skillId)
      : this.database.prepare('SELECT * FROM shannon_skill_revisions WHERE scope_key = ? ORDER BY created_at, version').all(scopeKey)) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      revisionId: String(row.revision_id), skillId: String(row.skill_id), version: Number(row.version), kind: String(row.kind) as 'version' | 'snapshot', body: String(row.body),
      bodyHash: String(row.body_hash), madeBy: String(row.made_by) as 'sleep' | 'owner_edit', actor: String(row.actor) as SkillActor, evidence: list<string[]>(row.evidence_json, []),
      beforeSha256: text(row.before_sha256), afterSha256: String(row.after_sha256), pinned: Number(row.pinned) === 1, reason: String(row.reason), createdAt: String(row.created_at),
      parentRevisionId: text(row.parent_revision_id), variantOf: text(row.variant_of), uses: Number(row.uses ?? 0), successes: Number(row.successes ?? 0),
    }));
  }

  /** Changes the sleep proposed since an instant, split into new skills and patches (the nightly limits). */
  proposedSince(scopeKey: string, since: string): { created: number; updated: number } {
    const row = this.database.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'create' THEN 1 ELSE 0 END), 0) AS created, COALESCE(SUM(CASE WHEN kind = 'patch' THEN 1 ELSE 0 END), 0) AS updated
      FROM shannon_skill_audit WHERE scope_key = ? AND proposed_at >= ?`).get(scopeKey, since) as { created: number; updated: number };
    return { created: Number(row.created), updated: Number(row.updated) };
  }

  // The audit.

  insertAudit(entry: Omit<SkillAuditEntry, 'trialUses' | 'trialSuccesses' | 'status' | 'decidedAt' | 'reason' | 'kind'> & { kind: SkillAuditEntry['kind'] }): void {
    identifier(entry.auditId);
    for (const code of entry.lint) symbol(code);
    this.database.prepare(`INSERT INTO shannon_skill_audit (audit_id, scope_key, skill_id, target, kind, from_version, to_version, proposal_hash, diff, purpose_pattern_ids_json, baseline_rate, lint_json, status, proposed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'trial', ?)`).run(entry.auditId, entry.scopeKey, entry.skillId, entry.target, entry.kind, entry.fromVersion, entry.toVersion,
      entry.proposalHash, entry.diff, JSON.stringify(entry.purposePatternIds), entry.baselineRate, JSON.stringify(entry.lint), entry.proposedAt);
  }

  decideAudit(scopeKey: string, auditId: string, status: 'accepted' | 'reverted' | 'superseded', measured: { uses: number; successes: number }, reason: string, at: string): void {
    symbol(reason);
    this.database.prepare("UPDATE shannon_skill_audit SET status = ?, trial_uses = ?, trial_successes = ?, reason = ?, decided_at = ? WHERE scope_key = ? AND audit_id = ? AND status = 'trial'")
      .run(status, measured.uses, measured.successes, reason, at, scopeKey, auditId);
  }

  audits(scopeKey: string): SkillAuditEntry[] {
    return (this.database.prepare('SELECT * FROM shannon_skill_audit WHERE scope_key = ? ORDER BY proposed_at, audit_id').all(scopeKey) as Array<Record<string, unknown>>).map(row => ({
      auditId: String(row.audit_id), scopeKey: String(row.scope_key), skillId: String(row.skill_id), target: String(row.target), kind: String(row.kind) as SkillAuditEntry['kind'],
      fromVersion: nullableNumber(row.from_version), toVersion: Number(row.to_version), proposalHash: String(row.proposal_hash), diff: String(row.diff),
      purposePatternIds: list<string[]>(row.purpose_pattern_ids_json, []), baselineRate: nullableNumber(row.baseline_rate), lint: list<string[]>(row.lint_json, []), trialUses: Number(row.trial_uses), trialSuccesses: Number(row.trial_successes),
      status: String(row.status) as SkillAuditEntry['status'], proposedAt: String(row.proposed_at), decidedAt: text(row.decided_at), reason: text(row.reason),
    }));
  }

  // The pattern wiki.

  patterns(scopeKey: string, options: { includeDeprecated?: boolean } = {}): StoredPattern[] {
    return (this.database.prepare(`SELECT * FROM shannon_skill_patterns WHERE scope_key = ? ${options.includeDeprecated ? '' : "AND status = 'active'"} ORDER BY created_at, pattern_id`).all(scopeKey) as Array<Record<string, unknown>>)
      .map(parsedPattern);
  }

  pattern(scopeKey: string, patternId: string): StoredPattern | null {
    const row = this.database.prepare('SELECT * FROM shannon_skill_patterns WHERE scope_key = ? AND pattern_id = ?').get(scopeKey, patternId) as Record<string, unknown> | undefined;
    return row ? parsedPattern(row) : null;
  }

  insertPattern(pattern: Pick<StoredPattern, 'patternId' | 'scopeKey' | 'kind' | 'title' | 'body' | 'sources'>, at: string): void {
    identifier(pattern.patternId);
    this.database.prepare(`INSERT INTO shannon_skill_patterns (pattern_id, scope_key, kind, title, body, status, version, sources_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`).run(pattern.patternId, pattern.scopeKey, pattern.kind, pattern.title, pattern.body, JSON.stringify(pattern.sources), at, at);
    this.log(pattern.scopeKey, pattern.patternId, 1, 'create', pattern.body, null, at);
  }

  /** A new version of a page (patched or appended); false when it moved since it was read. */
  updatePattern(scopeKey: string, patternId: string, expectedVersion: number, next: { title: string; body: string; sources: readonly string[] }, operation: 'patch' | 'append' | 'merge', relatedId: string | null, at: string): boolean {
    const changed = Number(this.database.prepare(`UPDATE shannon_skill_patterns SET title = ?, body = ?, sources_json = ?, version = version + 1, updated_at = ?
      WHERE scope_key = ? AND pattern_id = ? AND version = ? AND status = 'active'`).run(next.title, next.body, JSON.stringify(next.sources), at, scopeKey, patternId, expectedVersion).changes);
    if (changed) this.log(scopeKey, patternId, expectedVersion + 1, operation, next.body, relatedId, at);
    return changed > 0;
  }

  deprecatePattern(scopeKey: string, patternId: string, supersededBy: string | null, at: string): boolean {
    const current = this.pattern(scopeKey, patternId);
    if (!current || current.status !== 'active') return false;
    this.database.prepare("UPDATE shannon_skill_patterns SET status = 'deprecated', superseded_by = ?, updated_at = ? WHERE scope_key = ? AND pattern_id = ?").run(supersededBy, at, scopeKey, patternId);
    this.log(scopeKey, patternId, current.version, 'deprecate', current.body, supersededBy, at);
    return true;
  }

  patternLog(scopeKey: string, patternId?: string): PatternLogEntry[] {
    const rows = (patternId
      ? this.database.prepare('SELECT * FROM shannon_skill_pattern_log WHERE scope_key = ? AND pattern_id = ? ORDER BY at, version').all(scopeKey, patternId)
      : this.database.prepare('SELECT * FROM shannon_skill_pattern_log WHERE scope_key = ? ORDER BY at, version').all(scopeKey)) as Array<Record<string, unknown>>;
    return rows.map(row => ({ logId: String(row.log_id), patternId: String(row.pattern_id), version: Number(row.version), operation: String(row.operation) as PatternLogEntry['operation'],
      body: String(row.body), relatedId: text(row.related_id), at: String(row.at) }));
  }

  /** Pattern operations since an instant (the maintainer's nightly limit). */
  patternOperationsSince(scopeKey: string, since: string): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS n FROM shannon_skill_pattern_log WHERE scope_key = ? AND at >= ?').get(scopeKey, since) as { n: number }).n);
  }

  private log(scopeKey: string, patternId: string, version: number, operation: PatternLogEntry['operation'], body: string, relatedId: string | null, at: string): void {
    const count = Number((this.database.prepare('SELECT COUNT(*) AS n FROM shannon_skill_pattern_log WHERE pattern_id = ?').get(patternId) as { n: number }).n);
    this.database.prepare('INSERT INTO shannon_skill_pattern_log (log_id, pattern_id, scope_key, version, operation, body, related_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`${patternId}:${count + 1}`, patternId, scopeKey, version, operation, body, relatedId, at);
  }

  private revision(entry: { scopeKey: string; skillId: string; version: number; kind: 'version' | 'snapshot'; body: string; bodyHash: string; madeBy: 'sleep' | 'owner_edit';
    actor: SkillActor; evidence: readonly string[]; before: string | null; pinned: boolean; reason: string; parent?: string | null; variantOf?: string | null }, at: string): void {
    // Provenance of the revision (what this change cited); the skill's own `sources` hold every source for the checks (N1).
    const evidence = [...new Set(entry.evidence)].filter(id => /^[A-Za-z][A-Za-z0-9_.:>-]{0,160}$/u.test(id));
    const snapshots = entry.kind === 'snapshot'
      ? Number((this.database.prepare("SELECT COUNT(*) AS n FROM shannon_skill_revisions WHERE skill_id = ? AND kind = 'snapshot'").get(entry.skillId) as { n: number }).n) : 0;
    this.database.prepare(`INSERT INTO shannon_skill_revisions (revision_id, skill_id, scope_key, version, kind, body, body_hash, made_by, actor, evidence_json, before_sha256, after_sha256, pinned, reason, created_at, parent_revision_id, variant_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.kind === 'snapshot' ? `${entry.skillId}:s${snapshots + 1}` : versionRevisionId(entry.skillId, entry.version),
      entry.skillId, entry.scopeKey, entry.version, entry.kind, entry.body, entry.bodyHash, entry.madeBy, entry.actor, JSON.stringify(evidence),
      entry.before === null ? null : sha256(entry.before), sha256(entry.body), entry.pinned ? 1 : 0, entry.reason, at, entry.parent ?? null, entry.variantOf ?? null);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function symbol(value: string): void {
  if (!CLOSED.test(value)) throw new Error('SKILL_SYMBOL');
}

function identifier(value: string): void {
  if (!IDENTIFIER.test(value)) throw new Error('SKILL_IDENTIFIER');
}

function list<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parsed(row: Record<string, unknown>): StoredSkill {
  return {
    skillId: String(row.skill_id), scopeKey: String(row.scope_key), name: String(row.name), description: String(row.description),
    status: String(row.status) as SkillStatus, version: Number(row.version), body: String(row.body), bodyHash: String(row.body_hash),
    madeBy: String(row.made_by) as 'sleep' | 'owner_edit', sources: list<string[]>(row.sources_json, []), purposePatternIds: list<string[]>(row.purpose_pattern_ids_json, []),
    trialBaseVersion: nullableNumber(row.trial_base_version), trialAuditId: text(row.trial_audit_id), pinned: Number(row.pinned ?? 0) === 1, successes: Number(row.successes ?? 0),
    uses: list<SkillUse[]>(row.uses_json, []), createdAt: String(row.created_at), updatedAt: String(row.updated_at), statusAt: String(row.status_at),
    statusReason: text(row.status_reason), aetherDocumentId: text(row.aether_document_id), aetherVersion: nullableNumber(row.aether_version),
    exportedHash: text(row.exported_hash), exportedAt: text(row.exported_at), exportHold: text(row.export_hold),
  };
}

function parsedPattern(row: Record<string, unknown>): StoredPattern {
  return {
    patternId: String(row.pattern_id), scopeKey: String(row.scope_key), kind: String(row.kind) as 'failure' | 'strategy', title: String(row.title), body: String(row.body),
    status: String(row.status) as 'active' | 'deprecated', supersededBy: text(row.superseded_by), version: Number(row.version), sources: list<string[]>(row.sources_json, []),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}
