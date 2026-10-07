import { stage5Enabled } from '../infra/config/stage5Config.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import type { AgentTaskStore } from '../mind/action/agentTasks/agentTasksPorts.js';
import { createFeedbackWiring } from './feedbackWiring.js';
import { feedbackSourceReader } from './feedbackSourceWiring.js';

/** Feedback and value versions use one database connection, so a fold cannot deadlock its own evidence writer. */
export function configuredStage5Feedback(environment: Readonly<Record<string, string | undefined>>, parts: {
  store: SQLiteShannonStore; tasks: Pick<AgentTaskStore, 'taskTrees'>; ownerScope: string; now(): string;
  ownerAlone(scope: string): boolean; createSchema?: boolean;
}) {
  if (!stage5Enabled(environment) || !parts.store.choiceLedger()) return null;
  const values = parts.store.valueVersions();
  const feedback = parts.store.composeLearning(database => createFeedbackWiring({
    enabled: true, database, createSchema: parts.createSchema ?? true,
    ownerScopeKey: parts.ownerScope, now: parts.now, ownerAlone: parts.ownerAlone,
    source: feedbackSourceReader({ conversationStore: parts.store, stateStore: parts.store }),
    toolEvidence: (scope, thread, turn) => parts.store.toolTraces(scope, thread, {turnIds:[turn]})
      .flatMap(trace => trace.calls.map(call => ({ tool:call.tool, ok:call.ok, withheld:call.failure === 'denied' }))),
    taskProofStatus: (scope, taskId) => parts.tasks.taskTrees?.proofStatus(scope, taskId) ?? {status:'invalid'},
    ...(values ? {values:values.reader} : {}),
  }));
  if (feedback && values) values.readFeedbackFrom(feedback.evidence);
  return feedback;
}
