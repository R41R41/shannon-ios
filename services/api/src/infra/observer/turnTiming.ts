/**
 * One content-free timing line per conversation turn, and a bound for each await before the model call.
 *
 * Why: on 2026-10-12 a voice turn sat ~100 s before its model call while the API's event loop was blocked; the observer
 * ring had already evicted its spans, the respond lease expired unrenewed, and journald held nothing about the turn. This
 * line survives in journald: stage durations in milliseconds, a short id and a closed outcome code. Never words, prompts,
 * memory ids or tool names.
 */

/** The stages a voice turn reports, in order. A stage that did not run is printed as `-`. */
export const TURN_TIMING_STAGES = ['admit', 'route', 'recall', 'capability', 'fca', 'firstToken', 'firstSegment', 'total'] as const;
export type TurnTimingStage = typeof TURN_TIMING_STAGES[number];

/** The notes a line may carry, in this order, after the outcome (`TurnTiming.note`). */
export const TURN_TIMING_NOTES = ['silence', 'chars'] as const;
export type TurnTimingNote = typeof TURN_TIMING_NOTES[number];

/** Closed outcome codes; anything else is reported as `error`. */
const OUTCOME = /^[a-z][a-z0-9_]{0,47}$/u;

export class TurnTiming {
  private readonly startedAt: number;
  private readonly values = new Map<TurnTimingStage, number>();
  private readonly timeouts = new Set<string>();
  private readonly notes = new Map<TurnTimingNote, string>();
  private logged = false;

  constructor(readonly surface: 'voice' | 'text', readonly id: string, private readonly clock: () => number = () => performance.now(),
    private readonly log: (line: string) => void = line => console.info(line)) {
    this.startedAt = clock();
  }

  /** Milliseconds since the turn arrived. */
  elapsed(): number { return Math.max(0, Math.round(this.clock() - this.startedAt)); }

  /** The first time a point of the turn is reached, as milliseconds since arrival (later marks of the same stage are ignored). */
  mark(stage: TurnTimingStage): void {
    if (!this.values.has(stage)) this.values.set(stage, this.elapsed());
  }

  /** Adds the duration of `work` to a stage (a stage may be made of several pieces). */
  async measure<T>(stage: TurnTimingStage, work: () => Promise<T>): Promise<T> {
    const started = this.clock();
    try { return await work(); } finally { this.add(stage, this.clock() - started); }
  }

  measureSync<T>(stage: TurnTimingStage, work: () => T): T {
    const started = this.clock();
    try { return work(); } finally { this.add(stage, this.clock() - started); }
  }

  add(stage: TurnTimingStage, milliseconds: number): void {
    this.values.set(stage, (this.values.get(stage) ?? 0) + Math.max(0, Math.round(milliseconds)));
  }

  /** A bounded stage gave up waiting: named in the line as `timeouts=<code>,...`. */
  timedOut(code: string): void { if (OUTCOME.test(code)) this.timeouts.add(code); }

  /**
   * A content-free fact of the turn for its line (owner's Windows call, 2026-10-14: an unanswered turn left no trace of why):
   * `silence` the closed category that kept her quiet, `chars` how many characters his words had. Anything else is dropped.
   */
  note(key: TurnTimingNote, value: string | number): void {
    const text = String(value);
    if (key === 'chars' ? /^\d{1,6}$/u.test(text) : OUTCOME.test(text)) this.notes.set(key, text);
  }

  line(outcome: string): string {
    if (!this.values.has('total')) this.values.set('total', this.elapsed());
    const stages = TURN_TIMING_STAGES.map(stage => `${stage}=${this.values.has(stage) ? `${this.values.get(stage)}ms` : '-'}`);
    const timeouts = this.timeouts.size ? ` timeouts=${[...this.timeouts].join(',')}` : '';
    const notes = TURN_TIMING_NOTES.filter(key => this.notes.has(key)).map(key => ` ${key}=${this.notes.get(key)}`).join('');
    const closed = OUTCOME.test(outcome) ? outcome : 'error';
    return `Shannon turn timing surface=${this.surface} id=${this.id} ${stages.join(' ')} outcome=${closed}${timeouts}${notes}`;
  }

