import type { ProviderFunctionCall, ShannonModelToolSession, ToolCallOutcome } from './chatModelTools.js';
import { providerToolName, type ShannonToolDefinition } from '../../mind/tools/shannonTools.js';
import { MINIMUM_CALL_MILLISECONDS, TOOL_CALL_CAP_MILLISECONDS } from '../../mind/action/respond/turnDeadline.js';

/**
 * The calls of one model step (one response that asks for tools), run together where that is safe (Syzygy ADR-0003
 * stage 4; owner decision 2026-10-06). The rule, in the model's order:
 *
 * - A run of reading tools (`effect: 'read'`) one after another starts at once and runs concurrently, except that the
 *   reads of one lane (`toolLane`) run one after the other: her PC hands its device one conversation operation at a
 *   time (`hostFolderOperations.ts`), and every queued operation waits for it from the moment it is queued, so folder
 *   reads queued together would only wait for each other and the last could time out. A read of a lane takes its time
 *   from the deadline when it starts, not when the model asked for it.
 * - Anything else (a write, or a name this turn does not offer) waits until everything before it has ended, and
 *   nothing after it starts until it has ended. So a write never runs beside another call, any read or write that the
 *   model put after a write sees what the write did, and two writes to one target are always one after the other.
 * - Every call still goes through the session (the runner's one gate, `authorizeToolCall`, and the activity record),
 *   with the same checks as before in the same order: the turn's call limit, then the time left, then the offer.
 * - Each call gets min(10 s, what is left minus the answer's reserve) of the turn's deadline when it starts, and is
 *   cancelled at that time through its signal (an operation on her PC that was not taken is dropped, as before), or
 *   at once when the caller stops the turn. A run of reads takes as long as its slowest lane, not the sum of its calls.
 * - The results go back to the model in the model's order, and each call is noted in the turn's trace in that order
 *   (`ToolCallOutcome.note`), whichever ended first. The activity record is written by each call as it ends.
 *
 * `SHANNON_PARALLEL_TOOLS=off` runs every call alone, one after the other, as before this change, and a text turn
 * asks the model for one call at a time again (`parallel_tool_calls: false`).
 */
export function parallelToolsEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return !['off', 'false', '0', 'disabled', 'no', 'none'].includes(environment.SHANNON_PARALLEL_TOOLS?.trim().toLowerCase() ?? '');
}

/**
 * Whether a request offering these tools asks for several calls in one response. Not while a write is offered: a text
 * round has 2,200 output tokens and a conversation write up to 1,500 characters, so two writes in one response would be
 * cut off at the ceiling and none of its calls would run (review of 2026-10-06).
 */
export function asksForParallelCalls(definitions: readonly Pick<ShannonToolDefinition, 'effect'>[], environment?: Readonly<Record<string, string | undefined>>): boolean {
  return parallelToolsEnabled(environment) && !definitions.some(tool => tool.effect === 'write');
}

/** Reads that must not run beside each other: those that reach the same device (one host in practice). */
export function toolLane(tool: Pick<ShannonToolDefinition, 'domain'>): string | null {
  return tool.domain === 'host_folder' ? 'host_folder' : null;
}

/** A call of a name the request did not offer: nothing ran. */
export const NOT_OFFERED = JSON.stringify({ ok: false, text: 'この返事ではその道具は出していない。', failure: 'not_offered', retryable: false });
/** A call that was not run because the turn's time ran short: nothing of it happened. */
export const SKIPPED_FOR_TIME = JSON.stringify({ ok: false, text: '時間が足りず実行しなかった（何もしていない）。', failure: 'timeout', retryable: true });
const OVER_LIMIT = JSON.stringify({ ok: false, text: 'この返事で使える道具の数を超えた。いまある結果で答える。', failure: 'limit', retryable: false });

/** What the tool rounds of one turn carry from step to step. */
export interface ToolStepState {
  /** Calls that ran (were handed to the session), in the whole turn. */
  used: number;
  /** No more call runs in this turn (its time ran short, or its round was cut off). */
  toolsOff: boolean;
}

export interface ToolStepOptions {
  /** The caller's own cancellation: in-flight calls end at once, are noted, and then the step throws. */
  signal?: AbortSignal;
  /** Whether reads may run concurrently (`parallelToolsEnabled`). */
  parallel: boolean;
}

interface Running { index: number; outcome: Promise<ToolCallOutcome> }

/** The result of a call of a lane that did not start: the caller stopped, or the turn's time ran short before its turn. */
const NOT_STARTED: ToolCallOutcome = { output: SKIPPED_FOR_TIME, note: () => {} };

