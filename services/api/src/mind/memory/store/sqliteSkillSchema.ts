import type { DatabaseSync } from 'node:sqlite';
import { ensureColumns } from '../../../infra/sqlite/schemaColumns.js';
import { ensureSkillSleepUsageSchema } from './sqliteSkillSleepUsage.js';
import { ensureSkillImportSchema } from './sqliteSkillImports.js';

/** Restart-safe schema for skills, lineage, audit, copies and explicit operator imports. */
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
      made_by TEXT NOT NULL CHECK (made_by IN ('sleep', 'owner_edit', 'operator_authored')),
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
      made_by TEXT NOT NULL CHECK (made_by IN ('sleep', 'owner_edit', 'operator_authored')),
      actor TEXT NOT NULL CHECK (actor IN ('sleep', 'conversation', 'owner', 'shannon_copy', 'operator_authored')),
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
  ensureSkillImportSchema(database);
  ensureSkillSleepUsageSchema(database);
  // ADR-0008 §14's lineage columns, added when the table already existed without them.
  ensureColumns(database, 'shannon_skill_revisions', { parent_revision_id: 'TEXT', variant_of: 'TEXT', uses: 'INTEGER NOT NULL DEFAULT 0', successes: 'INTEGER NOT NULL DEFAULT 0' });
}

