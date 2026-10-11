import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { stage5Enabled } from '../infra/config/stage5Config.js';
import type { SQLiteShannonStore } from '../infra/sqlite/sqliteStore.js';
import { TaskTreeStore } from '../mind/action/agentTasks/store/taskTreeStore.js';
import { configuredStage5Feedback } from './stage5FeedbackWiring.js';

/** The sleep worker receives maintenance evidence, never task dispatch/claim rights or a private-audience assertion. */
export function configuredWorkerFeedback(environment: Readonly<Record<string, string | undefined>>, options: {
  path: string; store: SQLiteShannonStore; ownerScope: string; now(): string;
}): {close():void} | null {
  if (!stage5Enabled(environment) || !options.store.choiceLedger()) return null;
  const database = openDatabase(options.path, 'readOnly');
  const proofs = new TaskTreeStore(database, undefined, false);
  try {
    configuredStage5Feedback(environment, {...options, tasks:{taskTrees:proofs}, ownerAlone:() => false, createSchema:false});
    return {close:() => {if (database.isOpen) database.close();}};
  } catch (error) {database.close();throw error;}
}
