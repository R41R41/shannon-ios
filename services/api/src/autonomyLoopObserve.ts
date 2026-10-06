import { autonomyDayKey } from './mind/inhibition/autonomyBudget.js';
import { reachOutWait } from './autonomyLoopConfig.js';
import type { ObservedReachOutReason, ReachOutAppSurface, ReachOutCallOutcome, ReachOutDeliveryOutcome, ReachOutFacts, StepObservation } from './autonomyLoopObservations.js';
import { sessionOf } from './autonomyLoopPacing.js';
import type { AutonomyLoopCycle, AutonomyLoopStep, AutonomyPlannedStep } from './autonomyLoopState.js';
import type { StepDependencies, StepResult } from './autonomyLoopSteps.js';

/**
 * Act, observe, think again (owner decision 2026-10-02).
 *
 * After a step, what it led to is kept as an observation: closed facts, never words. After a
 * message of hers the step stays open for a short while and gathers only this: whether the
 * owner wrote or spoke afterwards (a yes or no and the seconds, from timestamps), what her
 * body reported about showing the message, and what the server already knows of the body
 * (her window showing, the owner away or back, others present). An outcome that could change
 * her plan puts one more thinking step at the front of the plan, a bounded number of times.
 *
 * While a step waits it renews the runner's lease and heartbeat at every look (`renew`), so the wait
 * may be longer than the lease and the owner's screens keep saying 動いています.
 *
 * `SHANNON_AUTONOMY_MAX_FOLLOW_UPS=0` switches all of it off: no wait, no observation, no
 * second thinking step, and every prompt is what it was. This file names interfaces only.
 *
 * In a session (`autonomyLoopPacing.ts`) a step's outcome is kept as an observation whatever that switch says,
 * because thinking again is how a session goes on, and a session thinks again as long as it has steps left
 * instead of a fixed number of times. The wait after a message and the second call stay behind the switch.
 */
export interface AutonomyReachOutObserver {
  /** What her body reported about this message, or null while none has. */
  delivery(scopeKey: string, initiativeId: string): ReachOutDeliveryOutcome | null;
  /** Which of the owner's apps reported that delivery, when one did: it spoke the message through his earphones. */
  surface?(scopeKey: string, initiativeId: string): ReachOutAppSurface | null;
  /** What became of the call the server placed with this message, when it rang his iPhone; null when it did not, or it still rings. */
  call?(scopeKey: string, initiativeId: string): ReachOutCallOutcome | null;
  /** What the server already knows of her body at this moment. */
  body(scopeKey: string, at: string): Pick<ReachOutFacts, 'windowVisible' | 'owner' | 'others'>;
}

/** The pause between two looks at whether he answered. */
export const REACH_OUT_OBSERVE_POLL_MILLISECONDS = 5_000;
const NO_BODY: Pick<ReachOutFacts, 'windowVisible' | 'owner' | 'others'> = Object.freeze({ windowVisible: false, owner: 'unknown', others: false });

/** Whether the mechanism is on at all. Off restores the loop as it was before it existed. */
export function agenticLoop(dependencies: Pick<StepDependencies, 'config'>): boolean {
  return dependencies.config.maximumReachOutFollowUpsPerDay > 0;
}

/** When the owner first wrote or spoke after the instant, or null. Only a timestamp leaves the store. */
export function ownerRepliedAt(dependencies: StepDependencies, scopeKey: string, after: string): string | null {
  try {
    const { showing } = dependencies;
    if (showing.ownerFirstActiveAfter) return showing.ownerFirstActiveAfter(scopeKey, after);
    // An older showing desk answers only yes or no; the moment is then not known.
    return showing.ownerActiveSince(scopeKey, new Date(Date.parse(after) + 1).toISOString()) ? after : null;
  } catch { return null; }
}

/**
 * Stays with a message she just sent until the owner answers, the wait runs out, the owner pauses her,
 * or the process is asked to stop, then says what was seen. It always returns, and it reads no content.
 */
