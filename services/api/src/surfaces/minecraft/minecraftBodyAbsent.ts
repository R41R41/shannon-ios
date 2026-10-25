/**
 * The Minecraft tasks whose latest decision found no body (no frame within `LLMC_STALE_FRAME_MS`), kept in memory.
 *
 * mc-chat-stale-frame (2026-10-26, task 31789a13): a chat request's decision read `connected: false` and called `fca_wait`; the requester
 * can answer, so the wait was accepted and the task slept until his next words. Nothing told it that the body was back. A decision that
 * finds no body notes it here (`noteBodySeen`), and the wake (`wiring/fcaMinecraftBodyWake.ts`) gives a task noted here, and asleep,
 * one message when a current frame of its body is there. A decision that finds the body clears the note. Lost with the process: a task
 * that slept through a restart waits for a message, as before.
 */
const absent = new Map<string, number>();
const LIMIT = 32;

/** A decision of this task found its body (`seen`) or did not. */
export function noteBodySeen(taskId: string, seen: boolean, at = Date.now()): void {
  absent.delete(taskId);
  if (seen) return;
  absent.set(taskId, at);
  if (absent.size > LIMIT) absent.delete(absent.keys().next().value as string);
}

/** The tasks whose latest decision found no body. */
export function tasksWithoutBody(): string[] {
  return [...absent.keys()];
}

/** The note of a task is no longer needed (it was woken, or it is over). */
export function forgetBodyAbsent(taskId: string): void {
  absent.delete(taskId);
}

/** For tests: no task is noted. */
export function forgetAllBodyAbsent(): void {
  absent.clear();
}
