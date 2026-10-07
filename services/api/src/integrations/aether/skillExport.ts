import { checkedSkillText, skillHash, type SkillBodyCheck, type SkillMemory } from '../../mind/memory/memoryPorts.js';
import { AETHER_LIMITS, aetherErrorCode, aetherIdempotencyKey, type AetherAccess } from './aetherAccess.js';

/**
 * Readable copies of her skills in Aether's 「シャノン用フォルダ」 (Syzygy ADR-0008 stage 2, step 7; owner answers I-4 「全部置く」 and
 * I-5; `docs/skill-and-routing-contract.md`). Core: memory. Runs in the worker after the skill sleep, for the one scope whose
 * study lives in Aether, through the existing folder API (`syzygy.aether-shannon-access.v1`).
 *
 * - **Every usable skill** gets a copy: the document 「スキル「name」」 whose body is the SKILL.md as stored. A retired skill
 *   keeps a copy it already has but never gets a new one. Pattern pages are not exported.
 * - **Checked again here, fail closed** (privacy review B2). Every body is checked when it is built, restored and adopted, and
 *   again before it is written: nothing is written while the check cannot be read. A skill whose body no longer passes, whose
 *   source was forgotten or is now 内緒 or 機微 (`sources`), or that was retired because a source was forgotten, has its copy
 *   **withdrawn**: the copy's body becomes 「（この写しは取り下げました）」 and nothing is written to it again (`withdrawn`).
 *   What the owner called 内緒 never stays in a skill or its copy.
 * - **Idempotent by hash.** A copy is written only when the body changed since it was last written (`exported_hash`), with an
 *   idempotency key made of the skill, the body's hash and the version it builds on, so a retry never writes twice.
 * - **The owner's edits are his.** When a copy's Aether version is not the one she last wrote and its body is not what she
 *   wrote (a version bump with the same body is not an edit), the owner (or someone through Aether) changed it: she reads it and adopts it as a new version of the skill (`adoptOwnerEdit`), and never writes over it.
 *   An edit that cannot be adopted (it carries what must never enter a skill, or an injection) is held: the copy is left as he
 *   wrote it, and she writes nothing to it again. A copy he deleted is not written again (`owner_deleted`). An update answered
 *   `STALE_VERSION` (he edited it just now) writes nothing; the next sleep adopts it.
 * - A failure is counted by its code and never fails the sleep.
 */
export interface SkillExportResult {
  status: 'done' | 'unavailable';
  created: number; updated: number; unchanged: number; adopted: number; held: number; deleted: number; failed: number; withdrawn: number;
}

export const SKILL_COPY_PREFIX = 'スキル';
/** The body a withdrawn copy is left with: short, neutral, nothing of the skill. */
export const WITHDRAWN_COPY_BODY = '（この写しは取り下げました）';

export function skillCopyTitle(name: string): string {
  return `${SKILL_COPY_PREFIX}「${name}」`;
}

