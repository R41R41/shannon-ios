import { createHash } from 'node:crypto';
import type { SkillBodyCheck, SkillMemory } from './skillMemory.js';
import { checkedSkillText } from './skillMemoryParts.js';
import { lineDiff, SKILL_CAPACITY, skillHash, skillLint } from './skillDocument.js';
import { versionRevisionId } from './skillLineage.js';
import type { OperatorSkillProvenance, SkillImportPlan, SkillImportReceipt, SkillPack } from './skillImportContract.js';

export const skillArtifactSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const symbol = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

export interface SkillImportDependencies {
  memory: SkillMemory;
  ownerScopeKey: string;
  /** The same current disclosure/forget/secret check as build, edit and export, never a caller-supplied bypass. */
  check(scopeKey: string): SkillBodyCheck | null;
  /** Current registry names and intended surface checks. Return closed problem codes; unavailable fails closed. */
  tools(scopeKey: string, tools: readonly string[], body: string, conditionalTools: readonly string[]): readonly string[] | null;
}

/** Owner-authored adoption of operator procedures. No model calls, tool execution, new authority, or synthetic experience. */
export class SkillImporter {
  constructor(private readonly dependencies: SkillImportDependencies) {}

  dryRun(scopeKey: string, pack: SkillPack): SkillImportPlan {
    if (scopeKey !== this.dependencies.ownerScopeKey) throw new Error('SKILL_IMPORT_OWNER_ONLY');
    const { memory } = this.dependencies;
    const packSha256 = skillArtifactSha256(JSON.stringify(pack));
    const receiptId = `import_${skillArtifactSha256(`${scopeKey}\n${packSha256}`).slice(0, 40)}`;
    const problems: { name: string | null; code: string }[] = [];
    const bad = (name: string | null, code: string) => problems.push({ name, code });
    if (!memory.ready()) bad(null, 'unavailable');
    if (pack.schemaVersion !== 1 || !symbol.test(pack.packId) || !symbol.test(pack.revision)
      || !symbol.test(pack.validatorRevision) || !/^[a-f0-9]{7,64}$/u.test(pack.referenceRevision)
      || !pack.sourceAuthor.trim() || pack.sourceAuthor.length > 200 || !pack.sourceReference.trim() || pack.sourceReference.length > 500
      || !pack.skills.length || pack.skills.length > SKILL_CAPACITY) bad(null, 'invalid_pack');
    const existingReceipt = memory.ready() ? memory.store.importReceipt(scopeKey, receiptId) : null;
    const all = memory.ready() ? memory.store.all(scopeKey, { includeRetired: true }) : [];
    const sameRevision = all.some(skill => skill.provenance?.packId === pack.packId && skill.provenance.packRevision === pack.revision && skill.provenance.importReceiptId !== receiptId);
    if (sameRevision) bad(null, 'pack_revision_conflict');
    let check: SkillBodyCheck | null = null;
    try { check = this.dependencies.check(scopeKey); } catch { /* unavailable fails closed below */ }
    const names = new Set<string>();
    const skills = pack.skills.map(entry => {
      if (names.has(entry.name)) bad(entry.name, 'duplicate_name');
      names.add(entry.name);
      if (!sha256.test(entry.sha256) || skillArtifactSha256(entry.body) !== entry.sha256) bad(entry.name, 'hash_mismatch');
      const checked = checkedSkillText(entry.body, check);
      if (typeof checked === 'string') bad(entry.name, checked === 'unavailable' ? 'check_unavailable' : 'unsafe_body');
      else if (checked.ok.name !== entry.name) bad(entry.name, 'name_mismatch');
      const lint = skillLint(entry.body);
      for (const code of lint) bad(entry.name, `lint_${code}`);
      let toolProblems: readonly string[] | null = null;
      try { toolProblems = this.dependencies.tools(scopeKey, entry.tools, entry.body, entry.conditionalTools ?? []); } catch { /* unavailable fails closed */ }
      if (toolProblems === null) bad(entry.name, 'tools_unavailable');
      else for (const code of toolProblems) bad(entry.name, code);
      const occupied = all.find(skill => skill.name === entry.name);
      if (occupied && !existingReceipt?.skills.some(item => item.skillId === occupied.skillId)) bad(entry.name, occupied.pinned ? 'pinned' : occupied.madeBy === 'owner_edit' ? 'owner_edited' : occupied.status === 'trial' ? 'on_trial' : 'name_taken');
      return { name: entry.name, sha256: entry.sha256, body: entry.body, lint, tools: [...entry.tools], conditionalTools: [...(entry.conditionalTools ?? [])] };
    });
    const capacity = { used: all.filter(skill => skill.status !== 'retired').length, added: existingReceipt ? 0 : pack.skills.length, limit: SKILL_CAPACITY };
    if (capacity.used + capacity.added > SKILL_CAPACITY) bad(null, 'over_capacity');
    // The exact reviewed content and collision state are fixed; no use counters or generated timestamps change the plan.
    const state = all.map(skill => ({ id: skill.skillId, name: skill.name, version: skill.version, hash: skill.bodyHash, pinned: skill.pinned, madeBy: skill.madeBy, status: skill.status, hold: skill.exportHold }));
    const planHash = skillArtifactSha256(JSON.stringify({ scopeKey, packSha256, state, capacity, problems }));
    return { packId: pack.packId, packRevision: pack.revision, packSha256, receiptId, planHash, capacity, skills, problems, existingReceipt };
  }

