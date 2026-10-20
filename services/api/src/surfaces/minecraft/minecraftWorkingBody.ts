import type { FcaBodyLifecycle, FcaToolCall } from '../../mind/action/fca/fcaPorts.js';
import type { TaskRuntime, TaskStep } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from './minecraftControl.js';
import type { WorkingNeed } from '@shannon/mind';
import { createMinecraftWorkingArbiter } from './minecraftWorkingArbiter.js';
import { MINECRAFT_PROCEDURE_TOOL } from './minecraftProcedures.js';

/** The working field with the executor's lines (`agenda`) beside the arbiter's. */
function withAgenda(fields: { working?: Record<string, unknown> }, agenda: readonly string[]): Record<string, unknown> {
  if (!agenda.length) return fields;
  return { working: { ...(fields.working ?? {}), agenda } };
}

/**
 * A Minecraft task's body with the working events on (session mb-arch, stage 1; `SHANNON_MINECRAFT_WORKING_EVENTS`). It wraps the
 * adapter's body (`createMinecraftTaskBody`) instead of growing it: its own watch every 250 ms asks the arbiter about the running
 * `mc.*` command, and a cut aborts that command and makes the decision stale. Its own count of cuts is added to the adapter's revision,
 * and `guard` takes it off again, so a decision is current only when neither changed (both only grow). Each decision's context, and
 * the transient state built from it, get the `working` field.
 */
export function withMinecraftWorking<Made extends { body: FcaBodyLifecycle }>(made: Made, parts: {
  /** The switch: off, the adapter's body is returned as it is. */
  on: boolean;
  control: MinecraftControl; runtime: TaskRuntime; step: TaskStep; now?: () => number; log?(line: string): void; pollMilliseconds?: number;
  /** The executor's (`minecraftAgenda.ts`): it takes a need that came into reach during a wait, so the wait is not cut. */
  onWaitNeed?(need: WorkingNeed): boolean;
  /** The executor's: what it did for her since the last decision, a line each. */
  agendaLines?(): string[];
  /**
   * The executor's procedure (`minecraftProcedureTool.ts`): its running item is what the arbiter follows, and a cut stops that item only
   * (the planner's call goes on, so the decision stays current).
   */
  procedure?: { item(): { name: string; input: unknown; operationId: string } | null; cut(): boolean };
}): Made {
  if (!parts.on) return made;
  const { control, runtime, step } = parts, inner = made.body;
  const bodyId = () => control.store.body(step.taskId);
  const frame = () => {
    const id = bodyId();
    return id ? control.observe(id) : null;
  };
  const events = () => {
    const id = bodyId();
    return id ? control.working(id) : null;
  };
  const arbiter = createMinecraftWorkingArbiter({ log: events,
    now: parts.now ?? Date.now, taskId: step.taskId, stepId: step.id, line: parts.log ?? (line => console.info(line)),
    send: (text, id) => runtime.send(step.scopeKey, step.taskId, step.taskId, text, id), ...(parts.onWaitNeed ? { onWaitNeed: parts.onWaitNeed } : {}),
    ...(parts.procedure ? { onCut: () => procedureItemOn() && parts.procedure!.cut() } : {}) });
  const aborts = new Set<AbortController>();
  let cuts = 0, closed = false, timer: ReturnType<typeof setInterval> | undefined, fields: Record<string, unknown> = {};
  /** The procedure's item the arbiter follows now (its operation id), kept in step with the executor's. */
  let followed: { name: string; operationId: string } | null = null;
  const procedureItemOn = () => followed !== null;
  const followProcedure = () => {
    const item = parts.procedure?.item() ?? null;
    if (item?.operationId === followed?.operationId) return;
    if (followed) arbiter.end(followed.name);
    followed = item ? { name: item.name, operationId: item.operationId } : null;
    if (item) arbiter.begin(item, item.operationId);
  };
  const watch = () => {
    if (closed || runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') return;
    followProcedure();
    if (arbiter.check(frame()).act !== 'cut') return;
    cuts += 1;
    aborts.forEach(abort => abort.abort());
  };
  const body: FcaBodyLifecycle = {
    ...inner,
    start(signal) {
      inner.start(signal);
      if (timer || closed) return;
      timer = setInterval(() => {
        try {
          watch();
        } catch { /* the watch never fails a step */ }
      }, parts.pollMilliseconds ?? 250);
      timer.unref();
    },
    revision: () => inner.revision() + cuts,
    context() {
      const value = inner.context();
      fields = withAgenda(arbiter.fields(frame()), parts.agendaLines?.() ?? []);
      return { ...value, revision: value.revision + cuts, ...fields };
    },
    ...(inner.transient ? { transient: () => ({ ...inner.transient!(), ...fields }) } : {}),
    guard: version => inner.guard(version - cuts),
    ...(inner.guardFor ? { guardFor: (version: number, call: FcaToolCall) => inner.guardFor!(version - cuts, call) } : {}),
    toolSignal(name, parent) {
      const signal = inner.toolSignal(name, parent);
      if (!name.startsWith('mc.')) return signal;
      const abort = new AbortController();
      aborts.add(abort);
      if (signal.aborted) abort.abort(); else signal.addEventListener('abort', () => abort.abort(), { once: true });
      return abort.signal;
    },
    noteCall(call, operationId) {
      inner.noteCall?.(call, operationId);
      // A procedure is followed item by item (`followProcedure`), not as one long command.
      if (call.name !== MINECRAFT_PROCEDURE_TOOL) arbiter.begin(call, operationId);
    },
    noteResult(call, result, durationMilliseconds) {
      inner.noteResult?.(call, result, durationMilliseconds);
      if (call.name !== MINECRAFT_PROCEDURE_TOOL) {
        arbiter.end(call.name);
        return;
      }
      // The procedure ended: its last item is not followed until the next watch (the next decision would see it as running).
      if (followed) arbiter.end(followed.name);
      followed = null;
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      aborts.clear();
      await inner.close();
    },
  };
  return { ...made, body };
}
