import { readActResult, type ActPos } from '../../contracts/minecraftActContract.js';
import { deathBetween, type DeathCounter } from '../../contracts/continueContract.js';
import { onRedecideNote } from '../../infra/decisionRecords/decisionRecordNotes.js';

/**
 * Amendment A-12 (owner's decision 2026-10-29: 「新しい版だけ・詰まったら止めて直す」): the stalls the head finds itself, beside the ones the body names (a go's `go_stuck`,
 * `go_search_timeout`, a long loss: its receipt's `incident`). A request made with `--hold-on-failure` is held when one of these happens, its box is written (the reason and the
 * last rows of the decision record) and it waits for the operator's resume, as it does for the body's. Nothing here decides for the model or changes what is sent; it only counts
 * what the head already knows, per task, in memory:
 *
 * - `node_stalled`: the plan's current node has not moved on for `STALL.nodeMs` of the task's running time (the time it was held is left out, as the meter's clock leaves it out).
 *   It moved on when the node, its state or the meter's next milestone changed, or the pack grew (`movedOn`).
 * - `same_spot_stops`: a `go` or `vertical` stopped short (not done) `STALL.spotStops` times within `STALL.spotRadius` blocks of the first stop, with no done one of the two between.
 * - `wait_loop`: `STALL.waits` acts of nothing but `wait` ran in a row; an act with a hand that moves the body (`MOVING`) ends the run.
 * - `decide_error`: the decision again of an act (A-10) failed or ran out of time, Opus's act was refused after its mend (A-11), or `STALL.refusals` acts in a row were refused by
 *   the checks before sending (no act was accepted between).
 * - `death`: the body's death counter rose (`deathBetween`: a rise of `deathSeq` within one `deathEpoch`; a full loss is the same).
 *
 * Each `note…` returns the stall it found, or null. A task that found one is quiet (nothing more is counted: the hold is being made, and the cut-off acts of the stop would count
 * as stops) until `resumeStalls`. The holds are made by the caller (`minecraftLlmcWiring.ts`), only for a request that asked to be held.
 */
/** The ids of the incidents a stall makes start with this (`stallIncidentId`); the operator's reads of a hold know a stall of the head by it (`headIncidentKind`). */
export const HEAD_INCIDENT_PREFIX = 'head:';
export const STALL = Object.freeze({ nodeMs: 120_000, spotRadius: 3, spotStops: 2, waits: 3, refusals: 2 });
export type StallKind = 'node_stalled' | 'same_spot_stops' | 'wait_loop' | 'decide_error' | 'death';
export interface Stall {
  kind: StallKind;
  /** What tells this stall from another of its kind (the node, the place, the way the decision failed): part of the incident's id. */
  key: string;
  /** The reason, in the operator's words (it goes to the audit line and the box). */
  why: string;
  /** Where the body stood, when the stall knows (same_spot_stops). */
  at?: ActPos;
  /** The command that made the stall, when sending it again is what a resume should do (same_spot_stops); absent: a resume sends nothing. */
  command?: string;
}

/** The hands that move the body or change the world around it: an act with one of them is not a wait. The others (look, equip, eat, craft, furnace, chest, …) are neither. */
/** A-13: the hands whose being done changes the pack or the world (they set the count of stops in one place afresh). */
const WORKED: ReadonlySet<string> = new Set(['dig', 'mine', 'place', 'pickup', 'make', 'craft', 'smelt', 'furnace', 'chest', 'pillarUp', 'obsidian', 'portal', 'attack', 'fight']);
/** A-13: a hand that stopped short spent time or work when it moved (a step or a meter), dug or placed, or ran 3 s and more (the act's whole time when it was the only hand that ran). */
const SPENT_MS = 3_000;
function spentTime(line: { progress?: { done?: number; work?: { dug?: number; placed?: number; placeAttempts?: number } }; motorOps?: number }, actMs: number, running: number): boolean {
  const progress = line.progress, work = progress?.work;
  if ((progress?.done ?? 0) > 0 || (work?.dug ?? 0) > 0 || (work?.placed ?? 0) > 0 || (work?.placeAttempts ?? 0) > 0) return true;
  return actMs >= SPENT_MS && (running <= 1 || (line.motorOps ?? 0) > 0);
}
export const MOVING: ReadonlySet<string> = new Set(['walk', 'go', 'vertical', 'pillarUp', 'jump', 'dig', 'mine', 'place', 'pickup', 'attack', 'fight', 'shoot', 'portal', 'obsidian']);

