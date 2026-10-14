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
 * judged again and the answer is dropped when its kind changed, the body arrived again (died, respawned), or the frame is old.
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
  let frames = 0, count = 0;
  const stateOf = (bodyId: string, observation: BodyObservation) => {
    const at = now(), arrived = control.arrivedAt(bodyId);
    const earlier = healths.filter(entry => entry.at < at && at - entry.at <= FAST_JUDGMENT_LIMITS.healthWindowMs).map(entry => entry.health);
    return fastBodyState(observation, { earlierHealth: earlier.length ? Math.max(...earlier) : null, sinceArrivalMs: arrived === null ? null : at - arrived });
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

  /** Never a stale answer: the latest frame, judged again, must give the same kind, from the same arrival, and be fresh. */
  const stale = (bodyId: string, decision: FastDecision, arrived: number | null) => {
    const latest = control.observe(bodyId);
    if (!latest || control.arrivedAt(bodyId) !== arrived || now() - Date.parse(latest.stateAt) > FAST_JUDGMENT_LIMITS.maxStateAgeMs) return true;
    const again = fastJudgment(stateOf(bodyId, latest));
    return !('decision' in again) || again.decision.kind !== decision.kind;
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
  const run = async (bodyId: string, decision: FastDecision, entry: ReflexEntryFacts, judged: { arrived: number | null; at: number },
    signal: AbortSignal) => {
    count += 1;
    const sessionId = `${step.id}:fast:${count}`, id = `fast:${hash(sessionId)}`;
    governor.began(step.taskId, now(), entry);
    let effective = false;
    try {
      if (parts.activeAction()) {
        parts.interrupt();
        if (!await settle(bodyId, id, signal)) return parts.hold('fast_skill_busy', { skill: decision.skill });
      }
      if (stale(bodyId, decision, judged.arrived)) {
        effective = true; // A dropped answer did nothing to cool down from.
        parts.log?.(`Shannon Minecraft fast judgment dropped task=${step.taskId} kind=${decision.kind} reason=stale`);
        return parts.hold('fast_stale', { kind: decision.kind });
      }
      if (signal.aborted || !await parts.permit(signal).catch(() => false)) return;
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
        if (!control.store.command(id)) return parts.hold('fast_not_sent', { skill: decision.skill });
        parts.unknown();
        throw error;
      }
      effective = outcome === 'completed';
      parts.log?.(`Shannon Minecraft fast judgment task=${step.taskId} kind=${decision.kind} rule=${decision.rule} skill=${decision.skill}`
        + ` entryToDispatchMs=${Math.max(0, now() - judged.at)} outcome=${outcome}`);
      parts.send(JSON.stringify({ kind: 'body.fast', eventId: sessionId, bodyId, decision: decision.kind, rule: decision.rule,
        skill: decision.skill, outcome }), sessionId);
    } finally { governor.ended(step.taskId, now(), entry, effective); }
  };

  return {
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
        if (verdict.entry) parts.hold(verdict.hold);
        return null;
      }
      frames += 1;
      // Two frames in a row, as for any automatic entry before her first decision: a single frame can be a flicker.
      if (frames < 2) return null;
      const { decision } = verdict, running = defending(state.health, decision);
      if (running) return parts.hold('fca_defending', { skill: running }), null;
      if (!control.frame(bodyId)?.poll.skills?.some(skill => skill.name === decision.skill)) {
        return parts.hold('fast_skill_missing', { skill: decision.skill }), null;
      }
      const nearest = Math.min(...state.threats.map(threat => threat.distance));
      const entry: ReflexEntryFacts = { mode: 'danger', danger: state.healthDropped && state.health !== null
        ? { kind: 'health', value: state.health } : { kind: 'threat', value: Number.isFinite(nearest) ? nearest : 0 } };
      const admission = governor.admit(step.taskId, now(), entry);
      if (!admission.admit) return parts.hold(admission.reason, { mode: 'danger' }), null;
      if (!live()) return null;
      frames = 0;
      return run(bodyId, decision, entry, { arrived: control.arrivedAt(bodyId), at: now() }, signal);
    },
  };
}
