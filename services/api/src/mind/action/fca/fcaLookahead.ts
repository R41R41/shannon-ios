import type { FcaModel, FcaModelInput, FcaModelOutput, FcaToolCall } from './fcaPorts.js';
import type { TaskStep } from '../taskRuntime/taskRuntimePorts.js';

/**
 * Lookahead (session mb-arch, owner 2026-10-20: "while the body works, the planner thinks of what comes next"). The model used to be
 * asked only after a step's last tool had ended, and the body stood still meanwhile: run 19, 400 s of 30 minutes, 35 gaps of 5 s or
 * more. Now, while the decision's last call is a long body call, the next decision is asked in the same step, with that call's result
 * given as running; the next step takes it (`take`) instead of asking the model, when it is still good for it:
 *
 * - it is a decision of tools (a completion or a wait is asked again with the real result), and the call ended well (no failure, no
 *   reflex cut, nothing stale): what was asked for it still holds;
 * - nothing new came in (no message in the task's inbox), the task's history is the one it was prepared after (its length and its last
 *   turn: a step's own start moves the task's revision, so that is not compared), and nothing else acted meanwhile (`fresh`, the
 *   surface's: run its executor's work and the decision is asked again);
 * - it is fresh (`maxAgeMs` from when it was asked), and not more than `maxChain` steps in a row took one (a step that asks the model
 *   also lets the history be summarized when it has grown); a lookahead that could not be taken is not asked at all.
 *
 * The step that takes it puts the real result where the running one stood, so the next lookahead and the model see what happened.
 * A dropped lookahead is let finish (an aborted request is booked at its worst estimate) and only its answer is thrown away; one is not
 * started for a call that ends within `delayMs` (most failures end at once).
 */
export const FCA_LOOKAHEAD_RUNNING = '実行中（結果は次の判断で届く）。この手が済んだ後に続ける手を選んでよい。';
export const FCA_LOOKAHEAD = Object.freeze({ maxAgeMs: 45_000, maxChain: 4, settleMs: 8_000, delayMs: 1_500 });

export interface FcaPrepared {
  taskId: string;
  historyLength: number;
  /** The history's last turn as committed (JSON), so a history of the same length but another end is not taken for it. */
  lastTurn: string;
  /** When the request was made (its body is as it was then). */
  preparedAt: number;
  request: FcaModelInput;
  output: FcaModelOutput;
  /** The step's tool selection as it was committed (opaque here). */
  selection: unknown;
}

export interface FcaLookahead {
  /** Whether to prepare the next decision while this call of this task runs (a long body call, and one the next step may take). */
  wanted(call: FcaToolCall, taskId: string): boolean;
  keep(prepared: FcaPrepared): void;
  /** The decision prepared for this step, when still good for it (taken once), or null. */
  take(step: TaskStep): FcaPrepared | null;
  /** How long a call must have run before the next decision is asked (`FCA_LOOKAHEAD.delayMs`). */
  delayMs: number;
}

