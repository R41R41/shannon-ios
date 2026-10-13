import { ACTION_LIMITS } from './actions.js';
import {
  legacyProjection, type EffectClass, type ExecState, type LegacyTaskState, type SlotClass, type SlotLimits, type TaskKind,
} from './tasks.js';

/**
 * The one state machine of a task (Syzygy ADR-0009 stage 1, S4), pure. A writer asks for the state a task should be in; the
 * machine says whether that move is allowed from where the task is, and gives the old `status` and `pause_reason` that are
 * written with it in the same UPDATE. The invariants it keeps:
 * - a finished task (completed, failed, cancelled) never moves again, except a task closed with its outcome unknown on a late
 *   report of its outside work (`lateReport`: completed, or paused again);
 * - nothing becomes `proposed` again;
 * - an unknown task never becomes active: it leaves to a finished state, back to an open state other than active when a proof
 *   about its lost attempt says nothing was sent (`proof`), or, for the internal root and a conversation, by retirement or the
 *   owner's turn back to their inbox (ready, waiting, stopping, stopped);
 * - a state the kind never takes (an FCA task proposed, a Codex task stopping or unknown) has no projection and is refused.
 */
export interface TaskEvent {
  readonly to: ExecState;
  /** The reason of a wait: the FCA checkpoint's, or the Agent Host's (`approval`, `owner`). */
  readonly waitReason?: string | null;
  /** A Codex task still connecting to its Host (`starting`, else `running`). */
  readonly starting?: boolean;
  /** The move rests on a proof that the task's lost attempt sent nothing (its lease expired unsent, its stop acknowledged). */
  readonly proof?: boolean;
  /**
   * A late report of the outside work reaches a task the unknown exit closed as failed (`outcome_unknown_closed`): the truth
   * wins, so it may become completed, or paused again for the owner (stopped, or waiting for the owner).
   */
  readonly lateReport?: boolean;
}

export type TaskRefusal = 'illegal' | 'no_projection';

export type TaskTransition =
  | { readonly ok: true; readonly state: ExecState; readonly legacy: LegacyTaskState; readonly waitReason: string | null; readonly starting: boolean }
  | { readonly ok: false; readonly reason: TaskRefusal; readonly from: ExecState | null; readonly to: ExecState };

const FINISHED: readonly ExecState[] = ['completed', 'failed', 'cancelled'];
const OPEN: readonly ExecState[] = ['ready', 'active', 'waiting', 'stopping', 'stopped'];
const MOVING: readonly ExecState[] = [...OPEN, 'unknown', ...FINISHED];
/** Where the internal root and a conversation go back to from unknown: their inbox runs again. */
const INBOX_EXITS: readonly ExecState[] = ['ready', 'waiting', 'stopping', 'stopped'];

/** The states each state may move to (staying is always allowed). */
export const TASK_TRANSITIONS: Readonly<Record<ExecState, readonly ExecState[]>> = Object.freeze({
  proposed: ['proposed', ...OPEN, ...FINISHED],
  ready: MOVING, active: MOVING, waiting: MOVING, stopping: MOVING, stopped: MOVING,
  unknown: ['unknown', ...FINISHED],
  completed: ['completed'], failed: ['failed'], cancelled: ['cancelled'],
});

const inboxKind = (kind: TaskKind) => kind === 'root' || kind === 'conversation';
/** Where a task closed with an unknown outcome may go on a late report of its outside work. */
const LATE_REPORT_EXITS: readonly ExecState[] = ['completed', 'stopped', 'waiting'];

/**
 * Whether a task of `kind` may move from `from` (null: a new row, or one no state can be read from) to `to`; `proof` opens the
 * inbox exits of an unknown task to every kind, `lateReport` the late-report exits of a failed one.
 */
export function transitionAllowed(from: ExecState | null, to: ExecState, kind: TaskKind,
  event: Pick<TaskEvent, 'proof' | 'lateReport'> = {}): boolean {
  if (from === null || from === to) return true;
  if (TASK_TRANSITIONS[from].includes(to)) return true;
  if (from === 'failed') return event.lateReport === true && LATE_REPORT_EXITS.includes(to);
  return from === 'unknown' && (event.proof === true || inboxKind(kind)) && INBOX_EXITS.includes(to);
}

