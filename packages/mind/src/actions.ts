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

/** What a lease is judged by (Syzygy ADR-0009 stage 1, S1: one lease read path, one pure judgement). */
export type LeaseFacts = Pick<ActionView, 'state' | 'generation' | 'holder' | 'lastHolder' | 'leaseUntil' | 'deadline' | 'sent' | 'result'>;
/**
 * Which states hold a live lease for a reader. Since S5 every reader compares parsed instants (S1 kept the ISO text comparison
 * of the readers outside the store; they differed only for a time not written by `toISOString()`), and the action's deadline
 * ends the lease for every reader (S1 kept it only for the store's check and the Minecraft lifecycle; the scheduler's sweep
 * ends such a lease within its next tick anyway). What stays per reader is the set of states, because it says what a holder
 * may do there: the store's own checks act while running or waiting, settling and recovery accept a stopping attempt, a
 * step, a turn and the body act only while running.
 */
export interface LeaseRule {
  readonly states: readonly ActionState[];
}
const LIVE_STATES: readonly ActionState[] = ['running', 'waiting', 'stopping'];
/** The rules in use, by reader. */
export const LEASE_RULES = Object.freeze({
  /** The action store's `check` (renew, dispatch, checkpoint, reserve): running or waiting. */
  store: Object.freeze<LeaseRule>({ states: ['running', 'waiting'] }),
  /** The store's `settle` and the recovery of FCA steps: any live state. */
  live: Object.freeze<LeaseRule>({ states: LIVE_STATES }),
  /** An FCA or conversation step, the Minecraft body and its lifecycle authority: running only. */
  step: Object.freeze<LeaseRule>({ states: ['running'] }),
});

/** Whether `time` is after `at`, as instants; an unreadable time is never after. */
export function instantAfter(time: string, at: string): boolean {
  return Date.parse(time) > Date.parse(at);
}

function beforeDeadline(action: LeaseFacts, at: string): boolean {
  if (!action.deadline) return true;
  return instantAfter(action.deadline, at);
}

/** Whether this exact attempt (generation and holder) still holds its lease at `at` under `rule`. */
export function leaseLive(action: LeaseFacts, lease: ActionLease, at: string, rule: LeaseRule): boolean {
  if (action.generation !== lease.generation || action.holder !== lease.holder) return false;
  if (!rule.states.includes(action.state)) return false;
  if (typeof action.leaseUntil !== 'string' || !instantAfter(action.leaseUntil, at)) return false;
  return beforeDeadline(action, at);
}

/** This attempt (its holder, or its holder before) or the attempt just before it, which a sweep or a finish closed. */
export function leaseAttemptKnown(action: LeaseFacts, lease: ActionLease): boolean {
  const holderKnown = action.holder === lease.holder || action.lastHolder === lease.holder;
  if (action.generation === lease.generation) return holderKnown;
  return action.generation === lease.generation + 1 && action.lastHolder === lease.holder;
}

/** This attempt, with its holder, has not been dispatched: its outside operation never started. */
export function leaseUnsent(action: LeaseFacts, lease: ActionLease): boolean {
  return action.holder === lease.holder && action.generation === lease.generation && !action.sent;
}

/** A claim whose lease the sweep let expire before anything was dispatched: no holder, no lease, nothing sent. */
export function unsentLeaseExpiry(action: LeaseFacts): boolean {
  if (action.state !== 'cancelled' || action.sent || action.result !== 'lease_expired') return false;
  if (action.generation < 2 || !action.lastHolder) return false;
  return action.holder === null && action.leaseUntil === null;
}

/** Where a lease stands against its action. `missing` covers an action of another scope. */
export type LeaseStanding = 'missing' | 'expired_unsent' | 'stop_acknowledged' | 'superseded' | 'live' | 'closed_unsent' | 'unknown';
/** What recovery may do with a lease's step: keep it, close it as safe, or hold it as unknown (never replayed). */
export type LeaseOutcome = 'live' | 'safe' | 'unknown';

function closedByThisAttempt(action: LeaseFacts, lease: ActionLease): LeaseStanding | null {
  const expired = action.generation === lease.generation + 1 && !action.sent && action.result === 'lease_expired';
  if (expired && action.lastHolder === lease.holder && action.state === 'cancelled') return 'expired_unsent';
  const acknowledged = action.state === 'cancelled' && action.result === 'fca_stop_acknowledged';
  if (acknowledged && action.generation === lease.generation && action.lastHolder === lease.holder) return 'stop_acknowledged';
  return null;
}

/** The standing of a lease at `at`, in the order the FCA recovery has always asked. */
export function classifyLease(action: LeaseFacts | null, lease: ActionLease, at: string): LeaseStanding {
  if (!action) return 'missing';
  const closed = closedByThisAttempt(action, lease);
  if (closed) return closed;
  if (action.generation !== lease.generation) return 'superseded';
  if (leaseLive(action, lease, at, LEASE_RULES.live)) return 'live';
  // A model response lost after dispatch remains unknown even if the process only held local tools.
  const closedUnsent = !action.sent && ['cancelled', 'failed', 'completed'].includes(action.state);
  return closedUnsent ? 'closed_unsent' : 'unknown';
}

/** The recovery outcome of a standing. */
export function leaseOutcome(standing: LeaseStanding): LeaseOutcome {
  if (standing === 'live') return 'live';
  const safe = standing === 'expired_unsent' || standing === 'stop_acknowledged' || standing === 'closed_unsent';
  return safe ? 'safe' : 'unknown';
}
