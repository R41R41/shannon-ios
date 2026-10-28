/**
 * The fix run's hold, as the Minecraft step sees it (2026-10-28, owner: 「止めて直す実走（保留と再開、世界を止める、台で再現→直す→その場で確かめる）」).
 *
 * - An operator's request made with `--hold-on-failure` sends its acts with `context.incident.hold`: on a heavy failure the body writes its black box
 *   and the scene, stops the world (`/tick freeze`, never with anyone else on the server) and says so in the act's receipt (`incident`). A world
 *   it cannot stop is not held (run 44): the receipt says why (`notHeld`), the step writes it down (`notHeld`) and the task goes on.
 * - The step reads that receipt (`noteReceipt`) and asks the operator's service to hold the task (`hold`): audited, and stopped through the owner's
 *   stop path, so no decision is made, no model is called and nothing is counted while it waits; the plan, the pack and the task stay as they are.
 * - The operator's `resume` queues the task again. Its first step sends the act that failed once more with the same arguments and
 *   `context.incident.resume` (the body moves the world again and runs it), writes what it did, and the decisions go on from the plan.
 *
 * The operator's service (`operatorMinecraftWiring.ts`) registers the port at start; without it (the switch off, a test), nothing is held.
 */
/** `start`: the feet when the held act began; `end`: when it ended (where the body was held). */
export type Feet = [number, number, number];
/** `notHeld`: a hold was asked for and not made, because the world could not be stopped (the body's freeze words; run 44, hold 1). */
/**
 * Chapter 8's 再開 9 → 保留 10: a held act that a resume sent again was held again, for another reason. The record of it: how the second try ended (the code of its stop) and
 * the items that were in the queue meanwhile and were taken off (their marks and why). The next resume's first decision reads it before anything else.
 */
export interface HeldAgain { code: string; dropped: { item: string; why: string }[] }
export interface IncidentNote { id: string; heavy: boolean; why: string; held: boolean; frozen: boolean | null; freeze?: string; notHeld?: string; start?: Feet | null; end?: Feet | null;
  /** Run 45: the act a resume sent again failed for the reason it was held for, and the body did not hold again (the hold it was sent again for). */
  repeated?: string;
  /** Chapter 8's 再開 9 → 保留 10: this hold is the second try of a held act, held again (see `HeldAgain`). */
  replay?: HeldAgain }
export interface IncidentHoldPort {
  /** Whether this task's request asked to be held on a heavy failure. */
  holdRequested(taskId: string): boolean;
  /** Holds the task (audit and stop); false when it is not one to hold or is held already. */
  hold(taskId: string, incident: IncidentNote & { command: string }): Promise<boolean>;
  /**
   * A heavy failure the body did not hold because it could not stop the world (someone else on the server; the coordinator's choice of
   * 2026-10-28, run 44): written down (audit and activity), and the task goes on.
   */
  notHeld(taskId: string, incident: IncidentNote & { command: string }): void;
  /**
   * Run 44, resume 1: the body refused an act as held (or its frame shows a hold) while the head had none: the head goes back to held. False when
   * there was nothing to do (held already, not the operator's).
   */
  bodyHeld(taskId: string, body: { incident: string; why: string; seen: 'refused' | 'frame' }): Promise<boolean>;
  /** After a `resume`, the hold whose act is to be sent again: its incident and the act's command id; null when there is none to send. */
  resumePending(taskId: string): { incident: string; command: string; start?: Feet | null } | null;
  /** Run 45: the line a resume with --skip-replay left for the task's next decision (the act not sent again and its result), once; else null. */
  skipNote?(taskId: string): string | null;
  /** Chapter 8: the line a resume left for the task's first decision when the hold it resumes was a held act's second try, held again (`heldAgainWords`), once; else null. */
  heldAgainNote?(taskId: string): string | null;
  /**
   * Run 45 (holds 3 to 5): the act sent again by a resume failed for the same reason it was held for, and the body did not hold again (its
   * receipt's `incident.repeated`): the decisions go on with the result; written down.
   */
  repeated?(taskId: string, incident: IncidentNote & { command: string }): void;
  /** The act sent again, and what it did (written once: the next step does not send it again). */
  resumeChecked(taskId: string, line: string): void;
}
let registered: IncidentHoldPort | null = null;
export function setIncidentHoldPort(port: IncidentHoldPort | null): void { registered = port; }
export function incidentHoldPort(): IncidentHoldPort | null { return registered; }

export function feet(value: unknown): Feet | null {
  return Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n)) ? value as Feet : null;
}
/** How far apart two feet are (m, one decimal), and the words the operator reads: 「始まり (x,y,z)・今 (x,y,z)（始まりから N m）」. */
export function driftWords(start: Feet | null | undefined, now: Feet | null | undefined, held?: Feet | null): string {
  const text = (p: Feet) => `(${p.map(n => Math.round(n * 10) / 10).join(',')})`;
  if (!start) return '保留した act の始まりの位置は記録に無い';
  const drift = now ? Math.round(Math.hypot(now[0] - start[0], now[1] - start[1], now[2] - start[2]) * 10) / 10 : null;
  return `保留した act の始まり ${text(start)}${held ? `・保留した時 ${text(held)}` : ''}・今 ${now ? text(now) : '不明（体が見えない）'}`
    + `${drift !== null ? `（始まりから ${drift} m）` : ''}`;
}

/** The `incident` an act's receipt carries (its result is the ActResult JSON), or null. */
export function incidentOfResult(result: string | undefined): IncidentNote | null {
  if (!result || !result.startsWith('{')) return null;
  try {
    const value = (JSON.parse(result) as { incident?: Record<string, unknown> }).incident;
    if (!value || typeof value.id !== 'string') return null;
    return { id: value.id, heavy: value.heavy === true, why: String(value.why ?? ''), held: value.held === true,
      frozen: typeof value.frozen === 'boolean' ? value.frozen : null, ...(typeof value.freeze === 'string' ? { freeze: value.freeze } : {}),
      ...(typeof value.notHeld === 'string' && value.notHeld ? { notHeld: value.notHeld } : {}),
      ...(typeof value.repeated === 'string' && value.repeated ? { repeated: value.repeated } : {}),
      ...(feet(value.start) ? { start: feet(value.start) } : {}), ...(feet(value.end) ? { end: feet(value.end) } : {}) };
  } catch { return null; }
}
