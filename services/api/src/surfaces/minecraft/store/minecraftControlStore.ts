import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../../contracts/minecraftControlContract.js';

/** Operation receipts only, not a task or lease authority. A delivered command is never re-delivered. */
export class MinecraftControlStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS fca_body_operations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body_id TEXT NOT NULL, connection_id TEXT NOT NULL,
      command_json TEXT NOT NULL, phase TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS fca_body_operations_body ON fca_body_operations(body_id,phase);
      CREATE TABLE IF NOT EXISTS fca_body_bindings(task_id TEXT PRIMARY KEY, body_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fca_body_sessions(id TEXT PRIMARY KEY, context_json TEXT NOT NULL, receipt_json TEXT);`);
  }
  insert(command: MinecraftControlCommand, at: string): void {
    const json = JSON.stringify(command);
    const old = this.db.prepare('SELECT command_json FROM fca_body_operations WHERE id=?').get(command.id);
    if (old) { if (old.command_json !== json) throw new Error('FCA_BODY_OPERATION_CONFLICT'); return; }
    this.db.prepare('INSERT INTO fca_body_operations(id,task_id,body_id,connection_id,command_json,phase,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(command.id, command.context.taskId, command.context.bodyId, command.connectionId, json, 'queued', at);
  }
  pending(bodyId: string): Array<{ command: MinecraftControlCommand; delivered: boolean; cancelled: boolean }> {
    return this.db.prepare("SELECT command_json,phase,cancelled FROM fca_body_operations WHERE body_id=? AND phase!='settled' ORDER BY created_at,id").all(bodyId)
      .map(row => ({ command: JSON.parse(String(row.command_json)), delivered: row.phase === 'delivered', cancelled: row.cancelled === 1 }));
  }
  deliver(id: string): boolean { return this.db.prepare("UPDATE fca_body_operations SET phase='delivered' WHERE id=? AND phase='queued' AND cancelled=0").run(id).changes === 1; }
  cancel(id: string): void {
    // Proven never handed to the device: cancellation is known without a physical acknowledgement.
    const command = this.command(id); if (!command) return;
    const row = this.db.prepare('SELECT phase FROM fca_body_operations WHERE id=?').get(id);
    if (row?.phase === 'queued') this.settle({ id, connectionId: command.connectionId, outcome: 'cancelled', inputsReleased: true, observedAt: new Date().toISOString() });
    else this.db.prepare('UPDATE fca_body_operations SET cancelled=1 WHERE id=?').run(id);
  }
  command(id: string): MinecraftControlCommand | null {
    const row = this.db.prepare('SELECT command_json FROM fca_body_operations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.command_json)) : null;
  }
  receipt(id: string): MinecraftControlReceipt | null {
    const row = this.db.prepare('SELECT receipt_json FROM fca_body_operations WHERE id=?').get(id);
    return row?.receipt_json ? JSON.parse(String(row.receipt_json)) : null;
  }
  settle(receipt: MinecraftControlReceipt): boolean {
    const command = this.command(receipt.id);
    if (!command || command.connectionId !== receipt.connectionId) return false;
    const { image: _pixels, ...retained } = receipt;
    const previous = this.receipt(receipt.id);
    if (previous) return JSON.stringify(previous) === JSON.stringify(retained);
    this.db.prepare("UPDATE fca_body_operations SET phase='settled',receipt_json=? WHERE id=? AND receipt_json IS NULL").run(JSON.stringify(retained), receipt.id);
    return true;
  }
  safe(taskId: string): boolean {
    return this.db.prepare("SELECT 1 FROM fca_body_operations WHERE task_id=? AND (phase!='settled' OR json_extract(receipt_json,'$.outcome')='unknown' OR json_extract(receipt_json,'$.inputsReleased')!=1) LIMIT 1").get(taskId) === undefined;
  }
  bind(taskId: string, bodyId: string): boolean {
    const old = this.body(taskId); if (old) return old === bodyId;
    this.db.prepare('INSERT INTO fca_body_bindings(task_id,body_id) VALUES(?,?)').run(taskId, bodyId); return true;
  }
  body(taskId: string): string | null { const row = this.db.prepare('SELECT body_id FROM fca_body_bindings WHERE task_id=?').get(taskId); return row ? String(row.body_id) : null; }
  session(id: string): { context: unknown; receipt: unknown | null } | null {
    const row = this.db.prepare('SELECT * FROM fca_body_sessions WHERE id=?').get(id);
    return row ? { context: JSON.parse(String(row.context_json)), receipt: row.receipt_json ? JSON.parse(String(row.receipt_json)) : null } : null;
  }
  beginSession(id: string, context: unknown): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO fca_body_sessions(id,context_json) VALUES(?,?)').run(id, JSON.stringify(context)).changes === 1;
  }
  endSession(id: string, receipt: unknown): void { this.db.prepare('UPDATE fca_body_sessions SET receipt_json=? WHERE id=? AND receipt_json IS NULL').run(JSON.stringify(receipt), id); }
}
