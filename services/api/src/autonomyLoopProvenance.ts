import type { AutonomyLoopCycle, AutonomyPlannedStep } from './autonomyLoopState.js';
import { STUDY_DOCUMENT_PREFIX } from './ownerInformedMarks.js';
import type { StepDependencies, StepResult } from './autonomyLoopSteps.js';

/**
 * The provenance mark in her own time (owner decision 2026-10-06, Syzygy ADR-0007; the store is `ownerInformedMarks.ts`).
 *
 * After a step is reported, inside the same transaction: a step that read one of the owner's documents, a shared Notion page,
 * or a document already marked marks its session; then, while the session is marked, what the step wrote is marked, and so are
 * the pursuits created or changed since the mark. Only ids and times are written, never a word of what was read.
 *
 * A marked session, whatever marked it (his documents or a shared Notion page; owner decision 2026-10-06), does not speak up
 * while anyone else may see or hear her body (`heldForOthers`), and the gate refuses anything that reaches another person
 * outright (`ownerInformed` in `authorizeAutonomousAction`). A session that is not marked is not affected.
 */
/** Step kinds whose product is text of hers: a note, a story's draft or revision, what she jotted down. */
const WRITING_STEPS: ReadonlySet<AutonomyPlannedStep['kind']> = new Set(['note', 'draft', 'revise', 'jot']);

export function noteProvenance(dependencies: Pick<StepDependencies, 'store'>, cycle: AutonomyLoopCycle, step: AutonomyPlannedStep, result: StepResult, link: string | undefined, at: string): void {
  if (result.outcome !== 'done') return;
  const marks = dependencies.store.informed;
  const documents = result.documents;
  if (documents?.informs || (documents?.read ?? []).some(id => marks.marked(cycle.scopeKey, id))) marks.markSession(cycle.id, at);
  const since = marks.sessionInformedAt(cycle.id);
  if (!since) return;
  const wrote = [...(documents?.wrote ?? []), ...(WRITING_STEPS.has(step.kind) && link ? [link] : [])];
  if (wrote.length) marks.markDocuments(cycle.scopeKey, wrote, cycle.id, at);
  marks.markPursuits(cycle.scopeKey, since, at);
}

/**
 * Which pieces of her study a prompt of this session may carry (owner decision 2026-10-06, option a): a session that is not
 * marked is given nothing marked, so a story or a message of an unmarked session cannot retell what she wrote after reading
 * the owner's. A marked session is given everything as before; opening a marked piece on purpose (`study.read`, `aether.read`,
 * revising it) marks the session. With anyone else present (`others`) nothing marked is given, whatever the session. While
 * nothing is marked, nothing is looked up and every prompt is what it was. A mark that cannot be read counts as a mark.
 */
export function unmarkedOnly(dependencies: Pick<StepDependencies, 'store'>, cycle: Pick<AutonomyLoopCycle, 'id' | 'scopeKey'>, others = false): (piece: { id: string }) => boolean {
  const marks = dependencies.store.informed;
  if (!marks.any(cycle.scopeKey) || (!others && marks.sessionInformedAt(cycle.id))) return () => true;
  return piece => { try { return !marks.marked(cycle.scopeKey, `${STUDY_DOCUMENT_PREFIX}${piece.id}`); } catch { return false; } };
}

/** The same for her pursuits: a pursuit created or changed in a marked session is not given to a session that is not marked. */
export function unmarkedPursuits(dependencies: Pick<StepDependencies, 'store'>, cycle: Pick<AutonomyLoopCycle, 'id' | 'scopeKey'>): (pursuit: { id: string }) => boolean {
  const marks = dependencies.store.informed;
  let informed: ReadonlySet<string>;
  try { informed = marks.informedPursuits(cycle.scopeKey); } catch { return () => false; }
  if (!informed.size || marks.sessionInformedAt(cycle.id)) return () => true;
  return pursuit => !informed.has(pursuit.id);
}

/**
 * A message of hers to the owner (a message, a second call, a phone call), in a marked session, while anyone else may see or hear
 * her body: held. Also with `SHANNON_AUTONOMY_OWNER_DOCUMENTS` off, for a session marked by a shared Notion page (owner decision
 * 2026-10-06). A session that is not marked is not asked about who is there. Who is there, unreadable, counts as someone.
 */
export function heldForOthers(dependencies: Pick<StepDependencies, 'store' | 'reachOuts'>, cycle: Pick<AutonomyLoopCycle, 'id' | 'scopeKey'>, at: string): boolean {
  if (!dependencies.store.informed.sessionInformedAt(cycle.id)) return false;
  try { return dependencies.reachOuts?.audience(cycle.scopeKey, at) !== null; } catch { return true; }
}
