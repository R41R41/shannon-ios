import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftLifecycleCommand, MinecraftLifecyclePoll, MinecraftLifecycleReceipt } from '../../../contracts/minecraftLifecycleContract.js';

/** Durable operation identity. Delivered/unknown work is retained and never issued again after restart. */
export class MinecraftLifecycleStore {
  /** `exited`: whether the action that held a command left `unknown` at its one exit (the wiring reads it from the actions). */
  constructor(private readonly db: DatabaseSync, private readonly exited: (executionId: string) => boolean = () => false) {
    db.exec(`CREATE TABLE IF NOT EXISTS minecraft_lifecycle_operations (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, execution_id TEXT NOT NULL, command_json TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, receipt_json TEXT);
      CREATE INDEX IF NOT EXISTS minecraft_lifecycle_open ON minecraft_lifecycle_operations(server_id,receipt_json);
      CREATE TABLE IF NOT EXISTS minecraft_lifecycle_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),poll_json TEXT NOT NULL,received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS minecraft_lifecycle_receipt_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,receipt_json TEXT NOT NULL,UNIQUE(operation_id,receipt_json));`);
  }
  frame(): { poll: MinecraftLifecyclePoll; receivedAt: number } | null {
    const row = this.db.prepare('SELECT poll_json,received_at FROM minecraft_lifecycle_snapshot WHERE id=1').get();
    return row ? { poll: JSON.parse(String(row.poll_json)), receivedAt: Number(row.received_at) } : null;
  }
  updateFrame(poll: MinecraftLifecyclePoll, receivedAt: number): void {
    // Receipts are canonical in operations, not duplicated into every snapshot.
    this.db.prepare('INSERT INTO minecraft_lifecycle_snapshot(id,poll_json,received_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET poll_json=excluded.poll_json,received_at=excluded.received_at')
      .run(JSON.stringify({ ...poll, receipts: [] }), receivedAt);
  }
  command(id: string): MinecraftLifecycleCommand | null {
    const row = this.db.prepare('SELECT command_json FROM minecraft_lifecycle_operations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.command_json)) : null;
  }
  receipt(id: string): MinecraftLifecycleReceipt | null {
    const row = this.db.prepare('SELECT receipt_json FROM minecraft_lifecycle_operations WHERE id=?').get(id);
    return row?.receipt_json ? JSON.parse(String(row.receipt_json)) : null;
  }
  insert(command: MinecraftLifecycleCommand): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.command(command.id)) throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
      if (this.unresolved()) throw new Error('MINECRAFT_LIFECYCLE_BUSY');
      this.db.prepare('INSERT INTO minecraft_lifecycle_operations(id,server_id,execution_id,command_json) VALUES(?,?,?,?)')
        .run(command.id, command.serverId, command.authority.executionId, JSON.stringify(command));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /**
   * The one unknown exit (ADR-0009 D2), read from the action that held the command: once that action left `unknown` at its exit
   * (by the action store's sweep), an operation without an accepted receipt no longer blocks the operator's serialization slot or
   * a new operation. Its receipt can still arrive and settle it; nothing is resent.
   */
  private open(row: { execution_id?: unknown }): boolean {
    return !this.exited(String(row.execution_id));
  }
  pending(): Array<{ command: MinecraftLifecycleCommand; delivered: boolean; cancelled: boolean }> {
    return this.db.prepare('SELECT execution_id,command_json,delivered,cancelled FROM minecraft_lifecycle_operations WHERE receipt_json IS NULL').all()
      .filter(row => this.open(row))
      .map(r => ({ command: JSON.parse(String(r.command_json)), delivered: r.delivered === 1, cancelled: r.cancelled === 1 }));
  }
  deliver(id: string): boolean { return this.db.prepare('UPDATE minecraft_lifecycle_operations SET delivered=1 WHERE id=? AND delivered=0 AND cancelled=0 AND receipt_json IS NULL').run(id).changes === 1; }
  cancel(id: string): void { this.db.prepare('UPDATE minecraft_lifecycle_operations SET cancelled=1 WHERE id=?').run(id); }
  delivered(id: string): boolean { return this.db.prepare('SELECT delivered FROM minecraft_lifecycle_operations WHERE id=?').get(id)?.delivered === 1; }
  settle(receipt: MinecraftLifecycleReceipt): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.receipt(receipt.id), json = JSON.stringify(receipt);
      if (previous && JSON.stringify(previous) === json) { this.db.exec('COMMIT'); return true; }
      // A previously accepted event is safe to acknowledge again, without restoring its old canonical state.
      if (previous && this.db.prepare('SELECT 1 FROM minecraft_lifecycle_receipt_events WHERE operation_id=? AND receipt_json=?').get(receipt.id, json)) { this.db.exec('COMMIT'); return true; }
      const command = this.command(receipt.id);
      const recovery = previous?.outcome === 'unknown' && receipt.outcome !== 'unknown' && receipt.inputsReleased
        && this.delivered(receipt.id) && Date.parse(receipt.observedAt) > Date.parse(previous.observedAt);
      if (!command || previous && !recovery || receipt.connectionId !== command.connectionId || receipt.serverId !== command.serverId || receipt.action !== command.action) {
        this.db.exec('COMMIT'); return false;
      }
      const event = this.db.prepare('INSERT OR IGNORE INTO minecraft_lifecycle_receipt_events(operation_id,receipt_json) VALUES(?,?)');
      if (previous) event.run(receipt.id, JSON.stringify(previous));
      event.run(receipt.id, json);
      const changed = this.db.prepare('UPDATE minecraft_lifecycle_operations SET receipt_json=? WHERE id=?').run(json, receipt.id).changes === 1;
      this.db.exec('COMMIT'); return changed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  safe(executionId: string): boolean {
    return !this.db.prepare("SELECT 1 FROM minecraft_lifecycle_operations WHERE execution_id=? AND (receipt_json IS NULL OR json_extract(receipt_json,'$.outcome')='unknown' OR json_extract(receipt_json,'$.inputsReleased')!=1) LIMIT 1").get(executionId);
  }
  unresolved(): boolean {
    return this.db.prepare(`SELECT execution_id FROM minecraft_lifecycle_operations WHERE receipt_json IS NULL
      OR json_extract(receipt_json,'$.outcome')='unknown' OR json_extract(receipt_json,'$.inputsReleased')!=1`).all().some(row => this.open(row));
  }
}
