import type { DatabaseSync } from 'node:sqlite';

/**
 * Her own writes to her skills' copies (review M2; `skillCopies.ts`): `shannon_skill_copy_writes`, created with the skill tables
 * (`ensureSkillSchema`). Ids, closed kinds, a body hash and instants only. Core: memory.
 */
export interface SkillCopyWrite { writeId: string; skillId: string; documentId: string; kind: 'update' | 'delete'; bodyHash: string | null; at: string }

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u;

export class SQLiteSkillCopyWrites {
  constructor(private readonly database: DatabaseSync) {}

  insert(write: SkillCopyWrite & { scopeKey: string }): void {
    if (!IDENTIFIER.test(write.writeId)) throw new Error('SKILL_IDENTIFIER');
    this.database.prepare('INSERT OR IGNORE INTO shannon_skill_copy_writes (write_id, scope_key, skill_id, document_id, kind, body_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(write.writeId, write.scopeKey, write.skillId, write.documentId, write.kind, write.bodyHash, write.at);
  }

  /** Her writes to a skill's copy the export has not read yet, oldest first. */
  pending(scopeKey: string, skillId: string): SkillCopyWrite[] {
    return (this.database.prepare('SELECT * FROM shannon_skill_copy_writes WHERE scope_key = ? AND skill_id = ? AND processed_at IS NULL ORDER BY at, write_id').all(scopeKey, skillId) as Array<Record<string, unknown>>)
      .map(row => ({ writeId: String(row.write_id), skillId: String(row.skill_id), documentId: String(row.document_id), kind: String(row.kind) as 'update' | 'delete',
        bodyHash: row.body_hash === null || row.body_hash === undefined ? null : String(row.body_hash), at: String(row.at) }));
  }

  read(scopeKey: string, skillId: string, at: string): void {
    this.database.prepare('UPDATE shannon_skill_copy_writes SET processed_at = ? WHERE scope_key = ? AND skill_id = ? AND processed_at IS NULL').run(at, scopeKey, skillId);
  }
}
