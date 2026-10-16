import { skillGist } from '../mind/memory/memoryPorts.js';
import type { SkillTurnPorts, SkillTurnSkill } from '../contracts/skillMemoryContract.js';
import { neutralMarkers } from '../mind/tools/shannonToolTypes.js';
import { gistToolNames, observeOnlyStep, type SkillGistsPort } from '../surfaces/minecraft/minecraftSkillPointers.js';
import { fcaReadReceiptSources } from '../mind/action/fca/fcaConversationSources.js';
import type { TaskRuntime, TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { FcaSkillOutcomes } from './fcaSkillOutcomes.js';
import { isSkillGistPin, skillGistSource } from './fcaSkillGistSource.js';

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
  /** The task's current sources already hold this exact revision: no new pin (one source per skill revision, not per decision). */
  pinned?(sourceId: string): boolean;
}): Map<string, readonly string[]> {
  const gists = new Map<string, readonly string[]>();
  for (const name of names) {
    const skill = parts.open(name);
    const steps = skill ? skillGist(skill.body, observeOnlyStep).map(neutralMarkers) : [];
    if (!skill || !steps.length) continue;
    const source = skillGistSource(skill.skillId, skill.revisionId);
    if (!parts.pinned?.(source) && !parts.pin(`skill-gist:${skill.skillId}:${skill.version}`, [source])) continue;
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

/**
 * A body task's gist ports (`createMinecraftTaskBody`): the gists, each pinned as a read, and a followed gist as a use. Each decision
 * that is offered or withheld gists leaves one content-free line (`gistOfferLine`; Minebot run 12: nobody could tell whether a gist
 * reached the model); the same outcome again within the step is not logged twice.
 */
export function bodySkillGists(step: TaskStep, open: SkillTurnPorts['open'] | undefined,
  observeRead: ReturnType<typeof stepReadObserver>, outcomes: Pick<FcaSkillOutcomes, 'gistFollowed'> | null | undefined,
  log: (line: string) => void = line => console.info(line))
  : { skillGists: SkillGistsPort; gistFollowed(name: string): void } | Record<string, never> {
  if (!open) return {};
  // Throws when the skill cannot be read now: then it has no gist.
  const opened = (name: string) => { try { return open(step.scopeKey, name); } catch { return null; } };
  // A task that holds no source of its own (an operator's request, an own-time task) runs without a visibility check, and a source
  // would add one (`canRunTask`): showing a gist must never change whether a task can run, so such a task gets the pointer alone.
  // A pin of a gist does not make a task one that holds sources.
  const holdsSources = () => step.snapshot?.sources?.some(item => !item.readSourceIds?.length || !item.readSourceIds.every(isSkillGistPin)) ?? false;
  // Logged again only when the outcome changes (the pins of a later decision are none: the revision is pinned once).
  let lastOutcome = '';
  const noted = (outcome: string, line: string) => {
    if (outcome === lastOutcome) return;
    lastOutcome = outcome;
    try { log(line); } catch { /* logging never fails a step */ }
  };
  return {
    skillGists: names => {
      const holds = holdsSources();
      if (!holds) {
        noted(`withheld:${names.join(',')}`, gistOfferLine(step.taskId, names, new Map(), holds, { attempts: 0, failures: 0 }));
        return new Map();
      }
      const pins = { attempts: 0, failures: 0 };
      const shown = fcaSkillGists(names, { open: opened,
        pin: (id, sourceIds) => {
          pins.attempts += 1;
          const pinned = observeRead(id, { name: 'skill.read', ok: true, documents: { sourceIds } });
          if (!pinned) pins.failures += 1;
          return pinned;
        },
        pinned: source => step.snapshot?.sources?.some(item => item.readSourceIds?.includes(source)) ?? false });
      noted(`${names.join(',')}:${[...shown.keys()].join(',')}:${pins.failures}`, gistOfferLine(step.taskId, names, shown, holds, pins));
      return shown;
    },
    gistFollowed: name => outcomes?.gistFollowed(step.scopeKey, step.taskId, name),
  };
}

/**
 * `Shannon Minecraft skill gist task=<id> holdsSources=<bool> pointed=<names> offered=<names> pinAttempts=<n> pinFailures=<n>`:
 * skill names only (pointed: the skills the situation matched, offered: those whose gist was given, `-` when none), never a gist.
 * `offered=-` with `holdsSources=true` is a gist that could not be opened, was empty, or could not be pinned (`pinFailures`).
 * `named` is, for each offered skill, the body tools its gist names that a call can be attributed to (`gistToolNames`: tool names, never
 * text), `skill=tool,tool;skill=-`, `-` when none: a gist naming none is one a call can never follow (Minebot run 13: `not_named_by_gist`).
 * The line is written when the outcome changes, not on every decision: the count of decisions that carried gists is `fca_request_size`'s.
 */
export function gistOfferLine(taskId: string, pointed: readonly string[], shown: ReadonlyMap<string, readonly string[]>, holdsSources: boolean,
  pins: { attempts: number; failures: number }): string {
  const list = (names: readonly string[]) => names.length ? names.join(',') : '-';
  const offered = pointed.filter(name => shown.has(name));
  const named = offered.map(name => `${name}=${list([...gistToolNames(shown.get(name)!)])}`).join(';') || '-';
  return `Shannon Minecraft skill gist task=${taskId} holdsSources=${holdsSources} pointed=${list(pointed)} offered=${list(offered)} `
    + `pinAttempts=${pins.attempts} pinFailures=${pins.failures} named=${named}`;
}
