import type { AutonomyLoopCycle, AutonomyPlannedStep } from './autonomyLoopState.js';
import type { StepDependencies, StepResult } from './autonomyLoopSteps.js';

/**
 * The provenance mark in her own time (owner decision 2026-10-06, Syzygy ADR-0007; the store is `ownerInformedMarks.ts`).
 *
 * After a step is reported, inside the same transaction: a step that read one of the owner's documents, a shared Notion page,
 * or a document already marked marks its session; then, while the session is marked, what the step wrote is marked, and so are
 * the pursuits created or changed since the mark. Only ids and times are written, never a word of what was read.
 *
 * While her own time may read the owner's documents, a marked session does not speak up while anyone else may see or hear her
 * body (`heldForOthers`), and the gate refuses anything that reaches another person outright (`ownerInformed` in
 * `authorizeAutonomousAction`).
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
 * A message of hers to the owner, in a marked session, while anyone else may see or hear her body: held. Only while her own time
 * may read the owner's documents (`SHANNON_AUTONOMY_OWNER_DOCUMENTS=on`): with it off, a session marked by a shared Notion page
 * only marks what it wrote. A session that is not marked is not asked about who is there. Who is there, unreadable, counts as someone.
 */
export function heldForOthers(dependencies: Pick<StepDependencies, 'store' | 'reachOuts' | 'loop'>, cycle: Pick<AutonomyLoopCycle, 'id' | 'scopeKey'>, at: string): boolean {
  if (!dependencies.loop.ownerDocuments || !dependencies.store.informed.sessionInformedAt(cycle.id)) return false;
  try { return dependencies.reachOuts?.audience(cycle.scopeKey, at) !== null; } catch { return true; }
}
