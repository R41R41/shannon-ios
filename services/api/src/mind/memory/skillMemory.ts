import { createHash, randomUUID } from 'node:crypto';
import { looksSecret } from '@shannon/cognition';
import { tierOutcome } from '@shannon/learning';
import { LockWaitMeter, loggedFailure, ownerDayKey, tableExists, underWriteLock, type SqliteConnection } from '../../infra/sqlite/lockWaits.js';
import {
  SKILL_CAPACITY, SKILL_LIFECYCLE, applyReplacements, baselineRate, checked, encodeSkill, injectionThreats, lineDiff, parseSkill, retiresForLowSuccess, skillHash, skillIndex,
  skillLint, trialVerdict, type SkillDocument, type SkillProblem,
} from './skillDocument.js';
import { SKILLS_TABLE, SQLiteSkills, type SkillActor, type SkillUse, type StoredPattern, type StoredSkill } from './store/sqliteSkills.js';

/**
 * Her skill memory (Syzygy ADR-0008 stage 2, step 6; `docs/skill-and-routing-contract.md`, 「スキル記憶」). Core: memory.
 *
 * Three layers, after WikiSkill (coordinator, 2026-10-07): the raw experience (her turns, settled choices, tool and step outcomes)
 * lives in its own tables and is never edited here; the **pattern wiki** (failure modes and strategies, each with what to do) and
 * the **skills** are interpretations of it, and only they evolve. Nothing is deleted: a deprecated page and a retired skill stay.
 *
 * - **Read in a turn**: the index (`index`, for the profile layer) and one skill's SKILL.md (`open`, for `skill.read`). Both leave
 *   out a skill built from something the owner had her forget (`visible`), at once. Patterns are never given to a turn.
 * - **Use**: `used` notes a use of a skill's current version at the end of its turn with G; the owner's next turn in the Talk
 *   settles it (`nextTurn`, the tier-outcome rule), or 30 minutes without one settle it from G alone. Writes are deferred, under the
 *   write lock, measured; a failure is logged and swallowed, as the ledgers' are.
 * - **Night** (`mind/sleep/skillConsolidation.ts`): the maintainer edits pages (`createPattern`, `editPattern`, `mergePatterns`,
 *   `deprecatePattern`); the proposer's one change a run is `create` or `revise`, which starts a **trial** and an audit entry;
 *   `lifecycle` accepts or reverts trials and retires what keeps failing; `adoptOwnerEdit` takes the owner's edit of a copy as a
 *   new version (step 7). Every body and page passes the check it is handed before it is stored (`SkillBodyCheck`: what the owner
 *   said is 内緒 never enters a skill, ADR-0002).
 */
export const SKILL_USE_NEXT_TURN_MINUTES = 30;
/** Uses kept on a skill: the window of the lifecycle plus room for those still waiting. */
const USES_KEPT = 16;

/** What a body must not carry (`conversationSecrets` and the owner-private check, handed in by the wiring); null: could not be read. */
export interface SkillBodyCheck { carries(text: string): boolean }

export interface SkillMemoryOptions {
  database: SqliteConnection;
  createsSchema: boolean;
  defer?: (task: () => void) => void;
  log?: (line: string) => void;
}

export type SkillRejection = SkillProblem | 'secret' | 'check_unavailable' | 'name_taken' | 'stale' | 'not_found' | 'unavailable' | 'uncited' | 'copied'
  | 'over_limit' | 'no_purpose' | 'audit_reverted' | 'on_trial' | 'unchanged' | 'empty' | 'pinned' | 'owner_edited' | 'over_capacity' | 'too_young'
  | 'patch_failed' | 'snapshot_failed';

/** A skill that has never been used is not retired (consolidated away) before this many days (Hermes Agent's minimum age). */
export const SKILL_MINIMUM_AGE_DAYS = 14;

/** What the proposer hands for a new skill: the body, where it came from, the pages it is for, and skills it replaces in the same batch. */
export interface SkillCreation { draft: SkillDocument; evidence: readonly string[]; purposePatternIds?: readonly string[]; consolidates?: readonly string[] }

