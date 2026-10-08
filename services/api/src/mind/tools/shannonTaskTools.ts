import type { ToolResult } from './shannonTools.js';
import { toolFailure, toolOk } from './shannonTools.js';
import { validToolInput } from './shannonToolInput.js';
import { authorizeToolCall } from '../inhibition/toolGatePorts.js';
import type { TaskRuntime } from '../action/taskRuntime/taskRuntimePorts.js';

import { TASK_TOOLS } from './taskToolDefinitions.js';
export { TASK_TOOLS } from './taskToolDefinitions.js';

export interface TaskToolContext {
  scopeKey: string; taskId: string; operationId: string;
  /** Rechecked at use time; never taken from model arguments. */
  ownerAlone(): boolean;
}
export function executeTaskTool(runtime: TaskRuntime, name: string, input: unknown, context: TaskToolContext): ToolResult {
  const tool = TASK_TOOLS.find(item => item.name === name) ?? null;
  const denied = authorizeToolCall(tool, { scopeKey: context.scopeKey, surface: 'text', audience: context.ownerAlone() ? 'owner_alone' : 'others' });
  if (denied) return denied;
  const parsed = validToolInput(input, tool!.input);
  if ('problem' in parsed) return toolFailure('invalid_input', parsed.problem);
  const source = runtime.get(context.scopeKey, context.taskId);
  if (!source || source.origin !== 'owner_request' || source.phase !== 'executing') return toolFailure('refused', 'このタスクは実行中ではない。');
  const value = parsed.input;
  try {
    let result: unknown;
    switch (name) {
      case 'task.create': {
        const task = runtime.createChild(context.scopeKey, context.taskId, { title: String(value.title), goal: String(value.goal), completionCriteria: String(value.completionCriteria), ...(value.context ? { context: String(value.context) } : {}) }, context.operationId);
        result = task; break;
      }
      case 'task.list': result = runtime.list(context.scopeKey, { offset: Number(value.offset ?? 0), limit: 50 }); break;
      case 'task.get': result = runtime.get(context.scopeKey, String(value.id)); break;
      case 'task.send': result = runtime.send(context.scopeKey, context.taskId, String(value.id), String(value.message), context.operationId); break;
      default: return toolFailure('not_offered', 'この道具は使えない。');
    }
    return result === null ? toolFailure('not_found', 'タスクが見つからない。') : toolOk(JSON.stringify(result));
  } catch (error) {
    const code = error instanceof Error && /^FCA_[A-Z_]+$/.test(error.message) ? error.message : 'FCA_TASK_OPERATION_FAILED';
    return toolFailure('conflict', code, { retryable: false });
  }
}
