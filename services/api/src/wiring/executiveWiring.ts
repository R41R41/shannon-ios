import { switchOn } from '@shannon/switches';
import { activityOfCapability, foldedValueCells, type ValueCell } from '@shannon/learning';
import { coarseMood, type MoodLabel } from '@shannon/mind';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import { createExecutive, type ExecutiveChoices, type ExecutiveTasks } from '../mind/action/executive/executive.js';
import type { ExecutivePort } from '../mind/action/ownTime/ownTimePorts.js';
import type { ChoiceLedger } from '../mind/learning/choiceLedger.js';
import { SQLiteFcaTaskAuthority } from '../mind/action/agentTasks/store/fcaTaskAuthority.js';
import { migrateAgentTasks } from '../mind/action/agentTasks/store/agentTaskPersistence.js';
import { SQLiteTaskRuntimeStore } from '../mind/action/taskRuntime/store/taskRuntimeStore.js';
import { TaskOwnTimeStore } from '../mind/action/taskRuntime/store/taskOwnTimeStore.js';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';

/**
 * The Executive in the own-time worker (Syzygy ADR-0009 stage 2, E5), behind `SHANNON_EXECUTIVE` (explicit `on`, default off;
 * needs `SHANNON_AUTONOMY_ENABLED`). It is handed to the one loop of the worker, so it holds the same lease (`activity-loop`):
 * with it on the old loop never thinks on its own, and with it off the loop is exactly what it was. Own-time FCA tasks (E4) are
 * offered only while the common FCA runtime is on (`SHANNON_FCA_RUNTIME`); the API process runs them.
 */
export interface ExecutiveWiringParts {
  databasePath: string;
  now(): string;
  values?: { activeCells(scopeKey: string): ValueCell[] } | null;
  choices?: ChoiceLedger | null;
  state?: { read(scopeKey: string, at: string): CompanionStateSnapshot | null } | null;
  interests?: (scopeKey: string) => readonly { id: string; weight: number }[];
  log?(line: string): void;
}

export function configuredExecutive(
  environment: Readonly<Record<string, string | undefined>>, parts: ExecutiveWiringParts,
): { executive: ExecutivePort; close(): void } | null {
  if (!switchOn(environment, 'SHANNON_EXECUTIVE') || !switchOn(environment, 'SHANNON_AUTONOMY_ENABLED')) return null;
  const tasks = switchOn(environment, 'SHANNON_FCA_RUNTIME') ? ownTimeTasks(parts.databasePath, parts.now) : null;
  const executive = createExecutive({
    value: parts.values ? (scopeKey, capability, context) => valueOf(parts.values!.activeCells(scopeKey), capability, context) : undefined,
    ...(parts.interests ? { interests: parts.interests } : {}),
    mood: scopeKey => moodOf(parts.state?.read(scopeKey, parts.now()) ?? null),
    tasks: tasks?.port ?? null,
    choices: parts.choices ? choicesOf(parts.choices) : null,
    ...(parts.log ? { log: parts.log } : {}),
  });
  return { executive, close: () => tasks?.close() };
}

/** V of a capability, the old choices folded (`cap1`): the most specific cell with data for the moment, as in her value facts. */
export function valueOf(cells: readonly ValueCell[], capability: string, context: string): { mean: number; sd: number; n: number } | null {
  const folded = foldedValueCells(cells, activityOfCapability).filter(cell => cell.choice === capability && cell.n > 0);
  const band = context.split('.')[0] ?? '';
  for (const [level, wanted] of [['presence', context], ['band', band], ['choice', '']] as const) {
    const cell = folded.find(item => item.level === level && item.context === wanted);
    if (cell) return { mean: cell.mean, sd: Math.sqrt(Math.max(0, cell.uncertainty)), n: cell.n };
  }
  return null;
}

function moodOf(state: CompanionStateSnapshot | null): MoodLabel | null {
  const emotion = (state as { emotion?: { valence?: number; arousal?: number } } | null)?.emotion;
  if (!emotion || typeof emotion.valence !== 'number' || typeof emotion.arousal !== 'number') return null;
  return coarseMood({ valence: emotion.valence, arousal: emotion.arousal * 2 - 1 });
}

function choicesOf(ledger: ChoiceLedger): ExecutiveChoices {
  return {
    choose: (scopeKey, choice, at) => ledger.choose(scopeKey, {
      surface: 'autonomy', choice: choice.capability, context: choice.context, sourceKind: 'deliberation', sourceId: choice.deliberationId,
    }, at),
    report: (scopeKey, choiceId, success, at) => ledger.report(scopeKey, choiceId, { success, costYen: 0 }, at),
  };
}

/** The worker's side of own-time tasks: it admits them on the shared file; the API process runs them. */
function ownTimeTasks(databasePath: string, now: () => string): { port: ExecutiveTasks; close(): void } {
  const db = openDatabase(databasePath, 'taskRuntime');
  migrateAgentTasks(db);
  const authority = new SQLiteFcaTaskAuthority(db);
  const runtime = new SQLiteTaskRuntimeStore(db, { authority, now, leaseValid: () => false });
  const own = new TaskOwnTimeStore(db, { authority, now, ensureRoot: scope => runtime.ensureRoot(scope), get: (scope, id) => runtime.get(scope, id) });
  return {
    port: {
      create: (scopeKey, spec) => own.create(scopeKey, { title: spec.title, goal: spec.goal, kind: 'research', capability: spec.capability }, spec.requestId)
        .id,
      status(scopeKey, taskId) {
        const task = runtime.get(scopeKey, taskId);
        if (!task) return null;
        if (task.phase === 'unknown') return 'unknown';
        if (task.status === 'completed') return 'done';
        if (task.status === 'failed') return 'failed';
        return task.status === 'cancelled' || task.phase === 'stopped' ? 'cancelled' : 'running';
      },
    },
    close: () => db.close(),
  };
}
