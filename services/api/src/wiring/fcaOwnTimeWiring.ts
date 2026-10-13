import { switchOn } from '@shannon/switches';
import type { CompanionStateStore } from '@shannon/cognition';
import { actionPermit, currentActionExecution } from '../infra/context/actionExecution.js';
import { createFcaProgressTools } from '../mind/action/fca/fcaProgressTools.js';
import type { FcaToolSelector } from '../mind/selectors/selectorsPorts.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import type { ShannonToolRunner } from '../mind/tools/toolRunnerPorts.js';
import type { TaskRuntime, TaskStep, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { SQLiteAutonomyStore } from '../mind/action/ownTime/ownTimePorts.js';
import { autonomyBudgetStatus, autonomyDayKey, yenFromUsd, type AutonomyConfig } from '../mind/inhibition/inhibitionPorts.js';
import { combineFcaTools } from './fcaMinecraftTools.js';
import { fcaResearchTools } from './fcaResearchWiring.js';
import type { OwnTimeBudgetPort } from './fcaBudgetWiring.js';

/**
 * Own-time FCA tasks (Syzygy ADR-0009 stage 2, E4). The Executive admits one (origin `own_time`); the API process runs its steps
 * like any task, under these rules carried over from her own time:
 * - it runs only while her own time is enabled and not paused, and her day's budget has room (the Executive admits it);
 * - who is present does not hold it, because it sees nothing of a conversation: it inherits no source, has no memory, task or
 *   body tools, and reads public pages only (`web.search`, `web.read`), each call still checked for a secret of a conversation.
 */
export interface OwnTimeFcaParts {
  store: SQLiteAutonomyStore;
  config: AutonomyConfig;
}

export function ownTimeBudgetPort(parts: OwnTimeFcaParts, model: string): OwnTimeBudgetPort {
  const dayKey = (at: string) => autonomyDayKey(at, parts.config);
  return {
    dayKey,
    budget(scopeKey) {
      const day = dayKey(new Date().toISOString());
      return autonomyBudgetStatus(day, parts.store.spentYen(scopeKey, day), parts.store.approvedExtraYen(scopeKey, day), parts.config);
    },
    recordSpend(scopeKey, at, spend) {
      parts.store.recordSpend(scopeKey, dayKey(at), at, {
        model, purpose: 'fca_own_time', inputTokens: 0, outputTokens: 0, costUsd: spend.usd, costYen: spend.yen,
      });
    },
    yen: usd => yenFromUsd(usd, parts.config),
  };
}

/**
 * Whether an own-time task may run now. It does not read `SHANNON_EXECUTIVE` of this process: such a task exists only because the
 * Executive of the own-time worker admitted it, so the gate is her own time's state (enabled, not paused, budget left), which both
 * processes read from the same store. The switch is read here only to say at startup when this process's environment disagrees.
 */
export function ownTimeTaskAllowed(
  values: Readonly<Record<string, string | undefined>>, parts: OwnTimeFcaParts | undefined, budget: OwnTimeBudgetPort | null,
) {
  if (parts && !switchOn(values, 'SHANNON_EXECUTIVE')) {
    console.log('Shannon FCA: SHANNON_EXECUTIVE is off in this process; own-time tasks the worker admits still run under her own-time gate.');
  }
  return (task: TaskView): boolean => {
    if (!parts || !budget || !parts.config.enabled) return false;
    try {
      return !parts.store.control(task.scopeKey).paused && !budget.budget(task.scopeKey).exhausted;
    } catch { return false; }
  };
}

/** The ports of one own-time step: public reading only, no task, memory, body or conversation. */
export function ownTimeStepPorts(step: TaskStep, parts: {
  runtime: TaskRuntime; selector: FcaToolSelector; history: { codec: unknown; summarizer: unknown };
  tools?: ShannonToolRunner; state?: Pick<CompanionStateStore, 'snapshot'>; conversations?: ConversationStore;
}) {
  const sourcesVisible = () => step.snapshot.sources.length === 0;
  const permit = async () => {
    await actionPermit();
    const active = currentActionExecution();
    if (!active || active.lease.id !== step.lease.id || !sourcesVisible()) throw new Error('FCA_SOURCE_WITHHELD');
    active.signal.throwIfAborted();
    if (parts.runtime.get(step.scopeKey, step.taskId)?.phase !== 'executing') throw new Error('FCA_TASK_STOPPING');
  };
  const research = parts.tools && parts.state && parts.conversations ? fcaResearchTools({
    tools: parts.tools, state: parts.state, conversations: parts.conversations,
    task: { id: step.taskId, origin: 'own_time', leaseId: step.lease.id }, checkpoint: step.snapshot.checkpoint, scopeKey: step.scopeKey,
    ownerAlone: () => true, sourcesVisible }) : null;
  return {
    selector: parts.selector, taskTools: false, sourcesVisible, taskVisible: (id: string) => id === step.taskId, observeTasks: () => false,
    history: parts.history as never,
    tools: createFcaProgressTools(research ? combineFcaTools(research) : combineFcaTools(), { checkpoint: step.snapshot.checkpoint, permit }),
  };
}