// ---- progress --------------------------------------------------------------------------------------------------------------------------------------
/** What the progress of the current node is read from, at one moment. `node` is null when the plan has no current node (nothing is counted then). */
export interface ProgressSnapshot { node: string | null; state: string | null; milestone: string | null; items: number }
/** Whether the task moved on between two moments: another node, another state of it, another next milestone, or more things carried. Pure. */
export function movedOn(before: ProgressSnapshot, after: ProgressSnapshot): boolean {
  return before.node !== after.node || before.state !== after.state || before.milestone !== after.milestone || after.items > before.items;
}

interface TaskStalls {
  quiet: boolean;
  node: { snapshot: ProgressSnapshot; since: number } | null;
  spot: { at: ActPos; stops: number } | null;
  waits: number;
  refusals: number;
  deaths: DeathCounter | null;
}
const tasks = new Map<string, TaskStalls>();
const fresh = (): TaskStalls => ({ quiet: false, node: null, spot: null, waits: 0, refusals: 0, deaths: null });
function taskOf(taskId: string): TaskStalls {
  let state = tasks.get(taskId);
  if (!state) {
    state = fresh();
    tasks.set(taskId, state);
    if (tasks.size > 32) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}
/** For tests: no task has anything counted, and nobody is watching. */
export function forgetStalls(): void {
  tasks.clear();
  sinks.clear();
}
/** A stall was found: the task counts nothing more (the hold is being made) and starts again from nothing at its resume. */
function found(state: TaskStalls, stall: Stall): Stall {
  const { deaths } = state;
  Object.assign(state, fresh(), { quiet: true, deaths });
  return stall;
}
/** The task was resumed from a hold (or has begun again): it counts again, from nothing; the body's death counter it knew stays (the death it held for is not one again). */
export function resumeStalls(taskId: string): void {
  const state = taskOf(taskId);
  Object.assign(state, fresh(), { deaths: state.deaths });
}
/** Whether the task has found a stall and not been resumed since. */
export function stallQuiet(taskId: string): boolean { return taskOf(taskId).quiet; }

const secondsOf = (ms: number): string => `${Math.round(ms / 1_000)}`;
const placeOf = (at: ActPos): string => `(${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)})`;
const distance = (left: ActPos, right: ActPos): number => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const posOf = (value: unknown): ActPos | null => {
  const at = value as Partial<ActPos> | null | undefined;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
};

/**
 * `node_stalled`: called at each look at the task (a result, a decision's start). `activeMs` is a clock of the task's running time that stands still while it is held (the wall clock
 * less the time held in all, `IncidentHoldPort.heldMs`); the node must not have moved on for `STALL.nodeMs` of it.
 */
export function noteProgress(taskId: string, snapshot: ProgressSnapshot, activeMs: number): Stall | null {
  const state = taskOf(taskId);
  if (state.quiet) return null;
  if (!snapshot.node) {
    state.node = null;
    return null;
  }
  if (!state.node || movedOn(state.node.snapshot, snapshot)) {
    state.node = { snapshot, since: activeMs };
    return null;
  }
  state.node.snapshot = snapshot;
  const idle = activeMs - state.node.since;
  if (idle < STALL.nodeMs) return null;
  return found(state, { kind: 'node_stalled', key: snapshot.node,
    why: `節 ${snapshot.node} が ${secondsOf(idle)} 秒、進みが無い（節の状態 ${snapshot.state ?? '-'}・次の節目 ${snapshot.milestone ?? '-'}・持ち物の合計 ${snapshot.items}）` });
}

// ---- acts that ended -------------------------------------------------------------------------------------------------------------------------------
/**
 * An act of the task ended: its hands (`hands[].do`), the receipt's result (the ActResult JSON) and the command that ran it. Finds `wait_loop` and `same_spot_stops`.
 * A hand that was not run (`not_run`, or its result unknown) is not a stop; a stop with no place of its own is placed where the act ended (`ActResult.at`).
 */
export function noteRan(taskId: string, ran: { hands: ReadonlyArray<{ do?: unknown } | null | undefined>; result: string | undefined; command?: string }): Stall | null {
  const state = taskOf(taskId);
  if (state.quiet) return null;
  // An act that did not run (taken off, dropped behind a stop, its result unknown) is neither a wait nor a move.
  const act = readActResult(ran.result);
  if (!act) return null;
  if (act.lines.some(line => line.end !== 'not_run' && line.end !== 'unknown')) {
    const kinds = ran.hands.map(hand => String(hand?.do ?? ''));
    if (kinds.length > 0 && kinds.every(kind => kind === 'wait')) state.waits += 1;
    else if (kinds.some(kind => MOVING.has(kind))) state.waits = 0;
    if (state.waits >= STALL.waits) return found(state, { kind: 'wait_loop', key: `${state.waits}`, why: `wait だけの act が ${state.waits} 回続いた（間に体を動かす手が無い）` });
  }
  // A-13: a stop counts only when the hand really spent time or work (3 s and more, a step, a dig, a placing): the quick refusal with its mend (dead_end, no_floor, not_started: no path, 0 steps)
  // is not a stop in the same place. A hand of other work that was done in between (it dug, placed, made, smelted, picked up: the pack or the world changed) counts the stops again.
  const running = act.lines.filter(line => line.status !== 'skipped' && line.end !== 'not_run');
  for (const line of act.lines) {
    if (line.end !== 'not_run' && line.end !== 'unknown' && line.goal === 'done' && WORKED.has(String(line.do))) {
      state.spot = null;
      continue;
    }
    if ((line.do !== 'go' && line.do !== 'vertical') || line.end === 'not_run' || line.end === 'unknown' || line.goal === 'unknown') continue;
    if (line.goal !== 'done' && line.goal !== 'already' && !spentTime(line, act.ms, running.length)) continue;
    if (line.goal === 'done' || line.goal === 'already') {
      state.spot = null;
      continue;
    }
    const at = posOf(line.progress?.at) ?? posOf(line.where) ?? posOf(act.at);
    if (!at) continue;
    if (state.spot && distance(state.spot.at, at) <= STALL.spotRadius) state.spot.stops += 1;
    else state.spot = { at, stops: 1 };
    if (state.spot.stops >= STALL.spotStops) {
      const spot = state.spot;
      return found(state, { kind: 'same_spot_stops', key: `${Math.round(spot.at.x)},${Math.round(spot.at.y)},${Math.round(spot.at.z)}`, at: spot.at,
        ...(ran.command ? { command: ran.command } : {}),
        why: `${line.do} が同じ所 ${placeOf(spot.at)} の ${STALL.spotRadius} マス以内で ${spot.stops} 回、done にならず止まった（${line.goal ?? '-'}${line.code ? `・${line.code}` : ''}）` });
    }
  }
  return null;
}

// ---- decisions that went wrong ---------------------------------------------------------------------------------------------------------------------
/**
 * A call of `mc.act` came back: refused by the checks before sending (`refused`) or accepted into the queue. `STALL.refusals` refusals in a row, with no act accepted
 * between, are one decision that does not get through (`decide_error`); the model is asked again after each, so "the same decision" is this run of refusals.
 */
export function noteRefusal(taskId: string, answer: { accepted: true } | { accepted: false; why: string }): Stall | null {
  const state = taskOf(taskId);
  if (state.quiet) return null;
  if (answer.accepted) {
    state.refusals = 0;
    return null;
  }
  state.refusals += 1;
  if (state.refusals < STALL.refusals) return null;
  return found(state, { kind: 'decide_error', key: 'check_refused', why: `送る前の確認が続けて ${state.refusals} 回 act を断った（${answer.why.replace(/\s+/gu, ' ').slice(0, 90)}）` });
}

/**
 * A `redecide` row of the decision record (amendment A-10/A-11, `noteRedecide`): the decision again failed or ran out of time (`why: 'failed'`), or Opus's act was refused by the
 * checks after its mend and the first model's act stood (`why: 'refused'`). Any other row (used, same act, no act, urgent, nothing to count) is not an error.
 */
export function noteRedecide(taskId: string, row: Readonly<Record<string, unknown>>): Stall | null {
  const state = taskOf(taskId);
  if (state.quiet || row.outcome !== 'kept_first') return null;
  const words = (value: unknown) => String(value ?? '').replace(/\s+/gu, ' ').slice(0, 100);
  if (row.why === 'failed') return found(state, { kind: 'decide_error', key: 'redecide_failed', why: `決め直し（Opus）が失敗か時間切れになった（${words(row.failed)}）` });
  if (row.why === 'refused') {
    return found(state, { kind: 'decide_error', key: 'redecide_refused',
      why: `決め直し（Opus）の act が送る前の確認に断られた${row.repairs ? '（書き直しも断られた）' : ''}（${words(row.repairRefusedBy ?? row.refusedBy ?? row.repairFailed)}）` });
  }
  return null;
}

// ---- death -----------------------------------------------------------------------------------------------------------------------------------------
/** The body's death counter in an observation (`state.life`), or null when it has none. */
export function deathCounterOf(observation: { state?: unknown } | null | undefined): { deathEpoch?: unknown; deathSeq?: unknown } | null {
  const life = (observation?.state as { life?: { deathEpoch?: unknown; deathSeq?: unknown } } | undefined)?.life;
  return life && typeof life === 'object' ? life : null;
}
/** `death`: the counter of the newest observation against the one last seen (the first sight only remembers it). A full loss is the same death. */
export function noteDeath(taskId: string, counter: { deathEpoch?: unknown; deathSeq?: unknown } | null): Stall | null {
  const state = taskOf(taskId);
  if (!counter) return null;
  const seen = deathBetween(state.deaths, counter);
  state.deaths = seen.counter;
  if (state.quiet || !seen.death) return null;
  return found(state, { kind: 'death', key: `${seen.counter?.deathEpoch ?? '-'}-${seen.counter?.deathSeq ?? '-'}`.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 40),
    why: `死んだ（死の回数 ${seen.counter?.deathSeq ?? '-'}）` });
}

