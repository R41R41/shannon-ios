import { createHash, randomUUID } from 'node:crypto';
import { SKILL_LIFECYCLE } from './skillDocument.js';
import type { SQLiteSkills, SkillActor, SkillUse, StoredSkill } from './store/sqliteSkills.js';

/** How many uses a skill keeps: every pending one and the last resolved window, at most this many in all. */
const USES_KEPT = 16;
type UseStore = Pick<SQLiteSkills, 'setUses' | 'tally'>;
interface TaskUseMemory { write(at: string, operation: () => void): void; store: UseStore & Pick<SQLiteSkills, 'byName' | 'all'> }

/**
 * Uses of a skill read by a common FCA task (`skill.read` in the task's loop; `wiring/fcaSkillOutcomes.ts`). Their `talk` is the
 * task's key, `fca:` and a digest of the task's id. One pending use per task and version; only the task's later outcome settles
 * it (`SkillMemory.settleTask`), never G at night: a read with no later outcome stays pending and judges nothing.
 */
export const FCA_TASK_USE_PREFIX = 'fca:';
export function fcaSkillTaskKey(taskId: string): string {
  return `${FCA_TASK_USE_PREFIX}${createHash('sha256').update(taskId).digest('hex').slice(0, 40)}`;
}
export const isTaskUse = (talk: string): boolean => talk.startsWith(FCA_TASK_USE_PREFIX);

/** Writes a skill's uses: the successes and each newly settled use on its version's node of the lineage (ADR-0008 §14). */
export function writeSkillUses(store: UseStore, skill: StoredSkill, uses: readonly SkillUse[]): void {
  const kept = [...uses.filter(use => use.o === null), ...uses.filter(use => use.o !== null).slice(-SKILL_LIFECYCLE.window)]
    .sort((left, right) => left.at.localeCompare(right.at)).slice(-USES_KEPT);
  const newlySettled = uses.filter(use => use.o === 1 && !skill.uses.some(old => old.id === use.id && old.o === 1)).length;
  store.setUses(skill.scopeKey, skill.skillId, kept, skill.successes + newlySettled);
  for (const use of uses) if (use.o !== null && !skill.uses.some(old => old.id === use.id && old.o !== null)) store.tally(skill.skillId, use.v, use.o);
}

/** `SkillMemory.usedInTask`: the read's skill id (also when the task already read this version), or null. */
export function taskRead(memory: TaskUseMemory, scopeKey: string, taskKey: string, name: string, at: string): string | null {
  let skillId: string | null = null;
  if (!isTaskUse(taskKey)) return null;
  memory.write(at, () => {
    const skill = memory.store.byName(scopeKey, name);
    if (!skill || skill.status === 'retired') return;
    skillId = skill.skillId;
    const uses = withTaskUse(skill, taskKey, at);
    if (uses) writeSkillUses(memory.store, skill, uses);
  });
  return skillId;
}

/** `SkillMemory.settleTask`: how many pending uses of the task were settled. */
export function taskSettle(memory: TaskUseMemory, scopeKey: string, taskKey: string, outcome: 0 | 1, at: string): number {
  let settled = 0;
  if (!isTaskUse(taskKey)) return settled;
  memory.write(at, () => {
    for (const skill of memory.store.all(scopeKey)) {
      const next = settledTaskUses(skill.uses, taskKey, outcome);
      if (!next) continue;
      settled += next.count;
      writeSkillUses(memory.store, skill, next.uses);
    }
  });
  return settled;
}

/** The skill's uses with this task's read of its current version added, or null when the task already read that version. */
export function withTaskUse(skill: StoredSkill, taskKey: string, at: string): SkillUse[] | null {
  if (skill.uses.some(use => use.talk === taskKey && use.v === skill.version)) return null;
  const id = `use_${randomUUID().replace(/-/gu, '').slice(0, 20)}`;
  return [...skill.uses, { id, at: new Date(at).toISOString(), talk: taskKey, v: skill.version, g: 0, o: null }];
}

/** The task's pending uses settled with its outcome (1: a milestone or success; 0: a death or failure), or null when none was pending. */
export function settledTaskUses(uses: readonly SkillUse[], taskKey: string, outcome: 0 | 1): { uses: SkillUse[]; count: number } | null {
  const count = uses.filter(use => use.o === null && use.talk === taskKey).length;
  return count ? { count, uses: uses.map(use => use.o === null && use.talk === taskKey ? { ...use, g: outcome, o: outcome } : use) } : null;
}

export const NO_USES = Object.freeze({ uses: 0, successes: 0 });

/**
 * Whether `SkillMemory.revise` may write a new version for this actor. Her sleep and copies never revise a skill on trial. An
 * owner-approved operator pack (`skillImport.ts`, `revises`) revises only an operator-authored skill, and also one still on its
 * first trial while no use of that version exists: that new-skill trial goes on with the new version (a failure retires it).
 */
export function revisionGate(current: StoredSkill, actor: SkillActor)
  : { rejected: 'name_taken' | 'on_trial' } | { untried: boolean; madeBy: 'sleep' | 'operator_authored'; reason: 'operator_revised' | null } {
  const operator = actor === 'operator_authored';
  if (operator && current.madeBy !== 'operator_authored') return { rejected: 'name_taken' };
  const untried = operator && current.status === 'trial' && current.trialBaseVersion === null && !current.uses.some(use => use.v === current.version);
  if (current.status === 'trial' && !untried) return { rejected: 'on_trial' };
  return { untried, madeBy: operator ? 'operator_authored' : 'sleep', reason: operator ? 'operator_revised' : null };
}
