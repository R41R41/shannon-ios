import { skillGist } from '../mind/memory/memoryPorts.js';
import type { SkillTurnPorts, SkillTurnSkill } from '../contracts/skillMemoryContract.js';
import { neutralMarkers } from '../mind/tools/shannonToolTypes.js';
import { observeOnlyStep, type SkillGistsPort } from '../surfaces/minecraft/minecraftSkillPointers.js';
import { fcaReadReceiptSources } from '../mind/action/fca/fcaConversationSources.js';
import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaSkillOutcomes } from './fcaSkillOutcomes.js';

/**
 * The gists of a body task's pointed skills (`SHANNON_FCA_SKILL_GIST`, owner 2026-10-15; `minecraftSkillPointers.ts`). Each skill is
 * opened through the same port as `skill.read` (`open`: its visibility, forgetting and secret checks at use time), and its exact
 * revision is pinned as a read source of the task (`pin`, the read receipt `skill.read` leaves) before any of its text is given;
 * a skill that cannot be opened or pinned now has no gist (its pointer alone). The gist is code over the stored text (`skillGist`):
 * at most three lines, the shared observe-first step left out, fence markers neutralized. Opening it here is not a use.
 */
export function fcaSkillGists(names: readonly string[], parts: {
  open(name: string): SkillTurnSkill | null;
  pin(operationId: string, sourceIds: readonly string[]): boolean;
}): Map<string, readonly string[]> {
  const gists = new Map<string, readonly string[]>();
  for (const name of names) {
    const skill = parts.open(name);
    const steps = skill ? skillGist(skill.body, observeOnlyStep).map(neutralMarkers) : [];
    if (!skill || !steps.length) continue;
    const source = `shannon-skill://${encodeURIComponent(skill.skillId)}${skill.revisionId ? `/revision/${encodeURIComponent(skill.revisionId)}` : ''}`;
    if (!parts.pin(`skill-gist:${skill.skillId}:${skill.version}`, [source])) continue;
    gists.set(name, steps);
  }
  return gists;
}

/**
 * A step's read receipt (`observeRead`): the sources a read names are pinned on the task, only while the owner alone is present and
 * each is visible now, and the task's sources stay visible after it. A read that names none is fine. One rule for `skill.read`,
 * the skill index and a gist.
 */
export function stepReadObserver(parts: {
  runtime: Pick<TaskRuntime, 'observeSources' | 'taskSources'>; step: TaskStep; ownerAlone(): boolean;
  readSourceVisible?: (scopeKey: string, id: string, at: string) => boolean; sourcesVisible(): boolean;
}): (operationId: string, receipt: Parameters<typeof fcaReadReceiptSources>[0]) => boolean {
  const { runtime, step } = parts;
  return (operationId, receipt) => {
    const ids = fcaReadReceiptSources(receipt).readSourceIds ?? [];
    if (!ids.length) return true;
    const at = new Date().toISOString();
    if (!parts.ownerAlone() || ids.some(id => !parts.readSourceVisible?.(step.scopeKey, id, at))) return false;
    if (!runtime.observeSources(step, { observationId: `read:${operationId}`, recalledMemoryIds: [], readSourceIds: ids })) return false;
    step.snapshot.sources = runtime.taskSources(step.scopeKey, step.taskId, step.messageIds);
    return parts.sourcesVisible();
  };
}

/** A body task's gist ports (`createMinecraftTaskBody`): the gists, each pinned as a read, and a followed gist as a use. */
export function bodySkillGists(step: TaskStep, open: SkillTurnPorts['open'] | undefined,
  observeRead: ReturnType<typeof stepReadObserver>, outcomes: Pick<FcaSkillOutcomes, 'gistFollowed'> | null | undefined)
  : { skillGists: SkillGistsPort; gistFollowed(name: string): void } | Record<string, never> {
  if (!open) return {};
  // Throws when the skill cannot be read now: then it has no gist.
  const opened = (name: string) => { try { return open(step.scopeKey, name); } catch { return null; } };
  return {
    skillGists: names => fcaSkillGists(names, { open: opened,
      pin: (id, sourceIds) => observeRead(id, { name: 'skill.read', ok: true, documents: { sourceIds } }) }),
    gistFollowed: name => outcomes?.gistFollowed(step.scopeKey, step.taskId, name),
  };
}