/** What the proposer hands for a patch: targeted replacements in the current SKILL.md (the default), or a whole new body. */
export type SkillPatch = ({ replacements: readonly { find: string; replace: string }[] } | { draft: SkillDocument }) & { evidence: readonly string[]; purposePatternIds?: readonly string[] };

export const PATTERN_LIMITS = Object.freeze({ title: 60, body: 1_500 });

export class SkillMemory {
  readonly store: SQLiteSkills;
  private readonly meter: LockWaitMeter;
  private readonly defer: (task: () => void) => void;
  private present = false;

  constructor(private readonly options: SkillMemoryOptions) {
    this.store = new SQLiteSkills(options.database, { createSchema: options.createsSchema });
    this.meter = new LockWaitMeter('skills', options.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
  }

  /** Whether the tables exist (a process that does not create them writes nothing until the API has). */
  ready(): boolean {
    if (!this.present && this.options.database.isOpen) this.present = tableExists(this.options.database, SKILLS_TABLE);
    return this.present;
  }

  /** Her skills that may be used now: not retired, and nothing they were built from forgotten. */
  usable(scopeKey: string, visible: (experienceId: string) => boolean = () => true): StoredSkill[] {
    if (!this.ready()) return [];
    try {
      return this.store.all(scopeKey).filter(skill => skill.sources.every(source => !source.startsWith('experience:') || visible(source.slice('experience:'.length))));
    } catch { return []; }
  }

  /** The index for the profile layer (`skillIndex`); empty while she has none. */
  index(scopeKey: string, visible?: (experienceId: string) => boolean): string {
    return skillIndex(this.usable(scopeKey, visible).map(skill => ({ name: skill.name, description: skill.description, status: skill.status === 'active' ? 'active' : 'trial', createdAt: skill.createdAt })));
  }

  /** One usable skill by its name. */
  open(scopeKey: string, name: string, visible?: (experienceId: string) => boolean): StoredSkill | null {
    return this.usable(scopeKey, visible).find(skill => skill.name === name) ?? null;
  }

  /** A use of a skill at the end of its turn; returns the skill's id (for the choice ledger) or null when it has none. */
  used(scopeKey: string, name: string, use: { talk: string; growth: number }, at: string): string | null {
    let skill: StoredSkill | null = null;
    try { skill = this.ready() ? this.store.byName(scopeKey, name) : null; } catch { skill = null; }
    if (!skill) return null;
    const skillId = skill.skillId;
    const version = skill.version;
    this.later(at, () => {
      const current = this.store.get(scopeKey, skillId);
      if (!current) return;
      const entry: SkillUse = { id: `use_${randomUUID().replace(/-/gu, '').slice(0, 20)}`, at: iso(at), talk: use.talk, v: version, g: Math.round(Math.min(1, Math.max(0, use.growth)) * 1e6) / 1e6, o: null };
      this.writeUses(current, [...current.uses, entry]);
    });
    return skillId;
  }

  /** The owner's next turn in a Talk, as S (null: Jev was unsure, G alone): settles the uses of the turn before. */
  nextTurn(scopeKey: string, talk: string, serve: number | null, at: string): void {
    let waiting = false;
    try { waiting = this.ready() && this.store.all(scopeKey).some(skill => skill.uses.some(use => use.o === null && use.talk === talk)); } catch { waiting = false; }
    if (!waiting) return;
    this.later(at, () => {
      for (const skill of this.store.all(scopeKey)) {
        if (!skill.uses.some(use => use.o === null && use.talk === talk)) continue;
        this.writeUses(skill, skill.uses.map(use => use.o === null && use.talk === talk && Date.parse(use.at) <= Date.parse(at) ? { ...use, o: tierOutcome(use.g, serve) } : use));
      }
    });
  }

  /** Night: uses that waited longer than their window are settled from G alone. Runs at once, under the lock. */
  settleUses(scopeKey: string, at: string): number {
    let settled = 0;
    this.now(at, () => {
      const before = Date.parse(at) - SKILL_USE_NEXT_TURN_MINUTES * 60_000;
      for (const skill of this.store.all(scopeKey)) {
        const due = skill.uses.filter(use => use.o === null && Date.parse(use.at) < before).length;
        if (!due) continue;
        settled += due;
        this.writeUses(skill, skill.uses.map(use => use.o === null && Date.parse(use.at) < before ? { ...use, o: tierOutcome(use.g, null) } : use));
      }
    });
    return settled;
  }

  /**
   * Night: trials are judged (a new skill accepted or retired, a patched version kept or reverted to the version before it, each
   * recorded in the audit), and active skills that keep failing retire.
   */
  lifecycle(scopeKey: string, at: string): { accepted: string[]; reverted: string[]; retired: string[] } {
    const result = { accepted: [] as string[], reverted: [] as string[], retired: [] as string[] };
    this.now(at, () => {
      for (const skill of this.store.all(scopeKey)) {
        const outcomes = (version?: number) => skill.uses.filter(use => use.o !== null && (version === undefined || use.v === version)).map(use => use.o as 0 | 1);
        if (skill.status === 'trial') {
          const audit = skill.trialAuditId ? this.store.audits(scopeKey).find(entry => entry.auditId === skill.trialAuditId) ?? null : null;
          const trial = outcomes(skill.version);
          const verdict = trialVerdict({ base: skill.trialBaseVersion, baseline: audit?.baselineRate ?? null, outcomes: trial });
          if (!verdict) continue;
          const measured = { uses: trial.length, successes: trial.filter(value => value === 1).length };
          if (verdict === 'accept') {
            this.store.setStatus(scopeKey, skill.skillId, 'active', 'trial_accepted', at);
            if (audit) this.store.decideAudit(scopeKey, audit.auditId, 'accepted', measured, 'trial_accepted', at);
            result.accepted.push(skill.skillId);
          } else if (skill.trialBaseVersion === null) {
            this.store.setStatus(scopeKey, skill.skillId, 'retired', 'trial_failed', at);
            if (audit) this.store.decideAudit(scopeKey, audit.auditId, 'reverted', measured, 'trial_failed', at);
            result.retired.push(skill.skillId);
          } else {
            if (this.restore(scopeKey, skill, skill.trialBaseVersion, 'sleep', [...(audit ? [`audit:${audit.auditId}`] : [])], 'reverted', at) !== 'restored') continue;
            if (audit) this.store.decideAudit(scopeKey, audit.auditId, 'reverted', measured, 'trial_worse', at);
            result.reverted.push(skill.skillId);
          }
          continue;
        }
        // The sleep never writes to the owner's version or a pinned skill, a retirement included.
        if (skill.status === 'active' && !skill.pinned && skill.madeBy !== 'owner_edit' && retiresForLowSuccess(outcomes())
          && this.store.setStatus(scopeKey, skill.skillId, 'retired', 'low_success', at)) result.retired.push(skill.skillId);
      }
    });
    return result;
  }

  /**
   * Rolls a skill back to one of its versions, as a new version (Hermes Agent's per-revision rollback): a safety snapshot of the
   * current state is written first, and if it cannot be, nothing changes (fail closed). The sleep may not roll back the owner's
   * version or a pinned skill; the owner may.
   */
  rollback(scopeKey: string, skillId: string, toVersion: number, actor: SkillActor, at: string): 'restored' | 'not_found' | 'pinned' | 'owner_edited' | 'snapshot_failed' | 'unavailable' {
    let outcome: ReturnType<SkillMemory['rollback']> = 'unavailable';
    this.now(at, () => {
      const current = this.store.get(scopeKey, skillId);
      if (!current) { outcome = 'not_found'; return; }
      if (actor === 'sleep' && current.pinned) { outcome = 'pinned'; return; }
      if (actor === 'sleep' && current.madeBy === 'owner_edit') { outcome = 'owner_edited'; return; }
      if (current.trialAuditId) this.store.decideAudit(scopeKey, current.trialAuditId, 'superseded', { uses: 0, successes: 0 }, 'rollback', at);
      outcome = this.restore(scopeKey, current, toVersion, actor, [], 'rollback', at);
    });
    return outcome;
  }

  /** Night: retires a skill for a closed reason (a source forgotten). It is kept, deprecated, not deleted. */
  retire(scopeKey: string, skillId: string, reason: string, at: string): boolean {
    let done = false;
    this.now(at, () => {
      const skill = this.store.get(scopeKey, skillId);
      if (skill?.trialAuditId) this.store.decideAudit(scopeKey, skill.trialAuditId, 'superseded', { uses: 0, successes: 0 }, reason, at);
      done = this.store.setStatus(scopeKey, skillId, 'retired', reason, at);
    });
    return done;
  }

  /**
   * Night: a new skill from the proposer, on trial, with its audit entry. Its body passes every check, the same change was not
   * reverted before (the audit), and it fits the index: if it would not, the same batch consolidates (retires the skills it
   * replaces), never the owner's, a pinned one, or one never used and younger than 14 days. `purposePatternIds` are the pages it
   * is for (its PURPOSE); only active pages are kept.
   */
  create(scopeKey: string, proposal: SkillCreation, check: SkillBodyCheck | null, at: string): { skillId: string } | { rejected: SkillRejection } {
    const body = this.checkedBody(proposal.draft, check);
    if ('rejected' in body) return body;
    let outcome: { skillId: string } | { rejected: SkillRejection } = { rejected: 'unavailable' };
    this.now(at, () => {
      if (this.store.byName(scopeKey, body.skill.name)) { outcome = { rejected: 'name_taken' }; return; }
      const purposes = this.purposes(scopeKey, proposal.purposePatternIds ?? []);
      if (this.revertedBefore(scopeKey, `name:${body.skill.name}`, skillHash(body.text), purposes)) { outcome = { rejected: 'audit_reverted' }; return; }
      const replaced = [...new Set(proposal.consolidates ?? [])].map(id => this.store.get(scopeKey, id));
      const refusal = replaced.map(skill => (!skill || skill.status === 'retired' ? 'not_found' : skill.pinned ? 'pinned' : skill.madeBy === 'owner_edit' ? 'owner_edited'
        : !skill.uses.length && Date.parse(at) - Date.parse(skill.createdAt) < SKILL_MINIMUM_AGE_DAYS * 86_400_000 ? 'too_young' : null)).find(Boolean);
      if (refusal) { outcome = { rejected: refusal as SkillRejection }; return; }
      if (this.store.all(scopeKey).length - replaced.length + 1 > SKILL_CAPACITY) { outcome = { rejected: 'over_capacity' }; return; }
      const skillId = `skill_${digest(`${scopeKey}\n${body.skill.name}\n${at}\n${randomUUID()}`)}`;
      const auditId = `audit_${digest(`${skillId}\n1\n${randomUUID()}`)}`;
      this.store.insertAudit({ auditId, scopeKey, skillId, target: `name:${body.skill.name}`, kind: 'create', fromVersion: null, toVersion: 1, proposalHash: skillHash(body.text),
        diff: lineDiff('', body.text), purposePatternIds: purposes, baselineRate: null, lint: skillLint(body.text), proposedAt: at });
      this.store.insert({ skillId, scopeKey, name: body.skill.name, description: body.skill.description, body: body.text, bodyHash: skillHash(body.text),
        sources: closedSources([...proposal.evidence, ...purposes.map(id => `pattern:${id}`)]), purposePatternIds: purposes, trialAuditId: auditId },
      { actor: 'sleep', evidence: proposal.evidence }, 'built', at);
      for (const skill of replaced) this.store.setStatus(scopeKey, skill!.skillId, 'retired', 'consolidated', at);
      outcome = { skillId };
    });
    return outcome;
  }

  /**
   * Night: a patched version from the proposer, on trial against the rate of the version before it (which a failed trial reverts
   * to). The current version is read again in the same pass and the patch applied to it (targeted replacements by default). Never
   * while the skill is on trial, never to the owner's version or a pinned skill, never a change the audit saw reverted.
   */
  revise(scopeKey: string, skillId: string, expectedVersion: number, patch: SkillPatch, check: SkillBodyCheck | null, at: string): { version: number } | { rejected: SkillRejection } {
    let outcome: { version: number } | { rejected: SkillRejection } = { rejected: 'unavailable' };
    this.now(at, () => {
      const current = this.store.get(scopeKey, skillId);
      if (!current || current.status === 'retired') { outcome = { rejected: 'not_found' }; return; }
      // Refused mechanically: the owner's own version is his (I-5), a pinned skill is fixed.
      if (current.madeBy === 'owner_edit') { outcome = { rejected: 'owner_edited' }; return; }
      if (current.pinned) { outcome = { rejected: 'pinned' }; return; }
      if (current.version !== expectedVersion) { outcome = { rejected: 'stale' }; return; }
      if (current.status === 'trial') { outcome = { rejected: 'on_trial' }; return; }
      let draft: SkillDocument;
      if ('replacements' in patch) {
        const patched = applyReplacements(current.body, patch.replacements);
        if ('problem' in patched) { outcome = { rejected: 'patch_failed' }; return; }
        const parsed = parseSkill(patched.text);
        if ('problem' in parsed) { outcome = { rejected: parsed.problem }; return; }
        draft = parsed.skill;
      } else draft = patch.draft;
      const body = this.checkedBody(draft, check);
      if ('rejected' in body) { outcome = body; return; }
      if (skillHash(body.text) === current.bodyHash) { outcome = { rejected: 'unchanged' }; return; }
      const other = this.store.byName(scopeKey, body.skill.name);
      if (other && other.skillId !== skillId) { outcome = { rejected: 'name_taken' }; return; }
      const purposes = this.purposes(scopeKey, patch.purposePatternIds ?? []);
      if (this.revertedBefore(scopeKey, `skill:${skillId}`, skillHash(body.text), purposes)) { outcome = { rejected: 'audit_reverted' }; return; }
      const baseline = baselineRate(current.uses.filter(use => use.o !== null && use.v === current.version).map(use => use.o as 0 | 1));
      const auditId = `audit_${digest(`${skillId}\n${expectedVersion + 1}\n${randomUUID()}`)}`;
      this.store.insertAudit({ auditId, scopeKey, skillId, target: `skill:${skillId}`, kind: 'patch', fromVersion: expectedVersion, toVersion: expectedVersion + 1, proposalHash: skillHash(body.text),
        diff: lineDiff(current.body, body.text), purposePatternIds: purposes, baselineRate: baseline, lint: skillLint(body.text), proposedAt: at });
      const merged = closedSources([...current.sources, ...patch.evidence, ...purposes.map(id => `pattern:${id}`)]);
      outcome = this.store.update(scopeKey, skillId, expectedVersion, {
        name: body.skill.name, description: body.skill.description, body: body.text, bodyHash: skillHash(body.text), madeBy: 'sleep', sources: merged,
        purposePatternIds: [...new Set([...current.purposePatternIds, ...purposes])], trial: { base: expectedVersion, audit: auditId }, actor: 'sleep', evidence: patch.evidence,
      }, 'patched', at, 'trial') ? { version: expectedVersion + 1 } : { rejected: 'stale' };
    });
    return outcome;
  }

  /**
   * Step 7 (owner answer I-5): the owner's edit of a copy, adopted as a new version, never overwritten. His text is taken as it
   * is; a text that is not a SKILL.md keeps the skill's name and description. A text that carries what must never enter a
   * skill (or that cannot be checked now) is not adopted: the skill keeps its version and its copy is held, never written over.
   * His version is active (a trial in progress is superseded); an adopted edit of a retired skill brings it back.
   */
  adoptOwnerEdit(scopeKey: string, skillId: string, text: string, copy: { documentId: string; version: number }, check: SkillBodyCheck | null, at: string): 'adopted' | 'held' | 'unchanged' | 'not_found' {
    let outcome: 'adopted' | 'held' | 'unchanged' | 'not_found' = 'not_found';
    this.now(at, () => {
      const current = this.store.get(scopeKey, skillId);
      if (!current) return;
      const hash = skillHash(text);
      if (hash === current.bodyHash) {
        this.store.setExport(scopeKey, skillId, { ...copy, hash }, at);
        outcome = 'unchanged';
        return;
      }
      let carries = true;
      try { carries = check === null || check.carries(text); } catch { carries = true; }
      // His text is checked like any body written into a skill: what must never enter one, and prompt injection.
      if (carries || injectionThreats(text).length > 0 || !text.trim() || text.length > 20_000) {
        this.store.setExportHold(scopeKey, skillId, 'owner_edit_unadopted');
        outcome = 'held';
        return;
      }
      const parsed = parseSkill(text);
      const name = 'skill' in parsed && !this.nameTaken(scopeKey, parsed.skill.name, skillId) ? parsed.skill.name : current.name;
      const description = 'skill' in parsed ? parsed.skill.description : current.description;
      if (current.trialAuditId) this.store.decideAudit(scopeKey, current.trialAuditId, 'superseded', { uses: 0, successes: 0 }, 'owner_edit', at);
      if (!this.store.update(scopeKey, skillId, current.version, { name, description, body: text, bodyHash: hash, madeBy: 'owner_edit', trial: null, actor: 'owner', evidence: [] }, 'owner_edit', at, 'active')) return;
      this.store.setExport(scopeKey, skillId, { ...copy, hash }, at);
      outcome = 'adopted';
    });
    return outcome;
  }

  /** Step 7: where a skill's copy in Aether is now and which body was written there. */
  exported(scopeKey: string, skillId: string, copy: { documentId: string; version: number; hash: string }, at: string): void {
    this.now(at, () => { this.store.setExport(scopeKey, skillId, copy, at); });
  }

  /** Step 7: a copy that is not written again (`owner_deleted`, `owner_edit_unadopted`). */
  holdExport(scopeKey: string, skillId: string, hold: 'owner_deleted' | 'owner_edit_unadopted', at: string): void {
    this.now(at, () => { this.store.setExportHold(scopeKey, skillId, hold); });
  }

  /** How many skill changes the sleep proposed in the owner-local day of `at`, and how many pattern edits it made (the nightly limits). */
  madeToday(scopeKey: string, at: string): { created: number; updated: number; patternEdits: number } {
    const full = { created: SKILL_LIFECYCLE.newPerNight, updated: SKILL_LIFECYCLE.updatesPerNight, patternEdits: SKILL_LIFECYCLE.patternEditsPerNight };
    try {
      if (!this.ready()) return full;
      // From the owner-local midnight of `at` (Asia/Tokyo, UTC+9 all year, the ledgers' day).
      const since = new Date(Date.parse(`${ownerDayKey(at)}T00:00:00+09:00`)).toISOString();
      return { ...this.store.proposedSince(scopeKey, since), patternEdits: this.store.patternOperationsSince(scopeKey, since) };
    } catch { return full; }
  }

  // The pattern wiki (never given to a turn; it feeds the proposer).

  /** A new page: a failure mode or a strategy with what to do about it. */
  createPattern(scopeKey: string, page: { kind: 'failure' | 'strategy'; title: string; body: string }, sources: readonly string[], check: SkillBodyCheck | null, at: string): { patternId: string } | { rejected: SkillRejection } {
    const valid = checkedPage(page.title, page.body, check);
    if ('rejected' in valid) return valid;
    let outcome: { patternId: string } | { rejected: SkillRejection } = { rejected: 'unavailable' };
    this.now(at, () => {
      const patternId = `pattern_${digest(`${scopeKey}\n${valid.title}\n${at}\n${randomUUID()}`)}`;
      this.store.insertPattern({ patternId, scopeKey, kind: page.kind, title: valid.title, body: valid.body, sources: closedSources(sources) }, at);
      outcome = { patternId };
    });
    return outcome;
  }

  /** A page patched (its text replaced) or appended to (a note added at its end). */
  editPattern(scopeKey: string, patternId: string, expectedVersion: number, edit: { operation: 'patch' | 'append'; title?: string; text: string }, sources: readonly string[], check: SkillBodyCheck | null, at: string): { version: number } | { rejected: SkillRejection } {
    let outcome: { version: number } | { rejected: SkillRejection } = { rejected: 'unavailable' };
    this.now(at, () => {
      const current = this.store.pattern(scopeKey, patternId);
      if (!current || current.status !== 'active') { outcome = { rejected: 'not_found' }; return; }
      if (current.version !== expectedVersion) { outcome = { rejected: 'stale' }; return; }
      const body = edit.operation === 'append' ? `${current.body.trim()}\n\n${edit.text.trim()}` : edit.text;
      const valid = checkedPage(edit.title ?? current.title, body, check);
      if ('rejected' in valid) { outcome = valid; return; }
      outcome = this.store.updatePattern(scopeKey, patternId, expectedVersion, { title: valid.title, body: valid.body, sources: closedSources([...current.sources, ...sources]) }, edit.operation, null, at)
        ? { version: expectedVersion + 1 } : { rejected: 'stale' };
    });
    return outcome;
  }

  /** Duplicates merged: the first page takes the merged text, the others are deprecated as superseded by it. */
  mergePatterns(scopeKey: string, into: string, from: readonly string[], merged: { title: string; body: string }, check: SkillBodyCheck | null, at: string): { version: number } | { rejected: SkillRejection } {
    const valid = checkedPage(merged.title, merged.body, check);
    if ('rejected' in valid) return valid;
    let outcome: { version: number } | { rejected: SkillRejection } = { rejected: 'unavailable' };
    this.now(at, () => {
      const target = this.store.pattern(scopeKey, into);
      const others = from.filter(id => id !== into).map(id => this.store.pattern(scopeKey, id));
      if (!target || target.status !== 'active' || !others.length || others.some(page => !page || page.status !== 'active')) { outcome = { rejected: 'not_found' }; return; }
      const pages = others as StoredPattern[];
      const sources = closedSources([...target.sources, ...pages.flatMap(page => page.sources)]);
      if (!this.store.updatePattern(scopeKey, into, target.version, { title: valid.title, body: valid.body, sources }, 'merge', pages.map(page => page.patternId).join(',').slice(0, 300), at)) { outcome = { rejected: 'stale' }; return; }
      for (const page of pages) this.store.deprecatePattern(scopeKey, page.patternId, into, at);
      outcome = { version: target.version + 1 };
    });
    return outcome;
  }

  /** A page superseded or no longer true: kept, deprecated, never deleted. */
  deprecatePattern(scopeKey: string, patternId: string, supersededBy: string | null, at: string): boolean {
    let done = false;
    this.now(at, () => { done = this.store.deprecatePattern(scopeKey, patternId, supersededBy, at); });
    return done;
  }

  patterns(scopeKey: string): StoredPattern[] {
    try { return this.ready() ? this.store.patterns(scopeKey) : []; } catch { return []; }
  }

  lockWaits() { return this.meter.summary(); }

  /** The pattern ids a proposal names that are active pages, in order, at most eight. */
  private purposes(scopeKey: string, ids: readonly string[]): string[] {
    return [...new Set(ids)].filter(id => this.store.pattern(scopeKey, id)?.status === 'active').slice(0, 8);
  }

  /** The audit: the same change (the same body, or the same target for the same patterns) was tried and reverted before. */
  private revertedBefore(scopeKey: string, target: string, proposalHash: string, purposes: readonly string[]): boolean {
    const key = [...purposes].sort().join(',');
    return this.store.audits(scopeKey).some(entry => entry.status === 'reverted'
      && (entry.proposalHash === proposalHash || (entry.target === target && key !== '' && [...entry.purposePatternIds].sort().join(',') === key)));
  }

  private nameTaken(scopeKey: string, name: string, skillId: string): boolean {
    const other = this.store.byName(scopeKey, name);
    return Boolean(other && other.skillId !== skillId);
  }

  /** A version restored as a new one, after a safety snapshot; nothing changes when the snapshot cannot be written (fail closed). */
  private restore(scopeKey: string, current: StoredSkill, toVersion: number, actor: SkillActor, evidence: readonly string[], reason: string, at: string): 'restored' | 'not_found' | 'snapshot_failed' {
    const base = this.store.revisions(scopeKey, current.skillId).find(revision => revision.kind === 'version' && revision.version === toVersion);
    if (!base) return 'not_found';
    try { this.store.snapshot(scopeKey, current.skillId, actor, 'safety_snapshot', at); } catch { return 'snapshot_failed'; }
    const parsed = parseSkill(base.body);
    return this.store.update(scopeKey, current.skillId, current.version, {
      name: 'skill' in parsed ? parsed.skill.name : current.name, description: 'skill' in parsed ? parsed.skill.description : current.description,
      body: base.body, bodyHash: base.bodyHash, madeBy: actor === 'owner' ? 'owner_edit' : base.madeBy, trial: null, actor, evidence,
    }, reason, at, 'active') ? 'restored' : 'not_found';
  }

  private checkedBody(draft: SkillDocument, check: SkillBodyCheck | null): { skill: SkillDocument; text: string } | { rejected: SkillRejection } {
    const valid = checked(draft);
    if ('problem' in valid) return { rejected: valid.problem };
    const text = encodeSkill(valid.skill);
    // What the owner said is 内緒 never enters a skill (ADR-0002, owner answer I-4): checked when the body is built, not at export.
    if (check === null) return { rejected: 'check_unavailable' };
    try { if (check.carries(text)) return { rejected: 'secret' }; } catch { return { rejected: 'check_unavailable' }; }
    return { skill: valid.skill, text };
  }

  private writeUses(skill: StoredSkill, uses: readonly SkillUse[]): void {
    const kept = [...uses.filter(use => use.o === null), ...uses.filter(use => use.o !== null).slice(-SKILL_LIFECYCLE.window)]
      .sort((left, right) => left.at.localeCompare(right.at)).slice(-USES_KEPT);
    const newlySettled = uses.filter(use => use.o === 1 && !skill.uses.some(old => old.id === use.id && old.o === 1)).length;
    this.store.setUses(skill.scopeKey, skill.skillId, kept, skill.successes + newlySettled);
  }

  private later(at: string, operation: () => void): void {
    this.defer(() => {
      if (!this.options.database.isOpen) return;
      try {
        if (this.ready()) underWriteLock(this.options.database, this.meter, ownerDayKey(at), operation, 'shannon_skills');
      } catch (error) { loggedFailure('skills', error); }
    });
  }

  private now(at: string, operation: () => void): void {
    if (!this.options.database.isOpen || !this.ready()) return;
    try { underWriteLock(this.options.database, this.meter, ownerDayKey(at), operation, 'shannon_skills'); } catch (error) { loggedFailure('skills', error); }
  }
}

/** A pattern page's title and body as stored: present, within bounds, nothing credential-shaped, passing the check. */
function checkedPage(title: string, body: string, check: SkillBodyCheck | null): { title: string; body: string } | { rejected: SkillRejection } {
  const cleanTitle = title.replace(/\s+/gu, ' ').trim();
  const cleanBody = body.trim();
  if (!cleanTitle || !cleanBody) return { rejected: 'empty' };
  if ([...cleanTitle].length > PATTERN_LIMITS.title || cleanBody.length > PATTERN_LIMITS.body) return { rejected: 'too_long' };
  if (looksSecret(`${cleanTitle}\n${cleanBody}`)) return { rejected: 'secret_like' };
  if (injectionThreats(`${cleanTitle}\n${cleanBody}`).length) return { rejected: 'threat' };
  if (check === null) return { rejected: 'check_unavailable' };
  try { if (check.carries(`${cleanTitle}\n${cleanBody}`)) return { rejected: 'secret' }; } catch { return { rejected: 'check_unavailable' }; }
  return { title: cleanTitle, body: cleanBody };
}

/** Sources as ids only (`experience:<id>`, `knowledge:<id>`, `pattern:<id>`, `choice:<id>`, `sequence:<symbols>`), at most 40. */
function closedSources(sources: readonly string[]): string[] {
  return [...new Set(sources.filter(source => /^(?:experience|knowledge|pattern|choice|sequence):[A-Za-z0-9][A-Za-z0-9_.:>-]{0,160}$/u.test(source)))].slice(0, 40);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function iso(at: string): string {
  const time = Date.parse(at);
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString();
}
