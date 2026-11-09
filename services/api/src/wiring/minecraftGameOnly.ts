import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import { MINECRAFT_REQUEST_CRITERIA } from './fcaMinecraftRequests.js';
import type { FcaStepPorts } from '../mind/action/fca/fcaRunner.js';
import { v2MenuTool } from '../surfaces/minecraft/minecraftLlmcV2.js';
import { minecraftContractMenu } from '../surfaces/minecraft/minecraftContractRead.js';

/** A standalone game request, proved by canonical admission (the operator's audit row of an owner_request under the root with the
 * Minecraft criteria), never by a title or a client's audience claim. Private recall, memory and evidence never reach its steps
 * (`gameOnlyStepPorts`), so who else is present does not hold it.
 * Owner 2026-11-09 (before the 11/10 filming, with a third person in the world): the exception is no longer revoked later by a message
 * sent to the task, a child task or a body that is reconnecting. Each of those turned it off, and with anyone else known as present
 * every step was then held as owner_not_alone until the task paused: a filmed run stopped by a safety nobody asked for.
 */
export function gameOnlyMinecraftTask(taskId: string, parts: {
  scopeKey: string; runtime: Pick<TaskRuntime, 'get'>;
  audit: Pick<OperatorAuditStore, 'requestOf'> | null;
}): boolean {
  try {
    const task = parts.runtime.get(parts.scopeKey, taskId);
    if (!task || task.scopeKey !== parts.scopeKey || task.origin !== 'owner_request' || task.kind !== 'generic'
      || task.completionCriteria !== MINECRAFT_REQUEST_CRITERIA || !task.parentId) return false;
    return parts.runtime.get(parts.scopeKey, task.parentId)?.kind === 'root' && !!parts.audit?.requestOf(parts.scopeKey, taskId);
  } catch { return false; }
}

/** Apply on every step, including while alone: a task never accumulates private recall and later becomes public. */
export function gameOnlyStepPorts<T extends Partial<FcaStepPorts>>(ports: T, taskId: string): T {
  const tools = ports.tools ? minecraftContractMenu(ports.tools, v2MenuTool) : undefined;
  return { ...ports, taskTools: false, recall: undefined, bodyRecall: undefined, observeMemory: () => false, evidence: undefined,
    taskVisible: (id: string) => id === taskId, observeTasks: () => false,
    ...(tools ? { tools: { ...tools, skillIndex: undefined, get definitions() { return tools.definitions; },
      async execute(call: Parameters<typeof tools.execute>[0]) {
        if (!v2MenuTool(call)) throw new Error('FCA_TOOL_NOT_OFFERED');
        return tools.execute(call);
      } } } : {}) };
}
