import type { ShannonPlace } from '../../../integrations/places/placeDiscovery.js';
import type { ShannonWebSource } from '../../../infra/models/chatModelContract.js';

/** Actual executor observations. A public model summary never changes these states. */
export interface TaskProgress {
  currentStep: string; status: 'running' | 'received' | 'failed' | 'unknown';
  startedAt: string; updatedAt: string;
  findings: Array<{ id: string; text: string; status: 'unconfirmed'; sources: ShannonWebSource[]; updatedAt: string }>;
  places?: ShannonPlace[];
  /** `text` is the full report for the screen; `spoken`, once written, the short form a call says aloud (`fcaSpokenReport.ts`). */
  report?: { id: string; text: string; updatedAt: string; spoken?: string };
}
export interface TaskProgressEvent {
  operationId: string; tool: string; status: TaskProgress['status'];
  read?: { text: string; sources: ShannonWebSource[]; places?: ShannonPlace[] };
  /** A parent-bound `task.send` body (received), or the runtime's own notice that the task could not finish (failed). */
  report?: { text: string };
}
