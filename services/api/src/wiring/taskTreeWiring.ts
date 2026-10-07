import type { AgentTaskStore } from '../mind/action/agentTasks/agentTasksPorts.js';
import { taskTreeRoute } from '../mind/action/agentTasks/taskTreeRoutes.js';
export function taskTreeWiring(tasks: AgentTaskStore, ownerScope: string, now: () => string) {
  return { route: taskTreeRoute(tasks.taskTrees, ownerScope, now),
    proofStatus: (scopeKey: string, taskId: string) => tasks.taskTrees?.proofStatus(scopeKey, taskId) ?? { status: 'invalid' as const },
    proofForTask: (scopeKey: string, taskId: string) => tasks.taskTrees?.proofForTask(scopeKey, taskId) ?? null };
}
