import type { WorkingNeed } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { minecraftAgendaLines, preemptForNeed } from './minecraftAgenda.js';
import { cutProcedureItem, minecraftProcedureHint, procedureItem } from './minecraftProcedureTool.js';

/** The Minecraft wiring with its agenda's switch (the old agenda's long-call lookahead is gone: the task queue's stretch does what it did, `fcaStretch.ts`). */
export function withMinecraftAgendaParts<M extends object>(minecraft: M | null, on: boolean): (M & { agenda: { on: boolean } }) | null {
  if (!minecraft) return null;
  return Object.assign(minecraft, { agenda: { on } });
}

/**
 * What a Minecraft task's body takes from the executor while the agenda is on (`minecraftWorkingBody.ts`): a need in a wait left to it,
 * the decision's lines (what it did, and the procedure of the step now), and the procedure's running item.
 */
export function minecraftAgendaBodyParts(taskId: string, observe: () => BodyObservation | null) {
  return {
    onWaitNeed: (need: WorkingNeed) => preemptForNeed(taskId, need),
    agendaLines: () => [...minecraftAgendaLines(taskId), ...minecraftProcedureHint(taskId, observe())],
    procedure: { item: () => procedureItem(taskId), cut: () => cutProcedureItem(taskId) },
  };
}