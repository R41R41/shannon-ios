import { createHash } from 'node:crypto';
import type { BodyTaskContext } from '../contracts/bodyControlContract.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import { minecraftTaskContext } from './fcaMinecraftTools.js';
import { takeOfResult, type IncidentTake } from './minecraftIncidentHold.js';

/**
 * Amendment A-12 (the body's type): a stall the head found is held on the body's side too, so that the world
 * stands still, the scene
 * is saved and the box has the head's notes.
 * The head asks with a release that carries `context.incident.take = { id, why, notes }` (the id is the head's, `head:<kind>:…`),
 * and the body answers in the receipt's result
 * (`{"incident": {"op": "take", ...}}`, `takeOfResult`): the order on its side is `/tick freeze`, the scene, the
 * box (kind `head`),
 * then its hold file; a world it cannot stop is not
 * held (`notHeld`) and only the box and the scene are taken.
 *
 * A release closes the session it names (the body refuses later commands of a closed session as
 * `BODY_COMMAND_REFUSED`), so the take
 * is sent in a session of its own, as a cleanup's
 * stop is (`cleanup:<hash>`): the step's session stays what it was, and no act of the step shares a session with
 * a release. The acts
 * of a task that was resumed come from a new
 * step, whose session is its own id (`minecraftTaskContext`'s default), never the one a release (the take, the
 * resume's) has closed.
 */
export const TAKE_MS = 8_000;
/** The most notes a take carries, and the longest one (the body cuts at the same bounds). */
export const TAKE_NOTES = 20, TAKE_NOTE_CHARS = 400;
/** The session a take is sent in: of its own, from the incident's id. */
export const takeSession = (incident: string): string => `take:${createHash('sha256').update(incident).digest('hex').slice(0, 16)}`;

export type TakeAnswer = { sent: true; take: IncidentTake } | { sent: false; why: string };

/** The release's context for a take: the step's task, body and lease, a session of its own, and the take. */
export function takeContext(step: TaskStep, bodyId: string, take: { id: string; why: string; notes: readonly string[] }): BodyTaskContext {
  const notes = take.notes.slice(-TAKE_NOTES).map(note => note.slice(0, TAKE_NOTE_CHARS));
  return { ...minecraftTaskContext(step, bodyId, takeSession(take.id)), incident: { take: { id: take.id.slice(0, 150), why: take.why.slice(
    0, 300), ...(notes.length ? { notes } : {}) } } };
}

/**
 * Asks the body to hold. Never throws: a body that is away, a lease gone, a receipt that does not come or
 * carries no answer (a body before the take: it says nothing of
 * `incident`) is `sent: false` with the reason, and the head holds on its own as it did.
 */
export async function headTake(parts: { control: MinecraftControl; step: TaskStep; bodyId: string; id: string; why: string; notes:
   readonly string[] }, signal?: AbortSignal): Promise<TakeAnswer> {
  const { control, step } = parts;
  const context = takeContext(step, parts.bodyId, { id: parts.id, why: parts.why, notes: parts.notes });
  const command = `take:${createHash('sha256').update(parts.id).digest('hex').slice(0, 16)}`;
  try {
    const receipt = await control.command({ id: command, context, lease: step.lease, kind: 'release', stop: { context, requestId: command,
       reason: 'cancel' }, milliseconds: TAKE_MS }, signal);
    const take = takeOfResult(receipt.result);
    return take ? { sent: true, take } : { sent: false, why: `体が take に答えなかった（${receipt.outcome}。古い体は incident を言わない）` };
  } catch (error) {
    return { sent: false, why: error instanceof Error ? error.message.slice(0, 120) : 'unknown' };
  }
}
