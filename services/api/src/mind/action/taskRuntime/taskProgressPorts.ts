import type { ShannonPlace } from '../../../integrations/places/placeDiscovery.js';
import type { ShannonWebSource } from '../../../infra/models/chatModelContract.js';

/** The id prefix of a report that says the runtime paused the task by itself (`TaskProgressStore.pauseNotice`). */
export const PAUSE_NOTICE_PREFIX = 'paused:';

/** Whether a stored report is the runtime's own pause notice (resumable, not a result and not a failure). */
export const isPauseNotice = (report: { id: string } | undefined | null): boolean => Boolean(report?.id.startsWith(PAUSE_NOTICE_PREFIX));

/**
 * Actual executor observations. A public model summary never changes these states. `paused`: the runtime stopped the task by itself and
 * the owner may resume it (only `TaskProgressStore.pauseNotice` writes it, with a `paused:` report; an executor event never carries it).
 */
export interface TaskProgress {
  currentStep: string; status: 'running' | 'received' | 'failed' | 'unknown' | 'paused';
  startedAt: string; updatedAt: string;
  findings: Array<{ id: string; text: string; status: 'unconfirmed'; sources: ShannonWebSource[]; updatedAt: string }>;
  places?: ShannonPlace[];
  /** `text` is the full report for the screen; `spoken`, once written, the short form a call says aloud (`fcaSpokenReport.ts`). */
  report?: { id: string; text: string; updatedAt: string; spoken?: string;
    /** Said in the voice turn that asked for it (`researchHeardInTurn`): its card stays in the Talk; no call says it again. */
    heard?: true };
}
export interface TaskProgressEvent {
  operationId: string; tool: string; status: Exclude<TaskProgress['status'], 'paused'>;
  read?: { text: string; sources: ShannonWebSource[]; places?: ShannonPlace[] };
  /** A parent-bound `task.send` body (received), or the runtime's own notice that the task could not finish (failed). */
  report?: { text: string };
}