export async function observeReachOut(
  dependencies: StepDependencies, scopeKey: string,
  sent: { id: string; at: string; reason: ObservedReachOutReason }, options: { wait: boolean; signal?: AbortSignal },
): Promise<ReachOutFacts> {
  const { loop, observer, store } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const pause = dependencies.wait ?? sleep;
  const limit = options.wait ? reachOutWait(loop) : 0;
  let repliedAt = ownerRepliedAt(dependencies, scopeKey, sent.at);
  let at = now();
  // The wait is part of the step, so the runner keeps its lease and its heartbeat while it waits; a lost lease ends the wait.
  const held = () => { try { return dependencies.renew?.() ?? true; } catch { return false; } };
  while (!repliedAt && held() && Date.parse(at) - Date.parse(sent.at) < limit && !options.signal?.aborted) {
    let paused = true;
    try { paused = store.control(scopeKey).paused; } catch { paused = true; }
    if (paused) break;
    const left = limit - (Date.parse(at) - Date.parse(sent.at));
    try { await pause(Math.min(REACH_OUT_OBSERVE_POLL_MILLISECONDS, Math.max(1, left)), options.signal); } catch { break; }
    at = now();
    repliedAt = ownerRepliedAt(dependencies, scopeKey, sent.at);
  }
  let delivery: ReachOutDeliveryOutcome | null = null;
  let body = NO_BODY;
  let surface: ReachOutAppSurface | null = null;
  try { delivery = observer?.delivery(scopeKey, sent.id) ?? null; } catch { delivery = null; }
  try { surface = delivery ? observer?.surface?.(scopeKey, sent.id) ?? null : null; } catch { surface = null; }
  let call: ReachOutCallOutcome | null = null;
  try { call = observer?.call?.(scopeKey, sent.id) ?? null; } catch { call = null; }
  try { body = observer?.body(scopeKey, at) ?? NO_BODY; } catch { body = NO_BODY; }
  const seconds = (until: string) => Math.max(0, Math.round((Date.parse(until) - Date.parse(sent.at)) / 1_000));
  return {
    id: sent.id, reason: sent.reason, sentAt: sent.at, waitedSeconds: seconds(repliedAt ?? at),
    replied: repliedAt !== null, ...(repliedAt ? { repliedAfterSeconds: seconds(repliedAt) } : {}),
    delivery: delivery ?? 'unknown', ...(surface ? { surface } : {}), ...(call ? { call } : {}), windowVisible: body.windowVisible, owner: body.owner, others: body.others,
  };
}

/** Second calls she may still make today, or 0 while they are switched off or used up. */
export function followUpsRemaining(dependencies: StepDependencies, scopeKey: string, at: string): number {
  const { reachOuts, config } = dependencies;
  if (!reachOuts?.followUpsOn || !agenticLoop(dependencies)) return 0;
  try { return Math.max(0, config.maximumReachOutFollowUpsPerDay - reachOuts.followUpsOn(scopeKey, autonomyDayKey(at, config))); } catch { return 0; }
}

/** Where a cycle stands with a message of hers that got no answer. */
export interface ReachOutChain {
  /** The message of this cycle that was sent, not answered during the wait, and not followed up. */
  pending: ReachOutFacts;
  ordinal: number;
  /** A look was already taken, or tried, after it. */
  looked: boolean;
}

/** The unanswered message of this cycle, if there is one that she has not already called after. */
export function reachOutChain(observations: readonly StepObservation[]): ReachOutChain | null {
  const sent = [...observations].reverse().find(item => item.step === 'reach_out' && item.outcome === 'done' && item.reachOut && item.reachOut.reason !== 'follow_up');
  if (!sent?.reachOut || sent.reachOut.replied || sent.reachOut.unwatched) return null;
  const later = observations.filter(item => item.ordinal > sent.ordinal);
  // A second call that was asked for, whatever came of it, ends the chain: one per message.
  if (later.some(item => item.step === 'reach_out')) return null;
  return { pending: sent.reachOut, ordinal: sent.ordinal, looked: later.some(item => item.step === 'look') };
}

/** Thinking steps this cycle has begun. */
export function thinkingSteps(dependencies: StepDependencies, cycleId: string): number {
  return dependencies.store.loop.steps(cycleId).filter(step => step.step.kind === 'think').length;
}