/** Applies one event to a task's state: the new state with its old columns, or the refusal. */
export function taskTransition(from: ExecState | null, kind: TaskKind, event: TaskEvent): TaskTransition {
  const to = event.to;
  if (!transitionAllowed(from, to, kind, event)) return { ok: false, reason: 'illegal', from, to };
  const waitReason = to === 'waiting' ? event.waitReason ?? null : null;
  const starting = kind === 'codex' && to === 'active' && event.starting === true;
  const legacy = legacyProjection(to, kind, { starting, waitReason });
  if (!legacy) return { ok: false, reason: 'no_projection', from, to };
  return { ok: true, state: to, legacy, waitReason, starting };
}

/** The refusal's closed counter key: `<reason>:<kind>:<from>><to>`. */
export function transitionRefusalKey(kind: TaskKind, refusal: Extract<TaskTransition, { ok: false }>): string {
  return `${refusal.reason}:${kind}:${refusal.from ?? 'none'}>${refusal.to}`;
}

/**
 * The one unknown exit (S5). An unknown outcome is never replayed. After `UNKNOWN_EXIT_MS` it leaves by one rule, judged on
 * parsed instants:
 * - model-only work (`none`) is retired (`unknown_retired`): the internal root and a conversation resume their inbox, any other
 *   task fails;
 * - work that acts outside (`external`) is closed as failed (`outcome_unknown_closed`): its slot is freed, its retained
 *   resources stay held until a release proof or the owner's release.
 */
export const UNKNOWN_EXIT_MS = ACTION_LIMITS.unknownReleaseMs;

export type UnknownExitCode = 'unknown_retired' | 'outcome_unknown_closed';

export interface UnknownExit {
  readonly code: UnknownExitCode;
  /** `resume`: the task's inbox runs again (root, conversation); `failed`: the task fails and its parent hears of it. */
  readonly task: 'resume' | 'failed';
}

/** The exit of model-only work (`none`): `ACTION_LIMITS.unknownReleaseModelOnlyMs`. */
export const UNKNOWN_EXIT_MODEL_ONLY_MS = ACTION_LIMITS.unknownReleaseModelOnlyMs;

/**
 * How long an unknown of this task kind waits for its exit: the step of an FCA work task (research, generic; effect class
 * `none`) the shorter model-only time, anything else (Agent Host, own time, sleep, a kind not known) the full time.
 */
export function unknownExitMs(kind: TaskKind | null = null): number {
  return kind === 'work' ? UNKNOWN_EXIT_MODEL_ONLY_MS : UNKNOWN_EXIT_MS;
}

/** Whether an unknown since `since` has reached its exit at `at` (instants; an unreadable time never does). */
export function unknownDue(since: string | null, at: string, kind: TaskKind | null = null): boolean {
  if (!since) return false;
  const start = Date.parse(since);
  const now = Date.parse(at);
  return Number.isFinite(start) && Number.isFinite(now) && start + unknownExitMs(kind) <= now;
}

export function unknownExit(effectClass: EffectClass, kind: TaskKind | null): UnknownExit {
  if (effectClass === 'external') return { code: 'outcome_unknown_closed', task: 'failed' };
  return { code: 'unknown_retired', task: kind !== null && inboxKind(kind) ? 'resume' : 'failed' };
}

/** An action's outside effect: only the step of a model-only task (an FCA task) is `none`; anything else may act outside. */
export function actionEffectClass(taskKind: TaskKind | null): EffectClass {
  return taskKind !== null && taskKind !== 'codex' ? 'none' : 'external';
}

/** Why a slot was refused: its pool is full (`pool_<pool>`) or its class is (`class_<class>`). */
export type SlotVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Whether one more action of `slotClass` fits beside the live ones (S6): its pool below the pool's limit and its class below
 * the class's limit, both read from the slot tables.
 */
export function slotAdmissible(slotClass: SlotClass, live: readonly SlotClass[], limits: SlotLimits): SlotVerdict {
  const limit = limits.classes[slotClass];
  const poolMax = limit ? limits.pools[limit.pool] : undefined;
  if (!limit || poolMax === undefined) return { ok: false, reason: `class_${slotClass}` };
  const inPool = live.filter(other => limits.classes[other]?.pool === limit.pool).length;
  if (inPool >= poolMax) return { ok: false, reason: `pool_${limit.pool}` };
  const inClass = live.filter(other => other === slotClass).length;
  if (inClass >= limit.maxLive) return { ok: false, reason: `class_${slotClass}` };
  return { ok: true };
}