// ---- who is told -----------------------------------------------------------------------------------------------------------------------------------
type Sink = (stall: Stall) => void;
const sinks = new Map<string, Sink>();
let observing = false;
/**
 * Where a stall found outside the step's own calls goes (the `redecide` rows come from inside the tools): the newest step of the task. One watcher for the process reads the rows.
 * Returns the way to stop watching (a step that has ended).
 */
export function watchStalls(taskId: string, sink: Sink): () => void {
  sinks.set(taskId, sink);
  if (sinks.size > 32) sinks.delete(sinks.keys().next().value as string);
  if (!observing) {
    observing = true;
    onRedecideNote((task, row) => {
      const stall = noteRedecide(task, row);
      if (stall) sinks.get(task)?.(stall);
    });
  }
  return () => { if (sinks.get(taskId) === sink) sinks.delete(taskId); };
}

/**
 * The id of the incident a stall makes (`head:<kind>:<key>:<time>`): the hold's name in the audit, the box's file and the release the resume sends. It is also part of the ids of the commands
 * that name it (`unhold:<id>:…`), and the control refuses a receipt whose command id has anything but letters, digits and `_.:-` (`FCA_BODY_POLL_INVALID`): so no comma, no space.
 */
export function stallIncidentId(stall: Stall, atMs: number): string {
  return `${HEAD_INCIDENT_PREFIX}${stall.kind}:${stall.key.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 40)}:${Math.max(0, Math.floor(atMs)).toString(36)}`;
}
