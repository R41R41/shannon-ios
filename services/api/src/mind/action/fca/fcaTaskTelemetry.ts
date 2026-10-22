import { createHash } from 'node:crypto';
import { PLAN_UPDATE_TOOL } from './fcaPlanTools.js';

/**
 * Syzygy ADR-0014 D8 (measurement only, no behaviour change): what one FCA task has spent so far, as counters, and one content-free
 * journal line, `fca_task_summary`, when it pauses (waits) or ends:
 *
 *   {"event":"fca_task_summary","task":<id>,"state":"waiting"|"completed"|"failed"|"stopped",
 *    "calls":{"main","urgent","lookahead","first_plan","summary":<model calls made>},"lookaheadTaken":<n>,
 *    "outTokens":<output tokens of all calls>,"uncachedIn":<input tokens not read from the cache (new + cache write)>,
 *    "sameArgsRetries":<a tool called with the same name and identical arguments right after the same call failed>,
 *    "planOnly":<decisions that changed the plan and did nothing on the body>,
 *    "recoveries":{"retry":<model attempts repeated>,"interrupt":<decisions thrown away for a hostile>,"surprise":<body investigations>}}
 *
 * Numbers, enums and ids only: an argument is never written, only compared by a hash that stays in memory. The counters live in this
 * process (a restart starts a task's counters again; the next summary then counts from there) and are bounded to `MAX_TASKS` tasks.
 */
export type FcaCallKind = 'main' | 'urgent' | 'lookahead' | 'first_plan' | 'summary';
export type FcaTaskState = 'waiting' | 'completed' | 'failed' | 'stopped';

interface Counters {
  calls: Record<FcaCallKind, number>; lookaheadTaken: number; outTokens: number; uncachedIn: number; sameArgsRetries: number; planOnly: number;
  recoveries: { retry: number; interrupt: number; surprise: number }; lastFailed: string | null;
}
const MAX_TASKS = 256;
const tasks = new Map<string, Counters>();
const fresh = (): Counters => ({ calls: { main: 0, urgent: 0, lookahead: 0, first_plan: 0, summary: 0 }, lookaheadTaken: 0, outTokens: 0, uncachedIn: 0,
  sameArgsRetries: 0, planOnly: 0, recoveries: { retry: 0, interrupt: 0, surprise: 0 }, lastFailed: null });
const counters = (taskId: string): Counters => {
  let value = tasks.get(taskId);
  if (!value) {
    value = fresh();
    tasks.set(taskId, value);
    if (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value as string);
  }
  return value;
};
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
/** Measuring never fails a step. */
const safely = (work: () => void) => { try { work(); } catch { /* as above */ } };

/** The arguments of a call, compared and never written: key order does not matter. */
function argumentsHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, inner]) => [key, canonical(inner)])) : item;
  return createHash('sha1').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex').slice(0, 12);
}

export const fcaTaskTelemetry = {
  /** A model call came back: its kind, output tokens and the input that was not read from the cache. */
  call(taskId: string, kind: FcaCallKind, usage: { out: number; uncached: number }): void {
    safely(() => {
      const entry = counters(taskId);
      entry.calls[kind] += 1;
      entry.outTokens += count(usage.out);
      entry.uncachedIn += count(usage.uncached);
    });
  },
  /** The step took the decision asked ahead instead of asking the model. */
  lookaheadTaken(taskId: string): void { safely(() => { counters(taskId).lookaheadTaken += 1; }); },
  /** A tool call ended: the same name with identical arguments right after it failed counts as a repeated retry. */
  toolCall(taskId: string, name: string, input: unknown, ok: boolean): void {
    safely(() => {
      const entry = counters(taskId), key = `${name}|${argumentsHash(input)}`;
      if (entry.lastFailed === key) entry.sameArgsRetries += 1;
      entry.lastFailed = ok ? null : key;
    });
  },
  /** A decision whose only effect was on the plan. */
  planOnly(taskId: string): void { safely(() => { counters(taskId).planOnly += 1; }); },
  recovery(taskId: string, kind: 'retry' | 'interrupt' | 'surprise'): void { safely(() => { counters(taskId).recoveries[kind] += 1; }); },
  /** What a committed decision did (`fcaDecisionMetrics.ts`); a task that waits or ended says its summary, then. */
  decision(taskId: string, facts: { attempts: number; interrupted: boolean; surprised: boolean; taken: boolean;
    planned: ReadonlyArray<{ name: string; act: boolean }>; phase?: string }, log?: (line: string) => void): void {
    safely(() => {
      const retries = Math.max(0, facts.attempts - 1 - (facts.interrupted ? 1 : 0));
      for (let count = 0; count < retries; count += 1) this.recovery(taskId, 'retry');
      if (facts.interrupted) this.recovery(taskId, 'interrupt');
      if (facts.surprised) this.recovery(taskId, 'surprise');
      if (facts.taken) this.lookaheadTaken(taskId);
      if (facts.planned.some(call => call.name === PLAN_UPDATE_TOOL) && !facts.planned.some(call => call.act)) this.planOnly(taskId);
      const { phase } = facts, state: FcaTaskState | null = phase === 'waiting' || phase === 'completed' || phase === 'failed' ? phase
        : phase === 'stopping' || phase === 'stopped' ? 'stopped' : null;
      if (state) this.summary(taskId, state, log);
    });
  },
  /** The line for a task that waits or ended (an ended task's counters are dropped). Never throws. */
  summary(taskId: string, state: FcaTaskState, log: (line: string) => void = line => console.info(line)): void {
    try {
      const entry = tasks.get(taskId);
      if (!entry) return;
      log(JSON.stringify({ event: 'fca_task_summary', task: taskId, state, calls: { ...entry.calls }, lookaheadTaken: entry.lookaheadTaken,
        outTokens: entry.outTokens, uncachedIn: entry.uncachedIn, sameArgsRetries: entry.sameArgsRetries, planOnly: entry.planOnly,
        recoveries: { ...entry.recoveries } }));
      if (state !== 'waiting') tasks.delete(taskId);
    } catch { /* as above */ }
  },
  /** For tests. */
  reset(): void { tasks.clear(); },
};
