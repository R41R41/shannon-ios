import { DatabaseSync } from 'node:sqlite';
import { skillRoutingSwitches } from '@shannon/learning';
import { SkillMemory } from '../mind/memory/memoryPorts.js';

/**
 * Review M2 for her own time's process: which documents of her Aether folder are her skills' copies, so that her own
 * `aetherFolder.update` and `.delete` never touch one (`ShannonToolRunner.guardSkillCopies`). Read-only over the skill tables the
 * API process created; null while the skills are off (then she has no copies). Imports nothing of the skill sleep or its models.
 */
export function configuredSkillCopies(
  environment: Readonly<Record<string, string | undefined>>, databasePath: string | null,
): { isCopy(scopeKey: string, documentId: string): boolean; close(): void } | null {
  if (!skillRoutingSwitches(environment).skills || !databasePath) return null;
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000;');
  const memory = new SkillMemory({ database, createsSchema: false });
  return { isCopy: (scopeKey, documentId) => memory.isCopy(scopeKey, documentId), close: () => { if (database.isOpen) database.close(); } };
}
