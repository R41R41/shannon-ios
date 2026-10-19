import { createHash } from 'node:crypto';
import type { TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import { createFastJudgmentMemory, type ReflexEntryFacts, type ReflexGovernor } from '../../mind/action/reflex/reflexGovernor.js';
import {
  DEFENSIVE_SKILLS, FAST_JUDGMENT_LIMITS, fastBodyState, fastJudgment, fastSkillMilliseconds, type FastDecision,
} from '../../mind/action/reflex/fastJudgment.js';
import type { MinecraftControl } from './minecraftControl.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** How long a cut-off FCA skill may take to settle before the fast skill is sent (the body runs one skill at a time). */
const SETTLE_MILLISECONDS = 2_000;
/** Fast skills that cut off her tool and did nothing, within `restMs`, after which a judgment that may wait leaves her tool alone. */
const INTERRUPT_BUDGET = 2;
const CAGE_SKILL = 'build-around-self';

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
  let frames = 0, lastKind: FastDecision['kind'] | null = null, count = 0;
  /**
   * The task's memory across its steps (the governor's, `FastJudgmentMemory`): a fast skill that failed rests `restMs`, and the
   * interrupts of her tools spent for nothing. Before run 16 a failed shelter was forgotten as soon as one frame showed no danger (the
   * zombie at the edge of the range came and went), and at every new step: the same `dig-shelter` failed six times in 30 s on the
   * same air under the hole. A new arrival (a respawn elsewhere) ends both.
   */
  const memory = governor.fast ?? createFastJudgmentMemory();
  /** Dropped answers by reason (`stale`, `busy`, `not_sent`, `not_permitted`); also named in every hold's detail. */
  const discards = { stale: 0, busy: 0, not_sent: 0, not_permitted: 0 };
  const rest = (skill: string) => memory.rest(step.taskId, skill, now() + FAST_JUDGMENT_LIMITS.restMs);
  const spend = () => memory.spend(step.taskId, now());
  const stateOf = (bodyId: string, observation: BodyObservation) => {
    const at = now(), arrived = control.arrivedAt(bodyId);
    const earlier = healths.filter(entry => entry.at < at && at - entry.at <= FAST_JUDGMENT_LIMITS.healthWindowMs).map(entry => entry.health);
    memory.arrival(step.taskId, arrived);
    // A skill the body does not offer now is never chosen as the next move (the cage of a resting shelter, on an older body).
    const resting = memory.resting(step.taskId, at);
    if (!hasSkill(bodyId, CAGE_SKILL)) resting.add(CAGE_SKILL);
    return fastBodyState(observation, { earlierHealth: earlier.length ? Math.max(...earlier) : null, sinceArrivalMs: arrived === null ? null : at - arrived,
      resting });
  };
  /**
   * Her tool is not cut off again for a judgment that may wait: run 16's six failed shelters cut off four `mine-block`s. Health at
   * the floor of the rules, or falling, always may.
   */
  const interruptsSpent = (state: ReturnType<typeof stateOf>) => memory.spent(step.taskId, now(), FAST_JUDGMENT_LIMITS.restMs) >= INTERRUPT_BUDGET
    && !state.healthDropped && (state.health ?? 0) > FAST_JUDGMENT_LIMITS.lowHealth;
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

  /** Cut off before its time was up (cancelled), or by the body's own reflex (`interrupted_by_reflex`, whenever it came). */
  const isCutOff = (outcome: string, byReflex: boolean, elapsed: number, skill: string) =>
    byReflex || (outcome === 'cancelled' && elapsed < fastSkillMilliseconds(skill));
  const reflexTag = (byReflex: boolean) => byReflex ? ' reflexCut=true' : '';
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
    if (again.decision.kind === decision.kind && again.decision.skill === decision.skill) return again.decision;
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
  /**
   * The end of a sent fast skill: its rest, the interrupt it spent, and its line. A skill cut off before its time was up (the FCA's own
   * interrupt cancels the command) did not fail: only a refusal, a failure or a run to its deadline does. The design only says "if
   * hiding failed, flee next" and does not cover interrupts. So is one the body's own reflex took the body from (a meal, a step back
   * from a creeper: `interrupted_by_reflex`, whatever the time): the body defended itself, and the skill did not fail. No cooldown
   * either (the caller's): the reflex answered the danger, and the judgment is free to look at it again once the body's floor lets go
   * (`floor_active` holds it until then). A shelter that ran to its deadline rests too; a fight that did (it was still hitting) does
   * not: only its refusal or failure.
   */
  const settled = (decision: FastDecision, sent: { outcome: string; failureType: string; byReflex: boolean; interrupted: boolean; sentAt: number;
    judgedAt: number }) => {
    const { outcome, byReflex, sentAt } = sent, effective = outcome === 'completed';
    const cutOff = isCutOff(outcome, byReflex, now() - sentAt, decision.skill);
    // Spent for nothing: not done, not a fight that hit until its deadline, not the body's own reflex taking over.
    const fought = decision.kind === 'fight' && outcome === 'cancelled' && !cutOff;
    if (sent.interrupted && !effective && !fought && !byReflex) spend();
    const failed = decision.kind === 'shelter' ? !effective && !cutOff : outcome === 'failed' && !byReflex;
    if (failed) rest(decision.skill);
    parts.log?.(`Shannon Minecraft fast judgment task=${step.taskId} kind=${decision.kind} rule=${decision.rule} skill=${decision.skill}`
      + ` entryToDispatchMs=${Math.max(0, sentAt - sent.judgedAt)} runMs=${Math.max(0, now() - sentAt)} outcome=${outcome}`
      + ` failure=${sent.failureType}${failed ? ` restMs=${FAST_JUDGMENT_LIMITS.restMs}` : ''}${sent.interrupted ? ' cut=true' : ''}${reflexTag(byReflex)}`);
  };
  const run = async (bodyId: string, first: FastDecision, entry: ReflexEntryFacts, judged: { arrived: number | null; at: number },
    signal: AbortSignal) => {
    count += 1;
    const sessionId = `${step.id}:fast:${count}`, id = `fast:${hash(sessionId)}`;
    governor.began(step.taskId, now(), entry);
    let effective = false, decision = first, cooldown = true, interrupted = false, sentAt = now();
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
        interrupted = true;
        parts.interrupt();
        // Her tool was cut off by now: a drop here keeps the full cooldown (the flicker guard above), or the next frames would cut off
        // another one; and the interrupt was spent for nothing.
        if (!await settle(bodyId, id, signal)) return spend(), discard('busy', 'fast_skill_busy', { skill: decision.skill });
        const after = rejudged(bodyId, decision, judged.arrived);
        if (!after) return spend(), discard('stale', 'fast_stale', { kind: decision.kind });
        decision = after;
      }
      if (signal.aborted || !await parts.permit(signal).catch(() => false)) {
        discards.not_permitted += 1;
        return;
      }
      parts.touched();
      parts.stepOutcome('unknown');
      let outcome: string, byReflex = false, failureType = '-';
      // The entry's time to the command (run 16 logged it after the skill had run, so a 15 s fight read as a 15 s wait to start).
      sentAt = now();
      try {
        const receipt = await control.command({ id, context: parts.context(bodyId, sessionId), lease: step.lease, kind: 'skill',
          skill: decision.skill, arguments: decision.arguments, milliseconds: fastSkillMilliseconds(decision.skill) }, signal);
        outcome = receipt.outcome;
        byReflex = receipt.failureType === 'interrupted_by_reflex';
        if (typeof receipt.failureType === 'string' && /^[a-z_]{1,40}$/u.test(receipt.failureType)) failureType = receipt.failureType;
        parts.stepOutcome('acknowledged');
      } catch (error) {
        // Never sent (the body went away, the lease moved): nothing happened. Sent and lost: unknown, as any body command.
        if (!control.store.command(id)) return discard('not_sent', 'fast_not_sent', { skill: decision.skill });
        if (decision.kind === 'shelter') rest(decision.skill);
        if (interrupted) spend();
        parts.unknown();
        throw error;
      }
      effective = outcome === 'completed';
      cooldown = !byReflex;
      settled(decision, { outcome, failureType, byReflex, interrupted, sentAt, judgedAt: judged.at });
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
        // A frame with no danger does not end a rest (`rests`): the same air is under the same hole a frame later.
        if (verdict.entry) parts.hold(verdict.hold);
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
      if (parts.activeAction() && interruptsSpent(state)) {
        return parts.hold('fast_interrupts_spent', { skill: decision.skill }), null;
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
