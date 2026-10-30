import type { FcaToolCall } from "../mind/action/fca/fcaPorts.js";
import { type ToolResult } from "../mind/tools/shannonTools.js";
import type { FcaBodyLifecycle } from "../mind/action/fca/fcaPorts.js";
import { TAKE_MS } from "./minecraftHeadTake.js";
import type { BodyTaskContext } from "../contracts/bodyControlContract.js";
import { waitForResend } from "./minecraftResumeOrder.js";



/** The hold a body named when it refused an act as held (「保留中（<id>: <why>）…」), or null. */
export function bodyHoldOf(result: string | undefined): { incident: string; why: string } | null {
  const found = /保留中（([^:：）]+)[:：]\s*([^）]*)）/u.exec(result ?? '');
  return found ? { incident: found[1]!.trim(), why: found[2]!.trim() } : null;
}

/**
 * Run 44: the held act sent again once the step has begun (inside its execution, where its lease may take the
 * body), then the step
 * as ever. Chapter 8's 再開の契約: the
 * first decision is not asked until that act has ended or been held again (`beforeDecision`), so its result is
 * what the decision reads first.
 */
export function withResend(lifecycle: FcaBodyLifecycle, resend: ((signal: AbortSignal) => Promise<void>) | null, log: (line: string) => void, taskId: string,
  wait: { open(): boolean; limitMs(): number }): FcaBodyLifecycle {
  if (!resend) return lifecycle;
  const start = lifecycle.start.bind(lifecycle);
  let sent: Promise<void> | null = null;
  return Object.assign(lifecycle, {
    start(signal: AbortSignal) {
      start(signal);
      if (sent) return;
      sent = resend(signal).catch(error => log(`Shannon Minecraft incident resend failed task=${taskId} ${String(error)}`));
    },
    async beforeDecision(signal: AbortSignal) {
      const how = await waitForResend({ sent, open: wait.open, signal, limitMs: wait.limitMs() });
      if (how !== 'ended') log(`Shannon Minecraft resume wait task=${taskId} how=${how}`);
    },
  });
}


/** The command context with the fix run's incident fields (`minecraftIncidentHold.ts`): unchanged when there is
 * nothing to say. */
export function withIncident(context: BodyTaskContext, hold: boolean, resume: string | null): BodyTaskContext {
  if (!hold && !resume) return context;
  return { ...context, incident: { ...(hold ? { hold: true } : {}), ...(resume ? { resume } : {}) } };
}


/**
 * Amendment A-12: the lifecycle of a task that asked to be held, looking for the stalls the head finds itself
 * (`minecraftLlmcStalls.ts`): at each decision's start and after each
 * result of a tool (`look`), and `mc.act` answers for the refusals before sending (`refused`). A stall found at
 * a decision's start stops the decision: the hold is being made
 * (`watch.settled`: the body asked to hold and the task's stop begun; `HOLD_SETTLE_MS` at most), and the step's
 * next permit check ends it once the task is stopped.
 */
export const HOLD_SETTLE_MS = TAKE_MS + 2_000;

export function withStalls(lifecycle: FcaBodyLifecycle, watch: { look(): boolean; refused(call: FcaToolCall, result: ToolResult): boolean;
   settled?(): Promise<void> } | null): FcaBodyLifecycle {
  if (!watch) return lifecycle;
  const before = lifecycle.beforeDecision?.bind(lifecycle), noted = lifecycle.noteResult?.bind(lifecycle);
  return Object.assign(lifecycle, {
    async beforeDecision(signal: AbortSignal) {
      await before?.(signal);
      if (!watch.look()) return;
      if (signal.aborted) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, HOLD_SETTLE_MS);
        timer.unref?.();
        const done = () => { clearTimeout(timer);
          resolve(); };
        signal.addEventListener('abort', done, { once: true });
        void (watch.settled?.() ?? Promise.resolve()).then(done, done);
      });
    },
    noteResult(call: FcaToolCall, result: ToolResult, durationMilliseconds?: number) {
      noted?.(call, result, durationMilliseconds);
      if (!watch.refused(call, result)) watch.look();
    },
  });
}
