import { SQLiteAutonomyStore as AutonomyStore } from '../mind/action/ownTime/store/autonomyStore.js';
import { AutonomyActivityRecord } from '../mind/inhibition/store/autonomyActivity.js';
import { OwnerInformedMarks } from '../mind/inhibition/store/ownerInformedMarks.js';

/** The inhibition stores and own-time stores share one connection and one transaction. */
export class SQLiteAutonomyStore extends AutonomyStore {
  constructor(path: string) {
    super(path, {
      activity: connection => new AutonomyActivityRecord(connection),
      informed: connection => new OwnerInformedMarks(connection),
    });
  }
}
export function createAutonomyStore(path: string): AutonomyStore {
  return new SQLiteAutonomyStore(path);
}
