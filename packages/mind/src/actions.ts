/** ADR-0008 stage 4. Closed execution vocabulary, independent of transport and persistence. */
export const ACTION_KINDS = ['respond', 'ownTime', 'agentTask', 'minecraft'] as const;
export type ActionKind = typeof ACTION_KINDS[number];
export type ActionOrigin = 'owner_request' | 'own_time' | 'maintenance';
export const ACTION_STATES = ['queued', 'running', 'waiting', 'stopping', 'completed', 'failed', 'cancelled', 'unknown'] as const;
export type ActionState = typeof ACTION_STATES[number];
export const ACTION_TERMINAL: readonly ActionState[] = ['completed', 'failed', 'cancelled', 'unknown'];
export const ACTION_LIMITS = Object.freeze({
  foreground: 1, background: 2, leaseMs: 30_000, consecutiveFailures: 5, resources: 16,
  /**
   * How long a sent action whose outcome is unknown keeps its slot and resource exclusions. Afterwards it stays `unknown`
   * (never replayed, never resumable) but stops counting as live, so one lost reply cannot block the scheduler forever.
   * The same deadline retires an FCA task left in `fca_unknown`.
   */
  unknownReleaseMs: 600_000,
  /** Consecutive failed lease renewals (transport or a busy database) tolerated while the lease itself is still valid. */
  renewFailuresTolerated: 2,
});
export interface ActionDraft {
  scopeKey: string; kind: ActionKind; origin: ActionOrigin; sourceId: string;
  parentId?: string | null; resources?: readonly string[]; ownerInformed?: boolean; deadline?: string | null;
}
export interface ActionView {
  id: string; scopeKey: string; kind: ActionKind; origin: ActionOrigin; sourceId: string; parentId: string | null;
  state: ActionState; generation: number; holder: string | null; lastHolder: string | null; leaseUntil: string | null;
  resources: readonly string[]; ownerInformed: boolean; deadline: string | null;
  progress: string | null; result: string | null; sent: boolean; failures: number; lastFailure: string | null;
  createdAt: string; updatedAt: string;
  /** Presentation-only receipt. It grants no execution or resource rights. */
  notification?: { id: string; acknowledgedAt: string | null };
}
export interface ActionLease { id: string; generation: number; holder: string }
export const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u;
export const ACTION_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;
export function validActionDraft(draft: ActionDraft): boolean {
  return typeof draft.scopeKey === 'string' && typeof draft.sourceId === 'string'
    && ACTION_ID.test(draft.scopeKey) && ACTION_ID.test(draft.sourceId)
    && ACTION_KINDS.includes(draft.kind) && ['owner_request', 'own_time', 'maintenance'].includes(draft.origin)
    && (draft.origin !== 'maintenance' || draft.kind === 'agentTask')
    && (draft.kind !== 'ownTime' || draft.origin === 'own_time')
    && (draft.kind !== 'respond' || draft.origin === 'owner_request')
    && (!draft.parentId || ACTION_ID.test(draft.parentId))
    && (draft.resources?.length ?? 0) <= ACTION_LIMITS.resources
    && (draft.resources ?? []).every(key => /^res:[a-f0-9]{64}$/u.test(key))
    && (!draft.deadline || Number.isFinite(Date.parse(draft.deadline)));
}
