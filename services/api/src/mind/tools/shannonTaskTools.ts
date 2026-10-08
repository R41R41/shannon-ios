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
  visible?(taskId: string): boolean;
  observed?(taskIds: readonly string[]): boolean;
}
export function executeTaskTool(runtime: TaskRuntime, name: string, input: unknown, context: TaskToolContext): ToolResult {
  const tool = TASK_TOOLS.find(item => item.name === name) ?? null;
  const denied = authorizeToolCall(tool, { scopeKey: context.scopeKey, surface: 'text', audience: context.ownerAlone() ? 'owner_alone' : 'others' });
  if (denied) return denied;
  const parsed = validToolInput(input, tool!.input);
  if ('problem' in parsed) return toolFailure('invalid_input', parsed.problem);
  const source = runtime.get(context.scopeKey, context.taskId);
  if (!source || source.origin !== 'owner_request' || source.phase !== 'executing') return toolFailure('refused', 'このタスクは実行中ではない。');
  if (context.visible && !context.visible(context.taskId)) return toolFailure('refused', 'このタスクの情報は今は参照できない。');
  const value = parsed.input;
  if ((name === 'task.get' || name === 'task.send') && context.visible && !context.visible(String(value.id))) return toolFailure('not_found', 'タスクが見つからない。');
  try {
    let result: unknown;
    const observe = (ids: readonly string[]) => { if (context.observed && !context.observed(ids)) throw new Error('FCA_SOURCE_WITHHELD'); };
    const project = (task: NonNullable<ReturnType<TaskRuntime['get']>>) => ({ ...task, childIds: task.childIds.filter(id => !context.visible || context.visible(id)) });
    switch (name) {
      case 'task.create': {
        const task = runtime.createChild(context.scopeKey, context.taskId, { title: String(value.title), goal: String(value.goal), completionCriteria: String(value.completionCriteria), ...(value.context ? { context: String(value.context) } : {}) }, context.operationId);
        result = project(task); break;
      }
      case 'task.list': { const tasks = runtime.list(context.scopeKey, { offset: Number(value.offset ?? 0), limit: 50 }).filter(task => !context.visible || context.visible(task.id)); observe(tasks.map(task => task.id)); result = tasks.map(project); break; }
      case 'task.get': { const task = runtime.get(context.scopeKey, String(value.id)); if (task) observe([task.id]); result = task ? project(task) : null; break; }
      case 'task.send': { observe([String(value.id)]); const sent = runtime.send(context.scopeKey, context.taskId, String(value.id), String(value.message), context.operationId); result = { ...sent, task: project(sent.task) }; break; }
      default: return toolFailure('not_offered', 'この道具は使えない。');
    }
    return result === null ? toolFailure('not_found', 'タスクが見つからない。') : toolOk(JSON.stringify(result));
  } catch (error) {
    const code = error instanceof Error && /^FCA_[A-Z_]+$/.test(error.message) ? error.message : 'FCA_TASK_OPERATION_FAILED';
    return toolFailure('conflict', code, { retryable: false });
  }
}
