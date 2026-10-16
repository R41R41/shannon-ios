import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../../contracts/minecraftControlContract.js';
import type { ActionLease } from '../../../contracts/actionThreadContract.js';

/**
 * Operation receipts only, not a task or lease authority. A command handed in a poll reply is `delivered`; the body's next poll
 * confirms it (`running`: it lists the command as active or sends its receipt). Minecraft run 6 (2026-10-14): a reply written
 * after the API's thread stalled went to a body that had already given up on that request, and the stop in it was marked
 * delivered and never sent again. A delivered command the next poll does not report never reached the body: it is handed again
 * under the same id (the body ignores an id it has seen), or, when it was cancelled meanwhile, settled as never handed over.
 */
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
  insert(command: MinecraftControlCommand, at: string, admit?: () => boolean): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    if (admit && !admit()) throw new Error('FCA_BODY_LEASE_INVALID');
    const json = JSON.stringify(command);
    const old = this.db.prepare('SELECT command_json FROM fca_body_operations WHERE id=?').get(command.id);
    if (old) { if (old.command_json !== json) throw new Error('FCA_BODY_OPERATION_CONFLICT'); this.db.exec('COMMIT'); return; }
    this.db.prepare('INSERT INTO fca_body_operations(id,task_id,body_id,connection_id,command_json,phase,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(command.id, command.context.taskId, command.context.bodyId, command.connectionId, json, 'queued', at);
    this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending(bodyId: string): Array<{ command: MinecraftControlCommand; delivered: boolean; confirmed: boolean; cancelled: boolean }> {
    return this.db.prepare("SELECT command_json,phase,cancelled FROM fca_body_operations WHERE body_id=? AND phase!='settled' ORDER BY created_at,id").all(bodyId)
      .map(row => ({ command: JSON.parse(String(row.command_json)), delivered: row.phase === 'delivered' || row.phase === 'running',
        confirmed: row.phase === 'running', cancelled: row.cancelled === 1 }));
  }
  deliver(id: string): boolean { return this.db.prepare("UPDATE fca_body_operations SET phase='delivered' WHERE id=? AND phase='queued' AND cancelled=0").run(id).changes === 1; }
  /** The body's poll after the delivery reported the command (active, or its receipt). */
  confirm(id: string): void { this.db.prepare("UPDATE fca_body_operations SET phase='running' WHERE id=? AND phase='delivered'").run(id); }
  /**
   * The body's poll after the delivery did not report the command: it never reached the body. Queued again to be handed under
   * the same id; one cancelled meanwhile is known cancelled without a physical acknowledgement, as before its first delivery.
   */
  undelivered(id: string): void {
    const row = this.db.prepare('SELECT phase,cancelled FROM fca_body_operations WHERE id=?').get(id);
    if (row?.phase !== 'delivered') return;
    this.db.prepare("UPDATE fca_body_operations SET phase='queued' WHERE id=? AND phase='delivered'").run(id);
    if (row.cancelled === 1) this.cancel(id);
  }
  /** The phase of a command (`queued`, `delivered`, `running`, `settled`), or null. */
  phase(id: string): string | null {
    const row = this.db.prepare('SELECT phase FROM fca_body_operations WHERE id=?').get(id);
    return row ? String(row.phase) : null;
  }
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
  /** The last command sent under this lease (its task, body and session), or null when it sent none. */
  lastOfLease(lease: ActionLease): MinecraftControlCommand | null {
    const row = this.db.prepare(`SELECT command_json FROM fca_body_operations WHERE json_extract(command_json,'$.lease.id')=?
      AND json_extract(command_json,'$.lease.holder')=? AND json_extract(command_json,'$.lease.generation')=? ORDER BY rowid DESC LIMIT 1`)
      .get(lease.id, lease.holder, lease.generation);
    return row ? JSON.parse(String(row.command_json)) as MinecraftControlCommand : null;
  }
  /** The latest command of whoever held the lease, under any of its leases: for a step that sent nothing to the body itself (a judgment that stayed unknown). */
  lastOfHolder(lease: ActionLease): MinecraftControlCommand | null {
    const row = this.db.prepare(`SELECT command_json FROM fca_body_operations WHERE json_extract(command_json,'$.lease.holder')=?
      ORDER BY rowid DESC LIMIT 1`).get(lease.holder);
    return row ? JSON.parse(String(row.command_json)) as MinecraftControlCommand : null;
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

/** One body operation of a lease as the release proof reads it (`configuredActionResourceProof.ts`), in the order it was sent. */
export interface LeaseOperation { position: number; id: string; kind: string; phase: string; receipt: string | null }
/** Every body operation sent under this lease in this scope, oldest first; none when the table was never made. Read only. */
export function leaseOperations(db: DatabaseSync, lease: ActionLease, scopeKey: string): LeaseOperation[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_body_operations'").get()) return [];
  return db.prepare(`SELECT rowid AS position,id,json_extract(command_json,'$.kind') AS kind,phase,receipt_json FROM fca_body_operations
    WHERE json_extract(command_json,'$.lease.id')=? AND json_extract(command_json,'$.lease.holder')=? AND json_extract(command_json,'$.lease.generation')=?
    AND json_extract(command_json,'$.context.scopeKey')=? ORDER BY rowid`).all(lease.id, lease.holder, lease.generation, scopeKey)
    .map(row => ({ position: Number(row.position), id: String(row.id), kind: String(row.kind), phase: String(row.phase),
      receipt: row.receipt_json === null || row.receipt_json === undefined ? null : String(row.receipt_json) }));
}
