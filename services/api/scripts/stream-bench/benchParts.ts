import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../src/infra/models/chatModelContract.js';

/**
 * The stream bench's small parts: the replay's clock, a model that records what it was asked, and the mouth that speaks for the desktop.
 */

/**
 * The replay's clock. It runs `speed` times faster than the wall's, so that ten minutes of chat pass in a minute; the head, the fake
 * YouTube and the mouth all read this one. With `compensate` (the real models), the time spent waiting for a model counts as real time,
 * not stretched: a model that takes two seconds takes two seconds on the stream's clock too, so the comment-to-voice numbers stay true.
 */
export class ScaledClock {
  private readonly realStart = Date.now();
  private held = 0;
  private waiting = 0;
  private since = 0;

  constructor(readonly epochMs: number, readonly speed: number, private readonly compensate: boolean) {}

  /** The stream's time in milliseconds since the epoch. */
  now(): number {
    const real = Date.now();
    const waited = this.held + (this.waiting > 0 ? real - this.since : 0);
    return this.epochMs + (real - this.realStart) * this.speed - (this.compensate ? waited * (this.speed - 1) : 0);
  }

  /** Real milliseconds to wait for `virtual` milliseconds of the stream's time. */
  real(virtual: number): number { return Math.max(1, virtual / this.speed); }

  /** Time spent inside `work` is the model's (not stretched, when compensating). */
  async track<T>(work: () => Promise<T>): Promise<T> {
    if (this.waiting++ === 0) this.since = Date.now();
    try { return await work(); } finally {
      if (--this.waiting === 0) this.held += Date.now() - this.since;
    }
  }
}

export interface ModelCall { role: 'writer' | 'auxiliary'; request: ShannonChatModelRequest; reply: string | null; realMs: number }

/** Wraps a model: every request and its answer are kept (the leak check reads them), and the wait is told to the clock. */
export class RecordingModel implements ShannonChatModel {
  readonly mode: ShannonChatModel['mode'];
  readonly model: string;

  constructor(private readonly inner: ShannonChatModel, private readonly role: ModelCall['role'], private readonly calls: ModelCall[],
    private readonly clock: ScaledClock, private readonly limit: { calls: number; used: number } | null = null) {
    this.mode = inner.mode;
    this.model = inner.model;
  }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    if (this.limit && this.limit.used >= this.limit.calls) throw new Error('BENCH_MODEL_CALL_LIMIT');
    if (this.limit) this.limit.used += 1;
    const started = Date.now();
    const call: ModelCall = { role: this.role, request, reply: null, realMs: 0 };
    this.calls.push(call);
    try {
      const result = await this.clock.track(() => this.inner.generate(request));
      call.reply = result.reply;
      return result;
    } finally { call.realMs = Date.now() - started; }
  }
}

export interface SpokenLine {
  seq: number;
  id: string;
  kind: string;
  text: string;
  answering: { commentId: string; authorName: string; text: string; kind: string }[];
  /** The stream's time of her first sound. */
  startedAt: string;
}

/** The desktop's place: reads the lines as the SSE brings them, speaks each for its length (0.12 s a character and 0.5 s), sends the receipt. */
export class BenchMouth {
  readonly spoken: SpokenLine[] = [];
  readonly events: { event: string; at: number }[] = [];
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private lastSeq = 0;

  constructor(private readonly options: { base: string; clock: ScaledClock; soundDelayMilliseconds?: number; log?: (line: string) => void }) {}

  start(): void {
    this.controller = new AbortController();
    this.running = this.loop(this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running?.catch(() => undefined);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await fetch(`${this.options.base}/v1/stream/lines?after=${this.lastSeq}`, { signal });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) await this.take(block);
        }
      } catch { /* a dropped connection is opened again below */ }
      if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private async take(block: string): Promise<void> {
    const event = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    if (!event || !data) return;
    this.events.push({ event, at: this.options.clock.now() });
    if (event !== 'line') return;
    const line = JSON.parse(data) as SpokenLine & { text: string };
    if (line.seq <= this.lastSeq) return;
    this.lastSeq = line.seq;
    const { clock } = this.options;
    await new Promise(resolve => setTimeout(resolve, clock.real(this.options.soundDelayMilliseconds ?? 600)));
    const startedAt = new Date(clock.now()).toISOString();
    await new Promise(resolve => setTimeout(resolve, clock.real((Array.from(line.text).length * 0.12 + 0.5) * 1000)));
    await fetch(`${this.options.base}/v1/stream/lines/${line.id}/receipt`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'spoken', startedAt, endedAt: new Date(clock.now()).toISOString() }) }).catch(() => undefined);
    this.spoken.push({ seq: line.seq, id: line.id, kind: line.kind, text: line.text, answering: line.answering, startedAt });
  }
}
