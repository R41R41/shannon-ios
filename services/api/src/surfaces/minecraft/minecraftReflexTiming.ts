/**
 * Syzygy ADR-0014 D8 (measurement only, no behaviour change): one compact journal line for each decision of the head's fast judgment and
 * image reflex, with when each stage happened (epoch ms, the API's clock):
 *
 *   {"event":"minecraft_reflex_timing","path":"fast"|"image"|"explicit","task":<id>,"kind":<closed code>,"rule":<closed code>,"skill":<name>,
 *    "detectedAt":<the frame's `receivedAt`>,"decidedAt":<the judgment or entry decided>,"dispatchedAt":<the command left for the body | null>,
 *    "receiptAt":<the body's receipt arrived | null>,"outcome":<closed code | null>,"discard":<closed reason | null>}
 *
 * A decision that was dropped before anything was sent has `dispatchedAt` and `receiptAt` null and a `discard` reason. Counters and closed
 * codes only: never a prompt, an observation or a free text. The body's own times (detect, act, quiescence) are the body's to log.
 */
export interface ReflexTiming {
  path: 'fast' | 'image' | 'explicit'; task: string; kind: string | null; rule: string | null; skill: string | null;
  detectedAt: number | null; decidedAt: number | null; dispatchedAt: number | null; receiptAt: number | null; outcome: string | null; discard: string | null;
}
const code = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/u.test(value) ? value : null;
const time = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
/** The `receivedAt` of a frame as epoch ms, or null. */
export const frameTime = (receivedAt: unknown): number | null => typeof receivedAt === 'string' ? time(Date.parse(receivedAt)) : null;

export function reflexTimingLine(timing: ReflexTiming): string {
  return JSON.stringify({ event: 'minecraft_reflex_timing', path: timing.path, task: timing.task, kind: code(timing.kind), rule: code(timing.rule),
    skill: code(timing.skill), detectedAt: time(timing.detectedAt), decidedAt: time(timing.decidedAt), dispatchedAt: time(timing.dispatchedAt),
    receiptAt: time(timing.receiptAt), outcome: code(timing.outcome), discard: code(timing.discard) });
}
/** Writes the line; measuring never fails a decision. */
export function logReflexTiming(log: ((line: string) => void) | undefined, timing: ReflexTiming): void {
  try { (log ?? ((line: string) => console.info(line)))(reflexTimingLine(timing)); } catch { /* as above */ }
}

/**
 * The image reflex's and the explicit `minecraft.reflex` call's timings, for one step's adapter (`minecraftReflexAdapter.ts`): the frame
 * the monitor last looked at, the sessions in flight, and one line for each session when it ends or for each entry that was held.
 */
/** What a session's end says here: how it ended and the actions it took (the receipt). */
interface SessionEnd { control: string; reason: string; actions: readonly unknown[] }
export function createReflexTimings(parts: { task: string; now(): number; log?: (line: string) => void; held: boolean }) {
  let frameAt: number | null = null;
  const sessions = new Map<string, ReflexTiming>();
  const line = (timing: ReflexTiming) => logReflexTiming(parts.log, timing);
  return {
    /** The monitor looked at this frame (its `receivedAt`); the frame as it was. */
    seen<T extends { receivedAt?: unknown } | null>(frame: T): T {
      frameAt = frameTime(frame?.receivedAt);
      return frame;
    },
    /** An entry was held (the adapter's `hold`, once for a repeated reason): its fixed line, and while the fast judgment is on, its timing. */
    held(reason: string, detail: Record<string, string | number | boolean | null>): void {
      if (!parts.held) return;
      parts.log?.(`Shannon reflex entry held task=${parts.task} reason=${reason}`);
      const kind = [detail.kind, detail.mode].find(value => typeof value === 'string'), skill = detail.skill;
      line({ path: 'fast', task: parts.task, kind: typeof kind === 'string' ? kind : null, rule: null, skill: typeof skill === 'string' ? skill : null,
        detectedAt: frameAt, decidedAt: parts.now(), dispatchedAt: null, receiptAt: null, outcome: null, discard: reason });
    },
    /** A session started: `track` follows its promise to its end and returns it as it was; `around` times its body command. */
    session(sessionId: string, mode: 'explicit' | 'danger' | 'stuck' | 'visual') {
      const timing: ReflexTiming = { path: mode === 'explicit' ? 'explicit' : 'image', task: parts.task, kind: mode, rule: null, skill: null,
        detectedAt: mode === 'explicit' ? null : frameAt, decidedAt: parts.now(), dispatchedAt: null, receiptAt: null, outcome: null, discard: null };
      sessions.set(sessionId, timing);
      const ended = (receipt: SessionEnd | null) => {
        sessions.delete(sessionId);
        timing.outcome = receipt ? receipt.control : 'fault';
        if (!receipt?.actions.length) timing.discard = receipt ? receipt.reason : 'fault';
        line(timing);
      };
      return {
        track<T extends SessionEnd | null>(job: Promise<T>): Promise<T> {
          job.then(ended, () => ended(null));
          return job;
        },
      };
    },
    /** The body command of a session's action: the dispatch, then the receipt (the first dispatch and the last receipt stand). */
    async around<T>(sessionId: string, skill: string | null | undefined, command: () => Promise<T>): Promise<T> {
      const timing = sessions.get(sessionId);
      if (timing) {
        timing.dispatchedAt ??= parts.now();
        timing.skill = skill ?? null;
      }
      try {
        return await command();
      } finally {
        if (timing) timing.receiptAt = parts.now();
      }
    },
  };
}
