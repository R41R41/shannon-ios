import type { createFcaPlanTools } from '../mind/action/fca/fcaPlanTools.js';
import { PLAN_UPDATE_TOOL } from '../mind/action/fca/fcaPlanTools.js';
import type { FcaModel } from '../mind/action/fca/fcaPorts.js';
import type { TaskStep } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import { toolOk } from '../mind/tools/shannonTools.js';
import { REDECIDE_GIVE_UP_MS, type RedecidePort } from '../surfaces/minecraft/minecraftLlmcRedecide.js';
import { decidedBy, redecideLabel, type LlmcWiring } from './minecraftLlmcConfiguration.js';

/**
 * Amendment A-10: the model that decided this step (the main one, the strong one of the late game, or the escalation while the task is stuck);
 * an act of it that would break a promise is decided again by Opus (`FcaModel.redecide`: the step's last request with the act and the promise
 * line added). Opus's plan.update goes through the plan's own tool, and one the model already made in this step (the same input) is not made
 * twice. A model that is Opus already has nothing to ask: no port.
 */
export function redecideParts(llmc: LlmcWiring, model: FcaModel, step: TaskStep, plan: ReturnType<typeof createFcaPlanTools>,
  log: (line: string) => void): { planTools: typeof plan.tools; redecide: RedecidePort | undefined } {
  const planned = new Set<string>();
  const planTools: typeof plan.tools = { ...plan.tools, execute: call => {
    if (call.name === PLAN_UPDATE_TOOL) planned.add(JSON.stringify(call.input));
    return plan.tools.execute(call);
  } };
  const redecide: RedecidePort | undefined = model.redecide ? { label: redecideLabel(decidedBy(llmc, model)),
    ask: (note, signal) => model.redecide!({ taskId: step.taskId, note, signal, timeoutMs: REDECIDE_GIVE_UP_MS }),
    planUpdate: async (input, signal, operationId) => {
      const key = JSON.stringify(input);
      if (planned.has(key)) return toolOk('同じ plan.update はこの段で通してある');
      planned.add(key);
      return plan.tools.execute({ scopeKey: step.scopeKey, taskId: step.taskId, operationId, name: PLAN_UPDATE_TOOL, input, signal });
    },
    log } : undefined;
  return { planTools, redecide };
}