export function createFcaLookahead(options: {
  wanted(call: FcaToolCall, taskId: string): boolean; now?: () => number; log?(line: string): void; maxAgeMs?: number; maxChain?: number; delayMs?: number;
  /** Whether nothing else acted for the task since `preparedAt` (the surface's executor). Absent: nothing else acts. */
  fresh?(taskId: string, preparedAt: number): boolean;
}): FcaLookahead {
  const now = options.now ?? Date.now;
  const maxChain = options.maxChain ?? FCA_LOOKAHEAD.maxChain;
  const kept = new Map<string, FcaPrepared>();
  const chains = new Map<string, number>();
  const log = (line: string) => {
    try {
      options.log?.(line);
    } catch { /* logging never fails a step */ }
  };
  const why = (step: TaskStep, prepared: FcaPrepared): string => {
    if (prepared.output.decision.kind !== 'tools') return 'not_tools';
    if (prepared.historyLength !== step.snapshot.history.length || prepared.lastTurn !== JSON.stringify(step.snapshot.history.at(-1) ?? null)) return 'history';
    if (step.snapshot.messages.length) return 'messages';
    if (now() - prepared.preparedAt > (options.maxAgeMs ?? FCA_LOOKAHEAD.maxAgeMs)) return 'old';
    if (options.fresh && !options.fresh(step.taskId, prepared.preparedAt)) return 'acted';
    return (chains.get(step.taskId) ?? 0) >= maxChain ? 'chain' : 'ok';
  };
  return {
    delayMs: options.delayMs ?? FCA_LOOKAHEAD.delayMs,
    wanted: (call, taskId) => (chains.get(taskId) ?? 0) < maxChain && options.wanted(call, taskId),
    keep(prepared) {
      kept.set(prepared.taskId, prepared);
      if (kept.size > 32) kept.delete(kept.keys().next().value as string);
    },
    take(step) {
      const prepared = kept.get(step.taskId);
      kept.delete(step.taskId);
      const reason = prepared ? why(step, prepared) : null;
      if (reason !== 'ok') {
        if (reason) log(`Shannon FCA lookahead wasted task=${step.taskId} reason=${reason}`);
        chains.set(step.taskId, 0);
        return null;
      }
      const chain = (chains.get(step.taskId) ?? 0) + 1;
      chains.set(step.taskId, chain);
      log(`Shannon FCA lookahead adopted task=${step.taskId} chain=${chain} ageMs=${now() - prepared!.preparedAt}`);
      return prepared!;
    },
  };
}

/** The prepared request with the real last turn (the call's committed result) where the running one stood. */
export function withRealResult(request: FcaModelInput, history: readonly unknown[]): FcaModelInput {
  return { ...request, history: [...request.history.slice(0, -1), ...history.slice(-1)] };
}

/**
 * Asks the next decision while `call` runs, once it has run `delayMs`: the request is the step's own (`base`: its history, body, tools),
 * with this step's messages and the results so far, the running call's result being `FCA_LOOKAHEAD_RUNNING`. The model call runs in
 * `isolate` (the step's own bookkeeping is not the lookahead's). `settle` gives the answer once the call has ended well, within
 * `timeoutMs`, or null; a lookahead not wanted is let finish unread (an abort would be booked at its worst).
 */
export function startFcaLookahead(parts: {
  model: FcaModel; base: FcaModelInput; history: readonly unknown[]; results: ReadonlyArray<{ id: string; text: string; ok: boolean }>;
  call: FcaToolCall; permit(): Promise<boolean>; afford(): boolean; signal: AbortSignal;
  isolate?<T>(work: () => Promise<T>): Promise<T>; delayMs?: number; now?: () => number;
}): { settle(ok: boolean, timeoutMs?: number): Promise<{ request: FcaModelInput; output: FcaModelOutput; preparedAt: number } | null> } {
  const running = parts.model.toolResults([...parts.results, { id: parts.call.id, text: FCA_LOOKAHEAD_RUNNING, ok: true }]);
  const { recall: _recall, waiting: _waiting, ...base } = parts.base;
  const request: FcaModelInput = { ...base, messages: [], history: [...parts.base.history, ...parts.history, running] };
  const isolate = parts.isolate ?? (<T>(work: () => Promise<T>) => work());
  let job: Promise<{ request: FcaModelInput; output: FcaModelOutput; preparedAt: number } | null> | null = null;
  const ask = () => {
    job = isolate(async () => {
      const preparedAt = (parts.now ?? Date.now)();
      if (parts.signal.aborted || !parts.afford() || !await parts.permit()) return null;
      return { request, output: await parts.model.decide(request, parts.signal), preparedAt };
    }).catch(() => null);
  };
  const timer = setTimeout(ask, parts.delayMs ?? FCA_LOOKAHEAD.delayMs);
  return {
    async settle(ok, timeoutMs = FCA_LOOKAHEAD.settleMs) {
      clearTimeout(timer);
      if (!ok || !job) return null;
      let late: ReturnType<typeof setTimeout> | undefined;
      const giveUp = new Promise<null>(resolve => {
        late = setTimeout(() => resolve(null), timeoutMs);
      });
      try {
        return await Promise.race([job, giveUp]);
      } finally { clearTimeout(late); }
    },
  };
}
