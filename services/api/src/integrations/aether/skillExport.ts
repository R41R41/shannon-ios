import { skillHash, type SkillBodyCheck, type SkillMemory } from '../../mind/memory/memoryPorts.js';
import { AETHER_LIMITS, aetherErrorCode, aetherIdempotencyKey, type AetherAccess } from './aetherAccess.js';

/**
 * Readable copies of her skills in Aether's 「シャノン用フォルダ」 (Syzygy ADR-0008 stage 2, step 7; owner answers I-4 「全部置く」 and
 * I-5; `docs/skill-and-routing-contract.md`). Core: memory. Runs in the worker after the skill sleep, for the one scope whose
 * study lives in Aether, through the existing folder API (`syzygy.aether-shannon-access.v1`).
 *
 * - **Every skill** gets a copy (retired ones keep theirs): the document 「スキル「name」」 whose body is the SKILL.md as stored.
 *   What the owner called 内緒 is never in it: every body was checked when it was built (`SkillMemory`). Pattern pages are not
 *   exported.
 * - **Idempotent by hash.** A copy is written only when the body changed since it was last written (`exported_hash`), with an
 *   idempotency key made of the skill, the body's hash and the version it builds on, so a retry never writes twice.
 * - **The owner's edits are his.** When a copy's Aether version is not the one she last wrote, the owner (or someone through
 *   Aether) changed it: she reads it and adopts it as a new version of the skill (`adoptOwnerEdit`), and never writes over it.
 *   An edit that cannot be adopted (it carries what must never enter a skill, or an injection) is held: the copy is left as he
 *   wrote it, and she writes nothing to it again. A copy he deleted is not written again (`owner_deleted`). An update answered
 *   `STALE_VERSION` (he edited it just now) writes nothing; the next sleep adopts it.
 * - A failure is counted by its code and never fails the sleep.
 */
export interface SkillExportResult {
  status: 'done' | 'unavailable';
  created: number; updated: number; unchanged: number; adopted: number; held: number; deleted: number; failed: number;
}

export const SKILL_COPY_PREFIX = 'スキル';

export function skillCopyTitle(name: string): string {
  return `${SKILL_COPY_PREFIX}「${name}」`;
}

export async function exportSkills(input: {
  scopeKey: string; skills: SkillMemory; access: AetherAccess; check: () => SkillBodyCheck | null; at: string; signal?: AbortSignal; log?: (line: string) => void;
}): Promise<SkillExportResult> {
  const result: SkillExportResult = { status: 'done', created: 0, updated: 0, unchanged: 0, adopted: 0, held: 0, deleted: 0, failed: 0 };
  const log = input.log ?? (line => console.log(line));
  if (!input.skills.ready()) return { ...result, status: 'unavailable' };
  let listed;
  try { listed = new Map((await input.access.list(input.signal)).map(entry => [entry.documentId, entry])); } catch (error) {
    log(`Shannon skill export: status=unavailable code=${aetherErrorCode(error)}`);
    return { ...result, status: 'unavailable' };
  }
  let check: SkillBodyCheck | null | undefined;
  const checkNow = () => {
    if (check === undefined) { try { check = input.check(); } catch { check = null; } }
    return check;
  };
  for (const skill of input.skills.store.all(input.scopeKey, { includeRetired: true })) {
    try {
      if (skill.exportHold === 'owner_deleted') continue;
      if (skill.aetherDocumentId) {
        const entry = listed.get(skill.aetherDocumentId);
        if (!entry) {
          input.skills.holdExport(input.scopeKey, skill.skillId, 'owner_deleted', input.at);
          result.deleted += 1;
          continue;
        }
        if (entry.version !== skill.aetherVersion) {
          // Changed in Aether since she wrote it: his edit, adopted at this sleep, never written over.
          const document = await input.access.read({ documentId: entry.documentId, offset: 0, maxChars: AETHER_LIMITS.readCharacters }, input.signal);
          const adopted = document.hasMore ? 'held' : input.skills.adoptOwnerEdit(input.scopeKey, skill.skillId, document.body, { documentId: entry.documentId, version: entry.version }, checkNow(), input.at);
          if (document.hasMore) input.skills.holdExport(input.scopeKey, skill.skillId, 'owner_edit_unadopted', input.at);
          if (adopted === 'adopted') result.adopted += 1;
          else if (adopted === 'held') result.held += 1;
          else result.unchanged += 1;
          continue;
        }
        if (skill.exportHold === 'owner_edit_unadopted' || skill.exportedHash === skill.bodyHash) { result.unchanged += 1; continue; }
        try {
          const written = await input.access.update({ documentId: entry.documentId, baseVersion: entry.version, body: skill.body,
            idempotencyKey: aetherIdempotencyKey('skill-copy', input.scopeKey, skill.skillId, skill.bodyHash, String(entry.version)) }, input.signal);
          input.skills.exported(input.scopeKey, skill.skillId, { documentId: written.documentId, version: written.version, hash: skillHash(skill.body) }, input.at);
          result.updated += 1;
        } catch (error) {
          // He changed it a moment ago: nothing is written; the next sleep adopts his edit.
          if (aetherErrorCode(error) === 'STALE_VERSION') result.unchanged += 1; else throw error;
        }
        continue;
      }
      const written = await input.access.create({ title: skillCopyTitle(skill.name), body: skill.body,
        idempotencyKey: aetherIdempotencyKey('skill-copy', input.scopeKey, skill.skillId, skill.bodyHash) }, input.signal);
      input.skills.exported(input.scopeKey, skill.skillId, { documentId: written.documentId, version: written.version, hash: skillHash(skill.body) }, input.at);
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      log(`Shannon skill export: failed code=${aetherErrorCode(error)}`);
    }
  }
  log(`Shannon skill export: status=done created=${result.created} updated=${result.updated} unchanged=${result.unchanged} adopted=${result.adopted} held=${result.held} deleted=${result.deleted} failed=${result.failed}`);
  return result;
}