export async function exportSkills(input: {
  scopeKey: string; skills: SkillMemory; access: AetherAccess; check: () => SkillBodyCheck | null; at: string; signal?: AbortSignal; log?: (line: string) => void;
  /** Whether a skill's sources all still pass the seed rule (`skillSourcesPass`); absent, sources are not judged. */
  sources?: () => (sources: readonly string[]) => boolean;
}): Promise<SkillExportResult> {
  const result: SkillExportResult = { status: 'done', created: 0, updated: 0, unchanged: 0, adopted: 0, held: 0, deleted: 0, failed: 0, withdrawn: 0 };
  const log = input.log ?? (line => console.log(line));
  if (!input.skills.ready()) return { ...result, status: 'unavailable' };
  // Fail closed: nothing is written, read or adopted while what must never be in a skill cannot be read.
  let check: SkillBodyCheck | null = null;
  try { check = input.check(); } catch { check = null; }
  let sourcesPass: ((sources: readonly string[]) => boolean) | null = () => true;
  try { if (input.sources) sourcesPass = input.sources(); } catch { sourcesPass = null; }
  if (!check || !sourcesPass) {
    log('Shannon skill export: status=unavailable code=check_unavailable');
    return { ...result, status: 'unavailable' };
  }
  let listed;
  try { listed = new Map((await input.access.list(input.signal)).map(entry => [entry.documentId, entry])); } catch (error) {
    log(`Shannon skill export: status=unavailable code=${aetherErrorCode(error)}`);
    return { ...result, status: 'unavailable' };
  }
  for (const skill of input.skills.store.all(input.scopeKey, { includeRetired: true })) {
    try {
      if (skill.exportHold === 'owner_deleted' || skill.exportHold === 'withdrawn') continue;
      const withdraw = (skill.status === 'retired' && skill.statusReason === 'source_forgotten') || !sourcesPass(skill.sources)
        || typeof checkedSkillText(skill.body, check) === 'string';
      if (skill.aetherDocumentId) {
        const entry = listed.get(skill.aetherDocumentId);
        if (!entry) {
          input.skills.holdExport(input.scopeKey, skill.skillId, 'owner_deleted', input.at);
          result.deleted += 1;
          continue;
        }
        if (withdraw) {
          // Whoever last wrote it, the copy is withdrawn: nothing of the skill stays readable.
          const written = await input.access.update({ documentId: entry.documentId, baseVersion: entry.version, body: WITHDRAWN_COPY_BODY,
            idempotencyKey: aetherIdempotencyKey('skill-copy-withdrawn', input.scopeKey, skill.skillId, String(entry.version)) }, input.signal);
          input.skills.exported(input.scopeKey, skill.skillId, { documentId: written.documentId, version: written.version, hash: skillHash(WITHDRAWN_COPY_BODY) }, input.at);
          input.skills.holdExport(input.scopeKey, skill.skillId, 'withdrawn', input.at);
          result.withdrawn += 1;
          continue;
        }
        if (entry.version !== skill.aetherVersion) {
          const document = await input.access.read({ documentId: entry.documentId, offset: 0, maxChars: AETHER_LIMITS.readCharacters }, input.signal);
          // A new version with the body she wrote (a move, a re-save) is not an edit: only the version is noted (review M1).
          if (!document.hasMore && skill.exportedHash !== null && skillHash(document.body) === skill.exportedHash) {
            input.skills.exported(input.scopeKey, skill.skillId, { documentId: entry.documentId, version: entry.version, hash: skill.exportedHash }, input.at);
            if (skill.exportHold) input.skills.holdExport(input.scopeKey, skill.skillId, skill.exportHold as 'owner_edit_unadopted', input.at);
            result.unchanged += 1;
            continue;
          }
          // Changed in Aether since she wrote it: his edit, adopted at this sleep, never written over.
          const adopted = document.hasMore ? 'held' : input.skills.adoptOwnerEdit(input.scopeKey, skill.skillId, document.body, { documentId: entry.documentId, version: entry.version }, check, input.at);
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
      // A retired skill, or one that may not be shown, never gets a new copy.
      if (skill.status === 'retired' || withdraw) { result.unchanged += 1; continue; }
      const written = await input.access.create({ title: skillCopyTitle(skill.name), body: skill.body,
        idempotencyKey: aetherIdempotencyKey('skill-copy', input.scopeKey, skill.skillId, skill.bodyHash) }, input.signal);
      input.skills.exported(input.scopeKey, skill.skillId, { documentId: written.documentId, version: written.version, hash: skillHash(skill.body) }, input.at);
      result.created += 1;
    } catch (error) {
      result.failed += 1;
      log(`Shannon skill export: failed code=${aetherErrorCode(error)}`);
    }
  }
  log(`Shannon skill export: status=done created=${result.created} updated=${result.updated} unchanged=${result.unchanged} adopted=${result.adopted} held=${result.held} deleted=${result.deleted} withdrawn=${result.withdrawn} failed=${result.failed}`);
  return result;
}