  apply(scopeKey: string, pack: SkillPack, command: { planHash: string; approvalReference: string }, at: string)
    : { receipt: SkillImportReceipt; idempotent: boolean } | { rejected: string; plan?: SkillImportPlan } {
    if (scopeKey !== this.dependencies.ownerScopeKey) return { rejected: 'owner_only' };
    if (!sha256.test(command.planHash) || !symbol.test(command.approvalReference) || !Number.isFinite(Date.parse(at))) return { rejected: 'invalid_command' };
    let result: ReturnType<SkillImporter['apply']> = { rejected: 'unavailable' };
    try { this.dependencies.memory.atomic(at, () => {
      const plan = this.dryRun(scopeKey, pack);
      // A receipt is immutable even after the owner edits, pins or retires imported skills. Never repair/recreate via retry.
      if (plan.existingReceipt) { result = { receipt: plan.existingReceipt, idempotent: true }; return; }
      if (plan.problems.length) { result = { rejected: 'validation_failed', plan }; return; }
      if (plan.planHash !== command.planHash) { result = { rejected: 'stale_plan', plan }; return; }
      const receipt: SkillImportReceipt = { receiptId: plan.receiptId, scopeKey, packId: pack.packId, packRevision: pack.revision, packSha256: plan.packSha256,
        planHash: plan.planHash, approvalReference: command.approvalReference, importedAt: at, skills: [] };
      const { store } = this.dependencies.memory;
      const imported = pack.skills.map(entry => {
        const checked = checkedSkillText(entry.body, this.dependencies.check(scopeKey));
        if (typeof checked === 'string') throw new Error('SKILL_IMPORT_CHECK_CHANGED');
        const skillId = `skill_${skillArtifactSha256(`${plan.receiptId}\n${entry.name}`).slice(0, 40)}`;
        const auditId = `audit_${skillArtifactSha256(`${skillId}\nimport`).slice(0, 40)}`;
        const provenance: OperatorSkillProvenance = { origin: 'operator_authored', packId: pack.packId, packRevision: pack.revision, bodySha256: entry.sha256,
          sourceAuthor: pack.sourceAuthor, sourceReference: pack.sourceReference, referenceRevision: pack.referenceRevision, validatorRevision: pack.validatorRevision, importReceiptId: plan.receiptId };
        store.insertAudit({ auditId, scopeKey, skillId, target: `name:${entry.name}`, kind: 'create', fromVersion: null, toVersion: 1,
          proposalHash: skillHash(entry.body), diff: lineDiff('', entry.body), purposePatternIds: [], baselineRate: null, lint: skillLint(entry.body), proposedAt: at });
        store.insert({ skillId, scopeKey, name: entry.name, description: checked.ok.description, body: entry.body, bodyHash: skillHash(entry.body),
          sources: [`import:${plan.receiptId}`], purposePatternIds: [], trialAuditId: auditId }, { actor: 'operator_authored', evidence: [], operator: provenance }, 'operator_import', at);
        return { skillId, name: entry.name, bodySha256: entry.sha256, revisionId: versionRevisionId(skillId, 1) };
      });
      receipt.skills = imported;
      store.insertImportReceipt(receipt);
      result = { receipt, idempotent: false };
    }); } catch { return { rejected: 'unavailable' }; }
    return result;
  }
}
