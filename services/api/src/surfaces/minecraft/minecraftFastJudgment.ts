import { createHash } from 'node:crypto';
import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { ReflexEntryFacts, ReflexGovernor } from '../../mind/action/reflex/reflexGovernor.js';
import {
  DEFENSIVE_SKILLS, FAST_JUDGMENT_LIMITS, fastBodyState, fastJudgment, fastSkillMilliseconds, type FastDecision,
} from '../../mind/action/reflex/fastJudgment.js';
import type { MinecraftControl } from './minecraftControl.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** How long a cut-off FCA skill may take to settle before the fast skill is sent (the body runs one skill at a time). */
const SETTLE_MILLISECONDS = 2_000;

/**
 * One step's image-free fast judgment (Syzygy ADR-0011 stage 2, `fastJudgment.ts`): on each new frame it may start one bounded body
 * skill under the step's own lease. The adapter keeps the job as its active session, so a decision made meanwhile is judged stale
 * (`touched`) and tools started meanwhile are cut off. A stale answer is never sent: just before the command, the latest frame is
 * judged again: the answer sent is that judgment's, and nothing is sent when the body arrived again (died, respawned), the frame is
 * old, or the latest frame calls for no action.
 */
export function createMinecraftFastJudgment(parts: {
  control: MinecraftControl; step: TaskStep; governor: ReflexGovernor; now(): number;
  context(bodyId: string, sessionId: string): BodyTaskContext;
  /** The step's lease, owner and sources still current, with the body resource permit. */
  permit(signal: AbortSignal): Promise<boolean>;
  activeAction(): { name: string } | undefined;
  /** Cuts off the FCA's body tools in flight. */
  interrupt(): void;
  /** The body was touched: a decision made meanwhile is stale. */
  touched(): void;
  stepOutcome(value: 'unknown' | 'acknowledged'): void;
  unknown(): void;
  send(text: string, id: string): void;
  hold(reason: string, detail?: Record<string, string | number | boolean | null>): void;
  log?(line: string): void;
}) {
  const { control, step, governor, now } = parts;
  const healths: Array<{ at: number; health: number }> = [];
  let frames = 0, lastKind: FastDecision['kind'] | null = null, count = 0, shelterFailed = false, episodeArrival: number | null = null;
  /** Dropped answers by reason (`stale`, `busy`, `not_sent`, `not_permitted`); also named in every hold's detail. */
  const discards = { stale: 0, busy: 0, not_sent: 0, not_permitted: 0 };
  const stateOf = (bodyId: string, observation: BodyObservation) => {
    const at = now(), arrived = control.arrivedAt(bodyId);
    const earlier = healths.filter(entry => entry.at < at && at - entry.at <= FAST_JUDGMENT_LIMITS.healthWindowMs).map(entry => entry.health);
    // A failed shelter belongs to one danger episode of one life: a new arrival ends it (`consider` ends it when the danger passes).
    if (episodeArrival !== arrived) {
      shelterFailed = false;
      episodeArrival = arrived;
    }
    return fastBodyState(observation, { earlierHealth: earlier.length ? Math.max(...earlier) : null, sinceArrivalMs: arrived === null ? null : at - arrived,
      shelterFailed });
  };
  const remember = (observation: BodyObservation) => {
    const health = (observation.state.world as { health?: unknown } | undefined)?.health;
    const at = now();
    if (typeof health === 'number' && Number.isFinite(health) && health > 0) healths.push({ at, health });
    while (healths.length && at - healths[0]!.at > FAST_JUDGMENT_LIMITS.healthWindowMs * 2) healths.shift();
  };
  const pendingSkill = (bodyId: string, own: string) => control.store.pending(bodyId)
    .some(row => row.command.context.taskId === step.taskId && row.command.kind === 'skill' && row.command.id !== own);
  const settle = async (bodyId: string, own: string, signal: AbortSignal) => {
    const until = now() + SETTLE_MILLISECONDS;
    while (pendingSkill(bodyId, own) && now() < until && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 25));
    return !pendingSkill(bodyId, own);
  };

  const hasSkill = (bodyId: string, skill: string) => !!control.frame(bodyId)?.poll.skills?.some(entry => entry.name === skill);
  /**
   * Never a stale answer: the latest frame is judged again, must be from the same arrival and fresh, and still call for an action.
   * That answer is the one to send (run 12: a `fight` judged while zombies attacked was dropped because the latest frame said
   * otherwise, nothing reached the body and she died twice; the latest frame is the more current). Null when nothing may be sent.
   * Freshness is the API's own receive time (`receivedAt`): the body's `stateAt` runs on its clock, which the validation lets differ
   * by 30 s.
   */
  const rejudged = (bodyId: string, decision: FastDecision, arrived: number | null): FastDecision | null => {
    const latest = control.observe(bodyId);
    if (!latest || control.arrivedAt(bodyId) !== arrived || now() - Date.parse(latest.receivedAt) > FAST_JUDGMENT_LIMITS.maxStateAgeMs) return null;
    const state = stateOf(bodyId, latest), again = fastJudgment(state);
    if (!('decision' in again)) return null;
    if (again.decision.kind === decision.kind) return again.decision;
    // A new kind skips what `consider` checked for the first kind: its skill must exist on the body (else nothing is sent), and it
    // must not cut off a defensive skill of hers either.
    return hasSkill(bodyId, again.decision.skill) && !defending(state.health, again.decision) ? again.decision : null;
  };
  /**
   * A defensive skill of hers keeps running (run 11: a reflex stopped her fight and she died standing), unless her health is at the
   * floor of the rules and the judgment would take her out of the fight.
   */
  const defending = (health: number | null, decision: FastDecision) => {
    const running = parts.activeAction()?.name.replace(/^mc\./u, '');
    if (!running || !DEFENSIVE_SKILLS.has(running)) return null;
    return (health ?? 0) <= 6 && decision.kind !== 'fight' && running.startsWith('attack') ? null : running;
  };
  const run = async (bodyId: string, first: FastDecision, entry: ReflexEntryFacts, judged: { arrived: number | null; at: number },
    signal: AbortSignal) => {
    count += 1;
    const sessionId = `${step.id}:fast:${count}`, id = `fast:${hash(sessionId)}`;
    governor.began(step.taskId, now(), entry);
    let effective = false, decision = first, cooldown = true;
    const sentAt = now();
    /** A dropped answer did not do what a cooldown would be for in the success case: it waits `dangerCooldownMs` like any ineffective session. */
    const discard = (reason: keyof typeof discards, hold: string, detail: Record<string, string | number | boolean | null>) => {
      discards[reason] += 1;
      parts.log?.(`Shannon Minecraft fast judgment dropped task=${step.taskId} kind=${decision.kind} reason=${reason} discards=${discards[reason]}`);
      return parts.hold(hold, { ...detail, discards: discards[reason] });
    };
    try {
      // Before cutting anything off: an answer already stale interrupts nothing (an enemy at the edge of a threshold flipping the
      // judgment every other frame once cut off her move-to each time and sent nothing).
      // Nothing was cut off and nothing sent here, so there is no cooldown to wait for: the next frames may judge again at once.
      const before = rejudged(bodyId, decision, judged.arrived);
      if (!before) {
        cooldown = false;
        return discard('stale', 'fast_stale', { kind: decision.kind });
      }
      decision = before;
      if (parts.activeAction()) {
        parts.interrupt();
        if (!await settle(bodyId, id, signal)) return discard('busy', 'fast_skill_busy', { skill: decision.skill });
        // Her tool was cut off by now: a drop here keeps the full cooldown (the flicker guard above), or the next frames would cut off
        // another one.
        const after = rejudged(bodyId, decision, judged.arrived);
        if (!after) return discard('stale', 'fast_stale', { kind: decision.kind });
        decision = after;
      }
      if (signal.aborted || !await parts.permit(signal).catch(() => false)) {
        discards.not_permitted += 1;
        return;
      }
      parts.touched();
      parts.stepOutcome('unknown');
      let outcome: string;
      try {
        const receipt = await control.command({ id, context: parts.context(bodyId, sessionId), lease: step.lease, kind: 'skill',
          skill: decision.skill, arguments: decision.arguments, milliseconds: fastSkillMilliseconds(decision.skill) }, signal);
        outcome = receipt.outcome;
        parts.stepOutcome('acknowledged');
      } catch (error) {
        // Never sent (the body went away, the lease moved): nothing happened. Sent and lost: unknown, as any body command.
        if (!control.store.command(id)) return discard('not_sent', 'fast_not_sent', { skill: decision.skill });
        if (decision.kind === 'shelter') shelterFailed = true;
        parts.unknown();
        throw error;
      }
      effective = outcome === 'completed';
      // A shelter cut off before its time was up (the FCA's own interrupt cancels the command) did not fail: only a refusal, a failure
      // or a run to its deadline does. The design only says "if hiding failed, flee next" and does not cover interrupts.
      const cutOff = outcome === 'cancelled' && now() - sentAt < fastSkillMilliseconds(decision.skill);
      if (decision.kind === 'shelter') shelterFailed = !effective && !cutOff;
      parts.log?.(`Shannon Minecraft fast judgment task=${step.taskId} kind=${decision.kind} rule=${decision.rule} skill=${decision.skill}`
        + ` entryToDispatchMs=${Math.max(0, now() - judged.at)} outcome=${outcome}`);
      parts.send(JSON.stringify({ kind: 'body.fast', eventId: sessionId, bodyId, decision: decision.kind, rule: decision.rule,
        skill: decision.skill, outcome }), sessionId);
    } finally { governor.ended(step.taskId, now(), entry, effective, cooldown); }
  };

  return {
    /** How many answers were dropped, by reason. */
    discarded: () => ({ ...discards }),
    /**
     * Judges a new frame; returns the job when it starts one. `live` is asked last, once a skill could start (it can walk sources).
     * Danger is never left to the image reflex while this is on: a frame the judgment holds starts nothing.
     */
    consider(bodyId: string, observation: BodyObservation, live: () => boolean, signal: AbortSignal): Promise<void> | null {
      const state = stateOf(bodyId, observation);
      remember(observation);
      const verdict = fastJudgment(state);
      if (!('decision' in verdict)) {
        frames = 0;
        lastKind = null;
        if (verdict.entry) parts.hold(verdict.hold);
        else shelterFailed = false; // The danger passed: the next one is a new episode.
        return null;
      }
      // Consecutive frames of the same choice: a kind that changes (shelter, then fight) is a flicker and starts the count again.
      frames = lastKind === verdict.decision.kind ? frames + 1 : 1;
      lastKind = verdict.decision.kind;
      // Two frames in a row, as for any automatic entry before her first decision: a single frame can be a flicker.
      if (frames < 2) return null;
      const { decision } = verdict, running = defending(state.health, decision);
      if (running) return parts.hold('fca_defending', { skill: running }), null;
      if (!hasSkill(bodyId, decision.skill)) {
        return parts.hold('fast_skill_missing', { skill: decision.skill }), null;
      }
      const nearest = Math.min(...state.threats.map(threat => threat.distance));
      const entry: ReflexEntryFacts = { mode: 'danger', danger: state.healthDropped && state.health !== null
        ? { kind: 'health', value: state.health } : { kind: 'threat', value: Number.isFinite(nearest) ? nearest : 0 } };
      const admission = governor.admit(step.taskId, now(), entry);
      if (!admission.admit) return parts.hold(admission.reason, { mode: 'danger' }), null;
      if (!live()) return null;
      frames = 0;
      lastKind = null;
      return run(bodyId, decision, entry, { arrived: control.arrivedAt(bodyId), at: now() }, signal);
    },
  };
}
