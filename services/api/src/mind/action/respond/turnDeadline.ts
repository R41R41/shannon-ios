/**
 * The one deadline of a conversation turn that offers her tools (coordinator decision 2026-10-05), measured from
 * the request's arrival, so memory recall and the capability context count too. Every model round and every tool
 * call takes its time from it: min(its own cap, what is left minus the answer's reserve). The last round, which
 * answers without tools, keeps the reserve; when even that is gone she says a fixed short line instead.
 *
 * Text: the iPhone waits 60 s for a non-streaming reply. Voice: the iPhone's voice requests time out at 45 s.
 */
export interface TurnDeadlinePlan {
  totalMilliseconds: number;
  /** Kept for the final answer without tools. */
  answerReserveMilliseconds: number;
  /** The first model round, before any tool ran; and every later one. */
  firstRoundMilliseconds: number;
  laterRoundMilliseconds: number;
}

export const TEXT_TURN_DEADLINE: Readonly<TurnDeadlinePlan> = Object.freeze({
  totalMilliseconds: 50_000, answerReserveMilliseconds: 12_000, firstRoundMilliseconds: 30_000, laterRoundMilliseconds: 20_000,
});
export const VOICE_TURN_DEADLINE: Readonly<TurnDeadlinePlan> = Object.freeze({
  totalMilliseconds: 38_000, answerReserveMilliseconds: 8_000, firstRoundMilliseconds: 20_000, laterRoundMilliseconds: 15_000,
});

/** A round shorter than this is not started; a tool call shorter than this is not run; an answer shorter than this is the fixed line. */
export const MINIMUM_ROUND_MILLISECONDS = 4_000;
export const MINIMUM_CALL_MILLISECONDS = 1_000;
export const MINIMUM_ANSWER_MILLISECONDS = 2_000;
/** One tool call at most (a folder operation also has its own, shorter wait). */
export const TOOL_CALL_CAP_MILLISECONDS = 10_000;

/** What she says when the turn ran out before she could answer. Plain, in her voice; the turn is still saved. */
export const TURN_OUT_OF_TIME_LINE = '時間が足りなかったので、続きはもう一度言ってください。';

export class TurnDeadline {
  private readonly startedAt: number;

  constructor(readonly plan: Readonly<TurnDeadlinePlan>, private readonly clock: () => number = Date.now) {
    this.startedAt = clock();
  }

  /** What is left of the whole turn. */
  left(): number {
    return this.plan.totalMilliseconds - (this.clock() - this.startedAt);
  }

  /** The time a step (a round with tools, a tool call) may take: its cap, never into the answer's reserve. */
  forStep(capMilliseconds: number): number {
    return Math.min(capMilliseconds, this.left() - this.plan.answerReserveMilliseconds);
  }

  /** The time the final answer may take: all that is left. */
  forAnswer(): number {
    return this.left();
  }
}

/** A provider call that ran out of its time (not the caller's own cancellation). */
export function timedOut(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  return name === 'TimeoutError' || name === 'AbortError' || (typeof message === 'string' && /TIMEOUT|aborted|timed out/iu.test(message));
}

/**
 * The time of one model round. It starts at the round's step time; once the round emits reply text it is the
 * answer, and may take all that is left of the turn (`answering`), so an answer already under way is never cut at
 * a step's time and asked again.
 */
export interface RoundTime {
  milliseconds: number;
  /** What is left of the turn for an answer. */
  answer(): number;
}

export class RoundTimer {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private extended = false;

  constructor(private readonly time: RoundTime) {
    this.arm(time.milliseconds);
  }

  get signal(): AbortSignal { return this.controller.signal; }

  /** The round is writing the answer: from now it may take the answer's time. */
  answering(): void {
    if (this.extended) return;
    this.extended = true;
    this.arm(this.time.answer());
  }

  clear(): void { clearTimeout(this.timer); }

  private arm(milliseconds: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(new DOMException('The round ran out of its time.', 'TimeoutError')), Math.max(1, milliseconds));
  }
}

/** A round that had already sent reply text failed: what was sent stands, and the turn ends with the fixed line. */
export class PartialAnswerError extends Error {
  constructor(readonly sent: string) {
    super('PARTIAL_ANSWER');
    this.name = 'PartialAnswerError';
  }
}