  /** Writes the line once; later calls do nothing. */
  finish(outcome: string): void {
    if (this.logged) return;
    this.logged = true;
    try { this.log(this.line(outcome)); } catch { /* timing never fails a turn */ }
  }
}

/** A short, content-free id for the line: the first 8 hex digits of the client's utterance id, or a fresh one. */
export function turnTimingId(utteranceId: unknown): string {
  return typeof utteranceId === 'string' && /^[0-9a-f]{8}-/iu.test(utteranceId)
    ? utteranceId.slice(0, 8).toLowerCase() : Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0');
}

/**
 * Waits for `work` at most `milliseconds`; then the turn goes on with `fallback()` and the code is logged. The late result is
 * dropped (and a late rejection swallowed): only read-only inputs of a turn are bounded this way, never an outside write.
 */
export async function boundedStage<T>(input: T | Promise<T>, bound: { milliseconds: number; code: string; fallback: () => T | Promise<T>;
  timing?: TurnTiming | null; surface?: 'voice' | 'text' }): Promise<T> {
  if (!(input instanceof Promise)) return input; // Nothing to wait for.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol('late');
  const work = input;
  work.catch(() => {});
  try {
    const winner = await Promise.race([work, new Promise<typeof late>(resolve => { timer = setTimeout(() => resolve(late), bound.milliseconds); })]);
    if (winner !== late) return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
  bound.timing?.timedOut(bound.code);
  const surface = bound.surface ?? bound.timing?.surface ?? 'voice';
  try {
    console.warn(`Shannon turn stage timed out code=${bound.code} surface=${surface} ms=${bound.milliseconds}`);
  } catch { /* never fails a turn */ }
  return await bound.fallback();
}

/**
 * How long a conversation turn waits for each input before its model call; past it the turn goes on without that input and the
 * code is logged. Each provider call also has its own, shorter timeout: these are the outer bounds.
 */
export const TURN_STAGE_BOUNDS = Object.freeze({
  route_timeout: 2_500, recall_timeout: 6_000, capability_timeout: 4_000, places_timeout: 8_000, tool_menu_timeout: 2_000, tool_select_timeout: 2_500,
});
export type TurnStageCode = keyof typeof TURN_STAGE_BOUNDS;

/** `boundedStage` with the turn's bounds, surface and timing line. */
export function turnStages(surface: 'voice' | 'text', timing?: TurnTiming | null) {
  return <T>(code: TurnStageCode, work: T | Promise<T>, fallback: () => T | Promise<T>): Promise<T> =>
    boundedStage(work, { milliseconds: TURN_STAGE_BOUNDS[code], code, surface, fallback, ...(timing ? { timing } : {}) });
}

/** A text turn's bounded stages (each input before its model call). */
export const textStage = turnStages('text');

/** The closed outcome of a turn for its timing line: a status, a constant error code, never words. */
export function turnOutcome(response: { status: number; body: unknown } | null, error?: unknown): string {
  if (error !== undefined) {
    const message = error instanceof Error ? error.message : '';
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'aborted'
      : /^[A-Z][A-Z0-9_]{2,47}$/u.test(message) ? message.toLowerCase() : 'error';
  }
  if (!response) return 'error';
  if (response.status < 200 || response.status >= 300) return `http_${response.status}`;
  const reply = (response.body as Record<string, unknown> | null)?.reply;
  return typeof reply === 'string' && reply.trim() ? 'responded' : 'no_response';
}

/** Writes a turn's line when its promise settles, with the outcome of what it settled with. */
export function finishTurnTiming<T extends { status: number; body: unknown }>(turn: Promise<T>, timing: TurnTiming | null): Promise<T> {
  if (!timing) return turn;
  return turn.then(response => {
    timing.finish(turnOutcome(response));
    return response;
  }, (error: unknown) => {
    timing.finish(turnOutcome(null, error));
    throw error;
  });
}