/** Whether this cycle may think once more: the mechanism is on, a thinking step is left, and so is room for a step after it. */
export function mayThinkAgain(dependencies: StepDependencies, cycle: AutonomyLoopCycle, stepsTaken: number): boolean {
  const { loop } = dependencies;
  if (sessionOf(dependencies, cycle)) return loop.maximumStepsPerSession - stepsTaken >= 2;
  return agenticLoop(dependencies) && cycle.kind === 'activity' && loop.maximumRethinksPerCycle > 0
    && loop.maximumStepsPerCycle - stepsTaken >= 2
    && thinkingSteps(dependencies, cycle.id) < 1 + loop.maximumRethinksPerCycle;
}

/** An outcome she should see before going on: a step that did not happen, a message nobody answered, a look she took to find out. */
function worthThinkingAbout(step: AutonomyPlannedStep, observation: Pick<StepObservation, 'outcome' | 'code' | 'reachOut'>): boolean {
  if (step.kind === 'think') return false;
  // He is talking, or he answered: she stays out of it and the plan goes on.
  if (observation.code === 'conversation_in_progress' || observation.code === 'replied') return false;
  if (observation.outcome !== 'done') return true;
  if (observation.reachOut) return !observation.reachOut.replied && !observation.reachOut.unwatched && observation.reachOut.reason !== 'follow_up';
  return step.kind === 'look' && step.chain === true;
}

/**
 * Keeps what a step led to and decides whether she thinks again. Returns the plan with a thinking step at its
 * front when she does, otherwise null. Called inside the transaction that closes the step, so the observation,
 * the record entry and the plan appear together. With the mechanism off it does nothing.
 */
export function observeStep(
  dependencies: StepDependencies, cycle: AutonomyLoopCycle, row: Pick<AutonomyLoopStep, 'ordinal' | 'step'>,
  outcome: { outcome: 'done' | 'failed' | 'refused'; code?: string; observed?: StepResult['observed'] },
  remaining: readonly AutonomyPlannedStep[], at: string,
): AutonomyPlannedStep[] | null {
  if (cycle.kind !== 'activity' || row.step.kind === 'think' || row.step.kind === 'rest') return null;
  if (!agenticLoop(dependencies) && !sessionOf(dependencies, cycle)) return null;
  const observation = {
    cycleId: cycle.id, ordinal: row.ordinal, step: row.step.kind, outcome: outcome.outcome,
    ...(outcome.code ? { code: outcome.code } : {}), ...(row.step.chain ? { chain: true } : {}),
    ...(outcome.observed ? { reachOut: outcome.observed } : {}),
  };
  dependencies.store.loop.observations.add(cycle.scopeKey, observation, at);
  // Syzygy ADR-0006 stage 1: the prediction shadow is handed what followed a message of hers and returns nothing.
  if (outcome.observed) { try { dependencies.prediction?.reachOut(cycle.scopeKey, outcome.observed, at); } catch { /* the shadow never stops a step */ } }
  if (!worthThinkingAbout(row.step, observation) || remaining[0]?.kind === 'think') return null;
  return mayThinkAgain(dependencies, cycle, row.ordinal + 1) ? [{ kind: 'think', again: true }, ...remaining] : null;
}

/**
 * A step that a stopped process left open after its message was already written: the message was sent, and only what
 * followed is unknown. Returns what to record instead of a failure, or null when no message of that step exists.
 */
export function sentBeforeStop(dependencies: StepDependencies, scopeKey: string, step: Pick<AutonomyLoopStep, 'step' | 'createdAt'>): ReachOutFacts | null {
  if (!agenticLoop(dependencies) || step.step.kind !== 'reach_out' || !step.step.reason || !step.createdAt) return null;
  let latest: { id: string; at: string; reason?: string } | null = null;
  try { latest = dependencies.reachOuts?.latest?.(scopeKey) ?? null; } catch { latest = null; }
  if (!latest || latest.at < step.createdAt || (latest.reason === 'follow_up') !== (step.step.reason === 'follow_up')) return null;
  return {
    id: latest.id, reason: step.step.reason, sentAt: latest.at, waitedSeconds: 0, replied: false, delivery: 'unknown',
    windowVisible: false, owner: 'unknown', others: false, unwatched: true,
  };
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('ABORTED')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error('ABORTED')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
