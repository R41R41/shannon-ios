/**
 * mb-llmc r5 (run 28: Sonnet asked to complete five times, "the dragon is not defeated" in each summary, and the fifth turned-back
 * completion of the whole task stopped it 263 s before its time): a completion the goal's check turns back is a mistake, said to the model
 * in one line (`line(n)`, the n-th in a row) in place of its receipt (`amend`, the provider's message: `amendAnthropicControl`). It counts
 * toward the stop only while completions come one after another: any step of tools sets the count back to 0. A task without it: as before
 * (every turned-back completion counts, from the start).
 */
export interface FcaCompletionMistake {
  line(inARow: number): string;
  /** The native message that answered the completion, with `text` in place of its receipt; null when it is not one. */
  amend?(turn: unknown, text: string): unknown | null;
}
/** Turned-back completions that stop a task (in a row with `FcaCompletionMistake`; from the start without it). */
export const FCA_COMPLETION_MISTAKES_STOP = 5;

/** The step's history with the mistake's line in place of the last turn's receipt (in place; a failing amend leaves it as it was). */
export function sayCompletionMistake(history: unknown[], mistake: FcaCompletionMistake, inARow: number): void {
  let amended: unknown = null;
  try { amended = mistake.amend?.(history.at(-1), mistake.line(inARow)) ?? null; } catch { amended = null; }
  if (amended && history.length) history[history.length - 1] = amended;
}
