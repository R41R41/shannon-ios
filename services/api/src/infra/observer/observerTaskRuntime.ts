import type { ObserverTaskLink } from '../../contracts/observerContract.js';
import type { TaskRuntime, TaskView } from '../../mind/action/taskRuntime/taskRuntimePorts.js';
import { observeSync, observerHandoff, withObserverRunSync, withObserverTask } from './observerContext.js';

const mutations = new Set(['createChild','send','observeExternal','admitSleep','beginConversation','beginConversationDelivery',
  'completeConversation','stageConversationDelivery','bindConversationDelivery','failConversation','beginStep','commitStep','recordStoppedStep',
  'wait','stop','resume','acknowledgeStop']);
/** Observe canonical runtime operation returns (an enclosing transaction may still be open). The canonical runtime still owns every transaction and decision. */
export function observedTaskRuntime(runtime: TaskRuntime, ownerAlone: () => boolean): TaskRuntime {
  const methods = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
  return new Proxy(runtime, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    const cached = methods.get(property);
    if (cached && cached.original === value) return cached.wrapped;
    const original = value.bind(target) as (...args: unknown[]) => unknown;
    const wrapped = typeof property !== 'string' || !mutations.has(property) ? original : (...args: unknown[]) => {
      const first = args[0] as { scopeKey?: string; taskId?: string; id?: string; lease?: { id: string }; snapshot?: { task: TaskView } } | string;
      const scopeKey = typeof first === 'string' ? first : first.scopeKey;
      if (!scopeKey) return original(...args);
      const targetIndex = property === 'send' ? 2 : ['createChild','observeExternal','beginStep','wait','stop','resume'].includes(property) ? 1 : null;
      const link: ObserverTaskLink = typeof first === 'string' ? targetIndex !== null && typeof args[targetIndex] === 'string' ? { taskId: args[targetIndex] as string } : {} : { taskId: first.taskId, stepId: first.id,
        actionId: first.lease?.id, parentTaskId: first.snapshot?.task.parentId };
      let audience: 'owner' | 'others' = 'others';
      try { if (ownerAlone()) audience = 'owner'; } catch { /* Unknown audience never enables observation. */ }
      return withObserverRunSync({ scopeKey, surface: 'task_hub', audience }, () => {
        const operation = () => {
        const result = observeSync('taskHub', { operation: property, boundary: 'runtime_return' }, () => original(...args), value => projection(value));
        const tasks = Array.isArray(result) ? result.map(taskOf).filter((task): task is TaskView => task !== null) : [taskOf(result)].filter((task): task is TaskView => task !== null);
        for (const task of tasks) withObserverTask({ taskId: task.id, parentTaskId: task.parentId }, () => {
          observeSync('taskHub', { phase: 'returned_state', operation: property, boundary: 'runtime_return' }, () => undefined,
            () => ({ phase: task.phase, revision: task.revision }));
          const next = task.phase === 'ready' ? 'queue' : task.phase === 'waiting' ? 'wait' : 'taskHub';
          observerHandoff('taskHub', next, { operation: property, phase: task.phase, revision: task.revision });
        });
        return result;
        };
        return Object.keys(link).length ? withObserverTask(link, operation) : operation();
      });
    };
    methods.set(property, { original: value, wrapped }); return wrapped;
  } });
}
function taskOf(value: unknown): TaskView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { task?: TaskView; step?: { snapshot: { task: TaskView } }; snapshot?: { task: TaskView }; id?: string; phase?: string };
  return record.task ?? record.step?.snapshot.task ?? record.snapshot?.task ?? (record.id && record.phase ? value as TaskView : null);
}
function projection(value: unknown) {
  const task = taskOf(value);
  if (task) return { taskId: task.id, parentTaskId: task.parentId, phase: task.phase, revision: task.revision };
  if (Array.isArray(value)) return { taskCount: value.length };
  return { accepted: typeof value === 'boolean' ? value : value !== null };
}
