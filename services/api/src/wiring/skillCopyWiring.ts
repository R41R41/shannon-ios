import { DatabaseSync } from 'node:sqlite';
import { skillRoutingSwitches } from '@shannon/learning';
// The modules themselves (wiring imports what it constructs, not a window that loads the whole memory part).
import { SkillMemory } from '../mind/memory/skillMemory.js';
import { noteCopyWrite } from '../mind/memory/skillCopies.js';

/**
 * Review M2 for her own time's process: her own `aetherFolder.update` and `.delete` of one of her skills' copies are noted as hers
 * (`noteCopyWrite`), so the export reads them as her edits (a trial revision) and never as the owner's
 * (`ShannonToolRunner.observeCopyWrites`). Over the skill tables the API process created; null while the skills are off (then she
 * has no copies). Imports nothing of the skill sleep or its models.
 */
export function configuredSkillCopies(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string | null, now: () => string,
): { noted(scopeKey: string, documentId: string, write: { kind: 'update' | 'delete'; bodyHash: string | null }): void; close(): void } | null {
  if (!skillRoutingSwitches(environment).skills || !databasePath) return null;
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000;');
  const memory = new SkillMemory({ database, createsSchema: false });
  return { noted: (scopeKey, documentId, write) => noteCopyWrite(memory, scopeKey, documentId, write, now()), close: () => { if (database.isOpen) database.close(); } };
}
