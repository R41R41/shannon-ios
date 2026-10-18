import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease } from '../../../contracts/actionThreadContract.js';
import { reconciledReceipt, RECONCILED_BY_RELEASE } from './minecraftControlStore.js';

/**
 * The body operations of one unknown step, read and reconciled once the body itself has proven its inputs released (Minebot parity
 * audit C-20/C-21, 2026-10-19). An operation whose receipt never came (the body restarted, the API restarted, the wait ran out) is
 * never sent again: its row is closed here, as a cancellation the body's own release confirmed, so that the task can look at the
 * world again and decide. A real receipt that arrives late replaces the closed one (`MinecraftControlStore.settle`).
 */

/** One body operation of a lease as the recovery reads it: what it was (closed names only) and how it stands. */
export interface BodyOperationState {
  id: string; kind: string; skill: string | null; phase: string;
  /** The receipt's outcome, or null when none came. */
  outcome: string | null; released: boolean;
  /** The receipt is the API's closing of an operation the body never answered (`reconcileOperations`), not the body's own. */
  closedByApi: boolean;
}

/** Whether the operation's result is still unknown: no settled receipt, an `unknown` one, or inputs not confirmed released. */
export function operationUnresolved(operation: BodyOperationState): boolean {
  return operation.phase !== 'settled' || operation.outcome === null || operation.outcome === 'unknown' || !operation.released;
}

const OPERATIONS = `SELECT id,json_extract(command_json,'$.kind') AS kind,json_extract(command_json,'$.skill') AS skill,
  json_extract(command_json,'$.connectionId') AS connection,phase,receipt_json FROM fca_body_operations
  WHERE json_extract(command_json,'$.lease.id')=? AND json_extract(command_json,'$.lease.holder')=?
  AND json_extract(command_json,'$.lease.generation')=? AND json_extract(command_json,'$.context.scopeKey')=? ORDER BY rowid`;

function tablePresent(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_body_operations'").get();
}

function stateOf(row: Record<string, unknown>): BodyOperationState & { connection: string } {
  const receipt = row.receipt_json ? JSON.parse(String(row.receipt_json)) as { outcome?: unknown; inputsReleased?: unknown } : null;
  return { id: String(row.id), kind: String(row.kind), skill: typeof row.skill === 'string' ? row.skill : null, phase: String(row.phase),
    outcome: typeof receipt?.outcome === 'string' ? receipt.outcome : null, released: receipt?.inputsReleased === true,
    closedByApi: reconciledReceipt(receipt), connection: String(row.connection ?? '') };
}

/** Every body operation sent under this lease in this scope, oldest first. Read only; none when the table was never made. */
export function bodyOperations(db: DatabaseSync, lease: ActionLease, scopeKey: string): BodyOperationState[] {
  if (!tablePresent(db)) return [];
  return db.prepare(OPERATIONS).all(lease.id, lease.holder, lease.generation, scopeKey).map(row => {
    const { connection: _connection, ...operation } = stateOf(row);
    return operation;
  });
}

/**
 * Closes the lease's unresolved operations as cancelled with their inputs released, marked as reconciled by the body's release
 * proof (`evidenceId`: the re-check's command that the body answered `stopped`). The caller holds the transaction and has checked
 * that proof. Returns the operations it closed; resent: never.
 */
export function reconcileOperations(db: DatabaseSync, lease: ActionLease, scopeKey: string, evidenceId: string, at: string): BodyOperationState[] {
  if (!tablePresent(db)) return [];
  const closed: BodyOperationState[] = [];
  for (const row of db.prepare(OPERATIONS).all(lease.id, lease.holder, lease.generation, scopeKey)) {
    const { connection, ...operation } = stateOf(row);
    if (!operationUnresolved(operation)) continue;
    const receipt = { id: operation.id, connectionId: connection, outcome: 'cancelled', inputsReleased: true, observedAt: at,
      reconciled: RECONCILED_BY_RELEASE, evidenceId, was: operation.outcome ?? operation.phase };
    db.prepare("UPDATE fca_body_operations SET phase='settled',receipt_json=? WHERE id=?").run(JSON.stringify(receipt), operation.id);
    closed.push(operation);
  }
  return closed;
}
