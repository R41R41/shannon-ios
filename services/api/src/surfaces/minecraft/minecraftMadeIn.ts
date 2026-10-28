import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { BodyRun, LifeView, MadeIn } from '../../contracts/continueContract.js';
import type { FcaDecisionDrift } from '../../mind/action/fca/fcaPorts.js';

/**
 * Which observation a decision read (continue contract 5, 2 章 失効の表): the life, the dimension and its generation, the body's boot and the connection, the head's
 * boot and the observation's number. The commands a decision makes carry **this**, not the newest frame at the moment of sending (a death or a portal in between makes
 * the command stale, and the body knows it only by what the command was made on); a decision's answer is checked against the newest frame just before it is used
 * (`driftOf`). Nothing here decides what to do: it names which frame a thing belongs to.
 */
export type DecisionDrift = FcaDecisionDrift;

/** The observation's `state.life` as the head reads it, or null when it has none (a body before the contract) or it does not read. */
export function lifeViewOf(observation: BodyObservation | null): LifeView | null {
  const life = (observation?.state as { life?: Partial<LifeView> } | undefined)?.life;
  if (!life || typeof life !== 'object' || !Number.isSafeInteger(life.life) || typeof life.dimension !== 'string' || typeof life.dimensionSince !== 'string') return null;
  return life as LifeView;
}
/** The observation's `state.bodyRun` (the body's boot and the connection), or null. */
export function bodyRunOf(observation: BodyObservation | null): BodyRun | null {
  const run = (observation?.state as { bodyRun?: Partial<BodyRun> } | undefined)?.bodyRun;
  return run && typeof run.bodyBoot === 'string' && typeof run.connectionId === 'string' ? run as BodyRun : null;
}
/**
 * The observation a decision read, as the envelope names it (`MadeIn`). Null when the observation has no `state.life` or no `state.bodyRun` (a body before the
 * contract): the command then carries none, and the body refuses one that moves it as `life_missing`.
 */
export function madeInOf(observation: BodyObservation | null, headBoot: string): MadeIn | null {
  const life = lifeViewOf(observation), run = bodyRunOf(observation);
  if (!observation || !life || !run) return null;
  return { life: life.life, dim: life.dimension, dimSince: life.dimensionSince, bodyBoot: run.bodyBoot, connectionId: run.connectionId, headBoot, obsSeq: observation.sequence };
}
/** A command's context with the life it was made for (`life`, `headBoot`, `madeIn`); unchanged when no observation was read (nothing to say). */
export function withMadeIn(context: BodyTaskContext, madeIn: MadeIn | null): BodyTaskContext {
  return madeIn ? { ...context, life: madeIn.life, headBoot: madeIn.headBoot, madeIn } : context;
}
/**
 * Whether what a decision read is no longer the body's now, by the order of the contract's table (the connection first, then the life, then the dimension's
 * generation): the body's boot or connection changed; the life number moved on (a death, or the file made again); the dimension's generation is another (a portal
 * and back is another generation). Null when the newest frame has no life or run to compare, or nothing differs. A different head boot is not told here: the
 * head that read is the head that asks.
 */
export function driftOf(read: MadeIn, now: BodyObservation | null): DecisionDrift | null {
  const life = lifeViewOf(now), run = bodyRunOf(now);
  if (!life || !run) return null;
  if (run.bodyBoot !== read.bodyBoot || run.connectionId !== read.connectionId) return 'connection_changed';
  if (life.life !== read.life) return 'life_changed';
  if (life.dimensionSince !== read.dimSince) return 'dimension_changed';
  return null;
}
