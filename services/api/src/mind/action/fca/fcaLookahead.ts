import type { FcaModel, FcaModelInput, FcaModelOutput, FcaToolCall } from './fcaPorts.js';
import type { TaskStep } from '../taskRuntime/taskRuntimePorts.js';

/**
 * Lookahead (session mb-arch, owner 2026-10-20: "while the body works, the planner thinks of what comes next"). The model used to be
 * asked only after a step's last tool had ended, and the body stood still meanwhile: run 19, 400 s of 30 minutes, 35 gaps of 5 s or
 * more. Now, while the decision's last call is a long body call, the next decision is asked in the same step, with that call's result
 * given as running; the next step takes it (`take`) instead of asking the model, when it is still good for it:
 *
 * - the call ended well (no failure, no reflex cut, nothing stale): what was asked for it still holds;
 * - nothing new came in (no message in the task's inbox), and the task's history is the one it was prepared after (its length and its last
 *   turn: a step's own start moves the task's revision, so that is not compared);
 * - it is fresh (`maxAgeMs`), and not more than `maxChain` steps in a row took one (a step that asks the model also lets the history be
 *   summarized when it has grown).
 *
 * The prepared request is the next decision's own request (its history, body, transient state), so a decision taken from it is the one
 * the model would have made with the running call taken as going well. A wasted one costs one request; nothing else changes.
 */
export const FCA_LOOKAHEAD_RUNNING = '実行中（結果は次の判断で届く）。この手が済んだ後に続ける手を選んでよい。';
export const FCA_LOOKAHEAD = Object.freeze({ maxAgeMs: 45_000, maxChain: 4, settleMs: 20_000 });

export interface FcaPrepared {
  taskId: string;
  historyLength: number;
  /** The history's last turn as committed (JSON), so a history of the same length but another end is not taken for it. */
  lastTurn: string;
  preparedAt: number;
  request: FcaModelInput;
  output: FcaModelOutput;
  /** The step's tool selection as it was when prepared (opaque here). */
  selection: unknown;
}

export interface FcaLookahead {
  /** Whether to prepare the next decision while this call runs (the surface's: a long body call). */
  wanted(call: FcaToolCall): boolean;
  keep(prepared: FcaPrepared): void;
  /** The decision prepared for this step, when still good for it (taken once), or null. */
  take(step: TaskStep): FcaPrepared | null;
}

export function createFcaLookahead(options: { wanted(call: FcaToolCall): boolean; now?: () => number; log?(line: string): void;
  maxAgeMs?: number; maxChain?: number }): FcaLookahead {
  const now = options.now ?? Date.now;
  const kept = new Map<string, FcaPrepared>();
  const chains = new Map<string, number>();
  const log = (line: string) => { try { options.log?.(line); } catch { /* logging never fails a step */ } };
  return {
    wanted: call => options.wanted(call),
    keep(prepared) {
      kept.set(prepared.taskId, prepared);
      if (kept.size > 32) kept.delete(kept.keys().next().value as string);
    },
    take(step) {
      const prepared = kept.get(step.taskId);
      kept.delete(step.taskId);
      const chain = chains.get(step.taskId) ?? 0;
      const reason = !prepared ? null : prepared.historyLength !== step.snapshot.history.length
        || prepared.lastTurn !== JSON.stringify(step.snapshot.history.at(-1) ?? null) ? 'history'
        : step.snapshot.messages.length ? 'messages' : now() - prepared.preparedAt > (options.maxAgeMs ?? FCA_LOOKAHEAD.maxAgeMs) ? 'old'
          : chain >= (options.maxChain ?? FCA_LOOKAHEAD.maxChain) ? 'chain' : 'ok';
      if (reason && reason !== 'ok') log(`Shannon FCA lookahead wasted task=${step.taskId} reason=${reason}`);
      if (reason !== 'ok') {
        chains.set(step.taskId, 0);
        return null;
      }
      chains.set(step.taskId, chain + 1);
      log(`Shannon FCA lookahead adopted task=${step.taskId} chain=${chain + 1} ageMs=${now() - prepared!.preparedAt}`);
      return prepared!;
    },
  };
}

/**
 * Asks the next decision now, while `call` runs: the request is the step's own (`base`, its history, its tools), with this step's
 * messages and the results so far, the running call's result being `FCA_LOOKAHEAD_RUNNING`, and the body as it is now (`now()`).
 * `settle` gives the answer once the call has ended well, or drops it (and stops the request) when it did not.
 */
export function startFcaLookahead(parts: {
  model: FcaModel; base: FcaModelInput; history: readonly unknown[]; results: ReadonlyArray<{ id: string; text: string; ok: boolean }>;
  call: FcaToolCall; now(): Partial<FcaModelInput>; permit(): Promise<boolean>; afford(): boolean; signal: AbortSignal;
}): { settle(ok: boolean, timeoutMs?: number): Promise<{ request: FcaModelInput; output: FcaModelOutput } | null> } {
  const stop = new AbortController();
  const signal = AbortSignal.any([parts.signal, stop.signal]);
  const running = parts.model.toolResults([...parts.results, { id: parts.call.id, text: FCA_LOOKAHEAD_RUNNING, ok: true }]);
  const { recall: _recall, waiting: _waiting, ...base } = parts.base;
  const request: FcaModelInput = { ...base, messages: [], history: [...parts.base.history, ...parts.history, running], ...parts.now() };
  const job = (async () => {
    if (!parts.afford() || !await parts.permit()) return null;
    signal.throwIfAborted();
    return { request, output: await parts.model.decide(request, signal) };
  })().catch(() => null);
  return {
    async settle(ok, timeoutMs = FCA_LOOKAHEAD.settleMs) {
      if (!ok) {
        stop.abort('call_did_not_end_well');
        return null;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>(resolve => {
        timer = setTimeout(() => {
          stop.abort('late');
          resolve(null);
        }, timeoutMs);
      });
      try {
        return await Promise.race([job, late]);
      } finally { clearTimeout(timer); }
    },
  };
}
