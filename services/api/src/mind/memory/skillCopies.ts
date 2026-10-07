import { randomUUID } from 'node:crypto';
import type { SkillBodyCheck, SkillMemory, SkillRejection } from './skillMemory.js';
import { checkedSkillText, digest, iso } from './skillMemoryParts.js';

/**
 * Her own writes to her skills' copies in Aether (review M2, owner decision 「できるようにする」; `docs/skill-and-routing-contract.md`).
 * Core: memory. She may edit or delete a copy with her own folder tools. Such a write is noted (`noteCopyWrite`) with the hash
 * of the body she wrote, so the export reads it as hers (actor `shannon_copy`), never as an owner edit: only the owner's edits
 * freeze a skill against the sleep.
 */

/** Her `aetherFolder.update` or `.delete` that worked; kept only when the document is one of her skills' copies. */
export function noteCopyWrite(memory: SkillMemory, scopeKey: string, documentId: string, write: { kind: 'update' | 'delete'; bodyHash: string | null }, at: string): void {
  memory.write(at, () => {
    const skillId = memory.store.byCopy(scopeKey, documentId);
    if (skillId) memory.copyWrites.insert({ writeId: `copy_${digest(`${skillId}\n${at}\n${randomUUID()}`)}`, scopeKey, skillId, documentId, ...write, at: iso(at) });
  });
}

/**
 * Her edit of a copy, read at the next sleep: a trial revision of the skill like any proposer patch (the body check, the secret,
 * injection and credential scans, the lint, the audit, the trial and the lineage), actor `shannon_copy`; refused like a patch for
 * a pinned skill, the owner's version or one on trial.
 */
export function copyEdit(memory: SkillMemory, scopeKey: string, skillId: string, text: string, check: SkillBodyCheck | null, at: string): { version: number } | { rejected: SkillRejection } {
  const safe = checkedSkillText(text, check);
  if (safe === 'unavailable') return { rejected: 'check_unavailable' };
  if (safe === 'unsafe') return { rejected: 'secret' };
  const current = memory.store.get(scopeKey, skillId);
  if (!current) return { rejected: 'not_found' };
  return memory.revise(scopeKey, skillId, current.version, { draft: safe.ok, evidence: [] }, check, at, 'shannon_copy');
}

/** She deleted a copy: the skill stays, the audit records it, and the next export creates a copy again if the skill is active. */
export function copyDeleted(memory: SkillMemory, scopeKey: string, skillId: string, at: string): void {
  memory.write(at, () => {
    const skill = memory.store.get(scopeKey, skillId);
    if (!skill) return;
    const auditId = `audit_${digest(`${skillId}\ncopy_delete\n${randomUUID()}`)}`;
    memory.store.insertAudit({ auditId, scopeKey, skillId, target: `skill:${skillId}`, kind: 'copy_delete', fromVersion: skill.version, toVersion: skill.version,
      proposalHash: skill.bodyHash, diff: '', purposePatternIds: [], baselineRate: null, lint: [], proposedAt: at });
    memory.store.decideAudit(scopeKey, auditId, 'accepted', { uses: 0, successes: 0 }, 'copy_deleted', at);
    memory.store.clearExport(scopeKey, skillId);
    memory.copyWrites.read(scopeKey, skillId, at);
  });
}

/** Her copy writes of a skill the export has read. */
export function copyWritesRead(memory: SkillMemory, scopeKey: string, skillId: string, at: string): void {
  memory.write(at, () => { memory.copyWrites.read(scopeKey, skillId, at); });
}