/**
 * Runs the calls of one step and returns, in the model's order, each call and its result as input items for the next
 * round. Throws only when the caller stopped the turn, after every call that had started has ended and been noted.
 */
export async function runToolStep(
  calls: readonly ProviderFunctionCall[], session: ShannonModelToolSession, state: ToolStepState, options: ToolStepOptions,
): Promise<unknown[]> {
  const deadline = session.deadline;
  const offered = new Map<string, ShannonToolDefinition>(session.definitions.map(tool => [providerToolName(tool.name), tool]));
  const start = session.start?.bind(session)
    ?? (async (name: string, args: string, signal?: AbortSignal, time?: number): Promise<ToolCallOutcome> => ({ output: await session.call(name, args, signal, time), note: () => {} }));
  const outputs: string[] = new Array(calls.length);
  let running: Running[] = [];
  let lanes = new Map<string, Promise<unknown>>();
  /** Starts one call under its own signal, which is let go when the call ends however it ends. */
  const begin = (call: ProviderFunctionCall, callTime: number): Promise<ToolCallOutcome> => {
    const time = callSignal(callTime, options.signal);
    let outcome: Promise<ToolCallOutcome>;
    try { outcome = start(call.name, call.arguments, time.signal, callTime); } catch (error) { time.stop(); throw error; }
    return outcome.finally(time.stop);
  };
  /** Waits for every running call, then notes them in the model's order. */
  const settle = async () => {
    if (!running.length) return;
    const group = running;
    running = [];
    lanes = new Map();
    const settled = await Promise.allSettled(group.map(item => item.outcome));
    let failure: unknown;
    settled.forEach((result, position) => {
      if (result.status === 'fulfilled') {
        outputs[group[position]!.index] = result.value.output;
        result.value.note();
      } else failure ??= result.reason;
    });
    if (failure !== undefined) throw failure;
  };
  const stopped = async () => {
    if (!options.signal?.aborted) return;
    await settle();
    options.signal.throwIfAborted();
  };
  for (const [index, call] of calls.entries()) {
    const tool = offered.get(call.name);
    const alone = !options.parallel || tool?.effect !== 'read';
    if (alone) await settle();
    // Checked when the call would start: after what it waits for, so nothing starts once the caller stopped.
    await stopped();
    const callTime = deadline.forStep(TOOL_CALL_CAP_MILLISECONDS);
    if (state.used >= session.maximumCalls) {
      outputs[index] = OVER_LIMIT;
    } else if (state.toolsOff || callTime < MINIMUM_CALL_MILLISECONDS) {
      // The answer's reserve is reached: the rest of this response's calls are not run.
      outputs[index] = SKIPPED_FOR_TIME;
      state.toolsOff = true;
    } else if (!offered.has(call.name)) {
      // Only the names offered in this request run, whatever the model writes (`folder.create` is not offered).
      outputs[index] = session.refuse?.(call.name) ?? NOT_OFFERED;
    } else {
      state.used += 1;
      const lane = alone ? null : toolLane(tool!);
      if (!lane) running.push({ index, outcome: begin(call, callTime) });
      else {
        // After the lane's call before it, with the time that is left then; nothing more starts once the caller stopped.
        const outcome = (lanes.get(lane) ?? Promise.resolve()).then(() => {
          const time = deadline.forStep(TOOL_CALL_CAP_MILLISECONDS);
          if (options.signal?.aborted) return NOT_STARTED;
          if (state.toolsOff || time < MINIMUM_CALL_MILLISECONDS) {
            state.toolsOff = true;
            state.used -= 1;
            return NOT_STARTED;
          }
          return begin(call, time);
        });
        lanes.set(lane, outcome.catch(() => {}));
        running.push({ index, outcome });
      }
    }
    if (alone) await settle();
  }
  await settle();
  await stopped();
  return calls.flatMap((call, index) => [
    { type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments },
    { type: 'function_call_output', call_id: call.callId, output: outputs[index]! },
  ]);
}

/** The signal of one call: aborted at its time (a `TimeoutError`), or with the caller's reason when the caller stops. */
function callSignal(milliseconds: number, caller?: AbortSignal): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The tool call ran out of its time.', 'TimeoutError')), Math.max(1, milliseconds));
  const follow = () => controller.abort(caller?.reason);
  if (caller?.aborted) follow(); else caller?.addEventListener('abort', follow, { once: true });
  return { signal: controller.signal, stop: () => { clearTimeout(timer); caller?.removeEventListener('abort', follow); } };
}
