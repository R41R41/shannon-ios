import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import { MINECRAFT_REQUEST_CRITERIA } from './fcaMinecraftRequests.js';
import type { FcaStepPorts } from '../mind/action/fca/fcaRunner.js';
import { v2MenuTool } from '../surfaces/minecraft/minecraftLlmcV2.js';

/** A standalone game request, proved by canonical admission, never by a title or a client's audience claim.
 * Conversation-derived work remains private. A new private source revokes this exception immediately.
 */
export function gameOnlyMinecraftTask(taskId: string, parts: {
  scopeKey: string; runtime: Pick<TaskRuntime, 'get' | 'taskSources'>;
  audit: Pick<OperatorAuditStore, 'requestOf'> | null;
  bound(taskId: string): string | null;
}): boolean {
  try {
    const task = parts.runtime.get(parts.scopeKey, taskId);
    if (!task || task.scopeKey !== parts.scopeKey || task.origin !== 'owner_request' || task.kind !== 'generic'
      || task.completionCriteria !== MINECRAFT_REQUEST_CRITERIA || !task.parentId || task.childIds.length) return false;
    return parts.runtime.get(parts.scopeKey, task.parentId)?.kind === 'root' && !!parts.bound(taskId)
      && !!parts.audit?.requestOf(parts.scopeKey, taskId) && parts.runtime.taskSources(parts.scopeKey, taskId).length === 0;
  } catch { return false; }
}

/** Apply on every step, including while alone: a task never accumulates private recall and later becomes public. */
export function gameOnlyStepPorts<T extends Partial<FcaStepPorts>>(ports: T, taskId: string): T {
  const tools = ports.tools;
  return { ...ports, taskTools: false, recall: undefined, bodyRecall: undefined, observeMemory: () => false, evidence: undefined,
    taskVisible: (id: string) => id === taskId, observeTasks: () => false,
    ...(tools ? { tools: { ...tools, skillIndex: undefined, definitions: tools.definitions.filter(v2MenuTool),
      async execute(call: Parameters<typeof tools.execute>[0]) {
        if (!v2MenuTool(call)) throw new Error('FCA_TOOL_NOT_OFFERED');
        return tools.execute(call);
      } } } : {}) };
}
