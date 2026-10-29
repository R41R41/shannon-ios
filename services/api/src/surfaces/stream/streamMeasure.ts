import { STREAM_LIMITS } from './streamContract.js';

/**
 * The stream's own numbers (`docs/stream-contract.md` §7, plan item 10): how long from a comment to its line and to her first sound, how
 * many model calls and tokens, and the model-call allowance of the minute. Counts and times only; no word of the chat.
 */
export type ModelPurpose = 'writer' | 'rewrite' | 'topic' | 'greeting' | 'closing' | 'commentary';

/** The model calls of the last minute: at most `modelCallsPerMinute` for the whole stream; topics and commentary leave some for replies. */
export class ModelBudget {
  private readonly taken: number[] = [];

  constructor(private readonly now: () => number) {}

  used(): number {
    const now = this.now();
    while (this.taken.length && now - this.taken[0]! >= 60_000) this.taken.shift();
    return this.taken.length;
  }

  /** Whether a call of this priority could be made now. `low`: topics and commentary. */
  available(priority: 'reply' | 'low'): boolean {
    const limit = STREAM_LIMITS.modelCallsPerMinute - (priority === 'low' ? STREAM_LIMITS.modelCallsKeptForReplies : 0);
    return this.used() < limit;
  }

  take(priority: 'reply' | 'low'): boolean {
    if (!this.available(priority)) return false;
    this.taken.push(this.now());
    return true;
  }
}

export interface Percentiles { n: number; median: number | null; p90: number | null; max: number | null }

export function percentiles(values: readonly number[]): Percentiles {
  if (!values.length) return { n: 0, median: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
  return { n: sorted.length, median: at(0.5), p90: at(0.9), max: sorted.at(-1)! };
}

export class StreamMeasure {
  readonly commentToLineMs: number[] = [];
  readonly lineToSoundMs: number[] = [];
  readonly commentToSoundMs: number[] = [];
  readonly calls: Record<ModelPurpose, number> = { writer: 0, rewrite: 0, topic: 0, greeting: 0, closing: 0, commentary: 0 };
  readonly tokens = { input: 0, cachedInput: 0, output: 0 };
  counts = { budgetSkips: 0, modelTimeouts: 0, modelErrors: 0, brokenAnswers: 0, rewrites: 0, safeLines: 0, droppedLines: 0, noRoom: 0, notChosen: 0, speakingSeconds: 0 };

  /** How lines ended, by outcome and the reason the mouth or the desktop gave (any reason the desktop sends is counted as it came). */
  readonly reasons: Record<string, number> = {};

  reason(key: string): void {
    if (Object.keys(this.reasons).length < 40 || key in this.reasons) this.reasons[key] = (this.reasons[key] ?? 0) + 1;
  }

  note(list: number[], value: number): void {
    if (Number.isFinite(value) && value >= 0) list.push(value);
  }

  usage(result: unknown): void {
    type Usage = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
    const usage = result && typeof result === 'object' ? (result as { usage?: Usage }).usage : undefined;
    if (!usage) return;
    this.tokens.input += usage.inputTokens ?? 0;
    this.tokens.cachedInput += usage.cachedInputTokens ?? 0;
    this.tokens.output += usage.outputTokens ?? 0;
  }

  totalCalls(): number { return Object.values(this.calls).reduce((sum, value) => sum + value, 0); }

  summary() {
    return {
      commentToLineMs: percentiles(this.commentToLineMs), lineToSoundMs: percentiles(this.lineToSoundMs), commentToSoundMs: percentiles(this.commentToSoundMs),
      modelCalls: { ...this.calls, total: this.totalCalls() }, tokens: { ...this.tokens }, lineEnds: { ...this.reasons }, ...this.counts,
    };
  }
}
