import type { ShannonPursuit, ShannonPursuitStatus } from '@shannon/cognition';
import type { AutonomyBudgetStatus } from '../../inhibition/inhibitionPorts.js';
import type { AutonomyLoopStatus } from '../../inhibition/autonomyDayLog.js';
import type { AutonomyModelChoice } from './autonomyModels.js';
import type { ShannonAgentTaskProposal } from './store/autonomyProposals.js';
import type { AutonomySessionView } from './autonomySessionView.js';
import type { AutonomyBudgetRequest } from './store/autonomyStore.js';

/** The owner's overview of bounded autonomy, and wording helpers of the autonomy service's record entries. */
export type AutonomyControlLabel = 'disabled' | 'paused' | 'active';

export interface AutonomyOverview {
  control: { state: AutonomyControlLabel; enabled: boolean; paused: boolean; changedAt: string | null };
  /** What the activity loop is doing, in the words the owner's screens show. */
  loop: AutonomyLoopStatus;
  /** Her session or her rest (`autonomySessionView.ts`); absent under the fixed cycles and before her first session. */
  session?: AutonomySessionView;
  budget: AutonomyBudgetStatus;
  budgetRequest: AutonomyBudgetRequest | null;
  maximumExtraYen: number;
  pursuits: readonly ShannonPursuit[];
  modelChoices: readonly AutonomyModelChoice[];
  proposals: readonly ShannonAgentTaskProposal[];
}


export function pursuitStatusPhrase(status: ShannonPursuitStatus): string {
  return { active: '続けることにしました', resting: '休ませました', done: 'やり終えました', dropped: 'やめました' }[status];
}

export function clip(value: unknown, maximum: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}
