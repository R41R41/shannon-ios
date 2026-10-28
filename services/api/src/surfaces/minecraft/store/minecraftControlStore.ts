import type { DatabaseSync } from 'node:sqlite';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../../../contracts/minecraftControlContract.js';
import type { ActionLease } from '../../../contracts/actionThreadContract.js';
import { unitFromOutcome, type HoldState, type ItemOutcome, type OperationState } from '../../../contracts/continueContract.js';
import type { UsesSnapshot } from '../minecraftLlmcPromises.js';
import { readingOf, stateFromLegacy, stepAxes, type OperationEvent } from './minecraftOperationState.js';

/** The body's read-only probe skill (`PROBE_SKILL` in `minecraftProbeContract.ts`; not imported, which would widen the worker entries' closures). */
const PROBE_SKILL = 'probe';

/** The marker of a receipt the API wrote when it closed an operation the body never answered (`minecraftOperationReconcile.ts`). */
export const RECONCILED_BY_RELEASE = 'release_proof';

/** Whether a stored receipt is that closing, not the body's own answer. */
export function reconciledReceipt(receipt: unknown): boolean {
  return !!receipt && typeof receipt === 'object' && (receipt as { reconciled?: unknown }).reconciled === RECONCILED_BY_RELEASE;
}

/** What a store's row says of one operation (continue contract 1): the two axes and what the head keeps with the command. */
export interface OperationRow {
  id: string; taskId: string; state: OperationState; hold: HoldState;
  /** The model was told that the result was unknown (a later real receipt is then a correction). */
  told: boolean;
  /** The correction was said to the model (or there was none to say). */
  correctionSaid: boolean;
  headBoot: string | null;
  /** The definitions of the promises the act was sent with (`UsesSnapshot`), kept with the command. */
  uses: UsesSnapshot[];
  /** The next `deliverySeq` to fetch of this command's events (chapter 3): 0 until a page was taken. */
  fetchSeq: number;
  releasedBy: 'receipt' | 'cleanup' | 'reconnect' | 'proof' | null;
  /** The ledger has taken this command's events from the store (the receipt box), after a step started. */
  ledgerDone: boolean;
  resumeOf: string | null;
  receipt: MinecraftControlReceipt | null;
}
/** What the head tells the store when it sends a command. */
export interface InsertMeta { headBoot?: string; uses?: readonly UsesSnapshot[]; resumeOf?: string }
/** The change a receipt made: from which result state to which (`from` null: the command is not known). */
export interface SettleChange { acked: boolean; from: OperationState | null; to: OperationState | null }
const NOT_MOTOR_SKILLS = ['probe', 'view', 'events'];
const ROW_COLUMNS = 'id,task_id,state,hold,told,correction_said,head_boot,uses_json,fetch_seq,released_by,ledger_done,resume_of,receipt_json';

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
    this.addColumns();
  }
  /**
   * Continue contract 1 and 3: the columns of the two axes and of what the head keeps with a command. A database made before them is read as it was (the `ALTER` adds
   * a column once; `PRAGMA table_info` says which exist) and its rows get their result state from the phase and the receipt they had.
   */
  private addColumns(): void {
    const have = new Set(this.db.prepare('PRAGMA table_info(fca_body_operations)').all().map(column => String(column.name)));
    const add = (name: string, definition: string) => { if (!have.has(name)) this.db.exec(`ALTER TABLE fca_body_operations ADD COLUMN ${name} ${definition}`); };
    add('state', 'TEXT');
    add('hold', "TEXT NOT NULL DEFAULT 'none'");
    add('told', 'INTEGER NOT NULL DEFAULT 0');
    add('correction_said', 'INTEGER NOT NULL DEFAULT 0');
    add('head_boot', 'TEXT');
    add('uses_json', 'TEXT');
    add('fetch_seq', 'INTEGER NOT NULL DEFAULT 0');
    add('released_by', 'TEXT');
    add('ledger_done', 'INTEGER NOT NULL DEFAULT 0');
    add('resume_of', 'TEXT');
    for (const row of this.db.prepare('SELECT id,receipt_json FROM fca_body_operations WHERE state IS NULL').all()) {
      const receipt = row.receipt_json ? JSON.parse(String(row.receipt_json)) as { outcome?: string; inputsReleased?: boolean } : null;
      const state = stateFromLegacy({ hasReceipt: receipt !== null, reconciled: reconciledReceipt(receipt), outcome: receipt?.outcome ?? null, inputsReleased: receipt?.inputsReleased ?? null });
      this.db.prepare('UPDATE fca_body_operations SET state=? WHERE id=?').run(state, String(row.id));
    }
  }
  insert(command: MinecraftControlCommand, at: string, admit?: () => boolean, meta: InsertMeta = {}): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    if (admit && !admit()) throw new Error('FCA_BODY_LEASE_INVALID');
    const json = JSON.stringify(command);
    const old = this.db.prepare('SELECT command_json FROM fca_body_operations WHERE id=?').get(command.id);
    if (old) { if (old.command_json !== json) throw new Error('FCA_BODY_OPERATION_CONFLICT'); this.db.exec('COMMIT'); return; }
    this.db.prepare('INSERT INTO fca_body_operations(id,task_id,body_id,connection_id,command_json,phase,created_at,state,head_boot,uses_json,resume_of) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(command.id, command.context.taskId, command.context.bodyId, command.connectionId, json, 'queued', at, 'sent', meta.headBoot ?? null,
        meta.uses?.length ? JSON.stringify(meta.uses) : null, meta.resumeOf ?? null);
    this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending(bodyId: string): Array<{ command: MinecraftControlCommand; delivered: boolean; confirmed: boolean; cancelled: boolean }> {
    return this.db.prepare("SELECT command_json,phase,cancelled FROM fca_body_operations WHERE body_id=? AND phase!='settled' ORDER BY created_at,rowid").all(bodyId)
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
  settle(receipt: MinecraftControlReceipt): boolean { return this.settleWith(receipt).acked; }
  /**
   * The body's receipt for a command, and what it did to the command's result state. A receipt that differs from the one stored is not taken (the body keeps
   * sending it), with two exceptions that make a correction: the API's own closing of an operation the body never answered (`reconciledReceipt`), and an
   * unknown receipt, are replaced by a real one (known, inputs released). The result state is `settled_known` for a first real receipt, and `corrected` for one
   * after an unknown the model was told (`told`); a real receipt of a command the head did not tell about is the ordinary result.
   */
  settleWith(receipt: MinecraftControlReceipt): SettleChange {
    const command = this.command(receipt.id);
    if (!command || command.connectionId !== receipt.connectionId) return { acked: false, from: null, to: null };
    const { image: _pixels, ...retained } = receipt;
    const row = this.row(receipt.id)!;
    const reading = readingOf(retained), next = stepAxes({ state: row.state, hold: row.hold, told: row.told }, { kind: 'receipt', reading });
    const previous = row.receipt;
    if (previous) {
      if (JSON.stringify(previous) === JSON.stringify(retained)) return { acked: true, from: row.state, to: row.state };
      const replaceable = reconciledReceipt(previous) || readingOf(previous) === 'unknown';
      if (!replaceable) return { acked: false, from: row.state, to: row.state };
      if (reading !== 'known') return { acked: reconciledReceipt(previous), from: row.state, to: row.state };
      this.db.prepare('UPDATE fca_body_operations SET receipt_json=?,state=?,correction_said=0 WHERE id=? AND receipt_json=?')
        .run(JSON.stringify(retained), next.state, receipt.id, JSON.stringify(previous));
      return { acked: true, from: row.state, to: next.state };
    }
    this.db.prepare("UPDATE fca_body_operations SET phase='settled',receipt_json=?,state=? WHERE id=? AND receipt_json IS NULL").run(JSON.stringify(retained), next.state, receipt.id);
    return { acked: true, from: row.state, to: next.state };
  }
  /** The row of one command, or null. */
  row(id: string): OperationRow | null {
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM fca_body_operations WHERE id=?`).get(id);
    return row ? rowOf(row) : null;
  }
  state(id: string): OperationState | null { return this.row(id)?.state ?? null; }
  holdOf(id: string): HoldState | null { return this.row(id)?.hold ?? null; }
  /** The unit of a stored receipt: its own `unit`, else the old words read as a unit. */
  unitOf(id: string): ItemOutcome | null {
    const receipt = this.receipt(id);
    return receipt ? receipt.unit ?? unitFromOutcome(receipt.outcome, receipt.inputsReleased) : null;
  }
  /** Whether the command's result is still not known (unknown, or released without ever being known): a held act of that kind is never sent again (boundary 8). */
  resultUnknown(id: string): boolean {
    const row = this.row(id);
    return !!row && (row.state === 'settled_unknown' || (row.state === 'released' && this.unitOf(id)?.end === 'unknown'));
  }
  /** A command's result is unknown: its receipt did not come in time (the wait ran out). The state moves; a receipt that comes later is read against it. */
  markUnknown(id: string): void { this.db.prepare("UPDATE fca_body_operations SET state='settled_unknown' WHERE id=? AND state='sent'").run(id); }
  /** The model has been told that this command's result is unknown. */
  markTold(id: string): void { this.db.prepare('UPDATE fca_body_operations SET told=1 WHERE id=?').run(id); }
  /** The correction of this command was said to the model. */
  markCorrectionSaid(id: string): void { this.db.prepare('UPDATE fca_body_operations SET correction_said=1 WHERE id=?').run(id); }
  /** The corrections of the task that were not said yet (the model was told the unknown; the queue that would have said it is gone). */
  unsaidCorrections(taskId: string): OperationRow[] {
    return this.db.prepare(`SELECT ${ROW_COLUMNS} FROM fca_body_operations WHERE task_id=? AND state='corrected' AND told=1 AND correction_said=0 ORDER BY rowid`).all(taskId).map(rowOf);
  }
  /**
   * The body's release was proved for this command (the cleanup stop's receipt, the new connection's first poll, the lease's re-check): the command ends
   * `released` and its result stays unknown. A closing receipt is written when the command has no known one, as `reconcileOperations` does, so the lifecycle
   * reads it as settled; a real receipt that comes later replaces it (a correction when the model was told).
   */
  release(id: string, by: 'cleanup' | 'reconnect' | 'proof', at: string, evidenceId: string): boolean {
    const row = this.row(id), command = this.command(id);
    if (!row || !command || row.state === 'settled_known' || row.state === 'corrected' || row.state === 'released') return false;
    const closing = { id, connectionId: command.connectionId, outcome: 'cancelled', inputsReleased: true, observedAt: at, reconciled: RECONCILED_BY_RELEASE, evidenceId,
      was: row.receipt?.outcome ?? row.state, unit: { goal: 'unknown', end: 'unknown', released: true } satisfies ItemOutcome };
    const next = stepAxes({ state: row.state, hold: row.hold, told: row.told }, { kind: 'release_proved' });
    this.db.prepare("UPDATE fca_body_operations SET phase='settled',receipt_json=?,state=?,released_by=? WHERE id=?").run(JSON.stringify(closing), next.state, by, id);
    return true;
  }
  /** The hold axis' events (a cleanup that did not prove the release, the operator's resume or cancel). Returns the hold state after. */
  holdEvent(id: string, event: Extract<OperationEvent, { kind: 'cleanup_failed' | 'operator_resume' | 'operator_cancel' }>): HoldState | null {
    const row = this.row(id);
    if (!row) return null;
    const next = stepAxes({ state: row.state, hold: row.hold, told: row.told }, event);
    if (next.hold !== row.hold) this.db.prepare('UPDATE fca_body_operations SET hold=? WHERE id=?').run(next.hold, id);
    return next.hold;
  }
  /** The next `deliverySeq` of the command's events to fetch (chapter 3), kept with the command so a restarted head goes on from there. */
  setFetchSeq(id: string, next: number): void { this.db.prepare('UPDATE fca_body_operations SET fetch_seq=? WHERE id=? AND fetch_seq<?').run(next, id, next); }
  /**
   * The commands of the task whose real receipt is in the store and whose events the ledger has not taken from there yet, oldest first (the receipt box,
   * chapter 3): a head that stopped before its plan was committed puts them to the ledger again after it starts (`LedgerSeen` keeps an event from being put twice).
   */
  unprocessed(taskId: string): OperationRow[] {
    return this.db.prepare(`SELECT ${ROW_COLUMNS} FROM fca_body_operations WHERE task_id=? AND ledger_done=0 AND state IN ('settled_known','corrected') AND receipt_json IS NOT NULL
      AND json_extract(command_json,'$.skill')='act' ORDER BY rowid`).all(taskId).map(rowOf);
  }
  markProcessed(ids: readonly string[]): void { for (const id of ids) this.db.prepare('UPDATE fca_body_operations SET ledger_done=1 WHERE id=?').run(id); }
  /**
   * The first command that makes a new command which moves the body wait (continue contract 1: no new motor command until the release is proved; commands that
   * only observe go): a command whose result is unknown and whose release is not proved, a command of an earlier start of the head still `sent`, a hold the
   * operator has not ended. `headBoot` is this start's.
   */
  motorBlock(taskId: string, headBoot: string): OperationRow | null {
    const marks = NOT_MOTOR_SKILLS.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM fca_body_operations WHERE task_id=? AND json_extract(command_json,'$.kind') IN ('skill','reflex')
      AND COALESCE(json_extract(command_json,'$.skill'),'') NOT IN (${marks})
      AND (state='settled_unknown' OR hold='held' OR (state='sent' AND COALESCE(head_boot,'')!=?)) ORDER BY rowid LIMIT 1`).get(taskId, ...NOT_MOTOR_SKILLS, headBoot);
    return row ? rowOf(row) : null;
  }
  /** The commands the head must clean up when it starts (or a step starts): `settled_unknown`, and `sent` ones of an earlier start of the head. */
  uncleaned(taskId: string, headBoot: string): OperationRow[] {
    const marks = NOT_MOTOR_SKILLS.map(() => '?').join(',');
    return this.db.prepare(`SELECT ${ROW_COLUMNS} FROM fca_body_operations WHERE task_id=? AND json_extract(command_json,'$.kind') IN ('skill','reflex')
      AND COALESCE(json_extract(command_json,'$.skill'),'') NOT IN (${marks})
      AND (state='settled_unknown' OR (state='sent' AND COALESCE(head_boot,'')!=?)) ORDER BY rowid`).all(taskId, ...NOT_MOTOR_SKILLS, headBoot).map(rowOf);
  }
  /** Ids of the commands of the body's earlier connections still `sent` or `settled_unknown` (a new connection's first poll proves them released when the body runs nothing). */
  openBeforeConnection(bodyId: string, connectionId: string): string[] {
    return this.db.prepare("SELECT id FROM fca_body_operations WHERE body_id=? AND connection_id!=? AND ((state='sent' AND phase IN ('delivered','running')) OR state='settled_unknown') AND json_extract(command_json,'$.kind') IN ('skill','reflex')")
      .all(bodyId, connectionId).map(row => String(row.id));
  }
  /** The last command sent under this lease (its task, body and session), or null when it sent none. */
  lastOfLease(lease: ActionLease): MinecraftControlCommand | null {
    const row = this.db.prepare(`SELECT command_json FROM fca_body_operations WHERE json_extract(command_json,'$.lease.id')=?
      AND json_extract(command_json,'$.lease.holder')=? AND json_extract(command_json,'$.lease.generation')=? ORDER BY rowid DESC LIMIT 1`)
      .get(lease.id, lease.holder, lease.generation);
    return row ? JSON.parse(String(row.command_json)) as MinecraftControlCommand : null;
  }
  /** Run 44: the task's latest body command (a skill: never a release or a re-check), or null: the lease a release naming its hold goes with. */
  lastOfTask(taskId: string): MinecraftControlCommand | null {
    const row = this.db.prepare(`SELECT command_json FROM fca_body_operations WHERE task_id=? AND json_extract(command_json,'$.kind')='skill'
      AND id NOT LIKE 'recheck:%' ORDER BY rowid DESC LIMIT 1`).get(taskId);
    return row ? JSON.parse(String(row.command_json)) as MinecraftControlCommand : null;
  }
  /**
   * The latest step command of the lease's holder and generation for the same task, under any of its leases: for a step that sent
   * nothing to the body itself (a judgment that stayed unknown). A holder is one runner process for every task it runs, and a
   * re-check's own command is not a step's, so both are left out.
   */
  lastOfHolder(lease: ActionLease, taskId: string, scopeKey: string): MinecraftControlCommand | null {
    const row = this.db.prepare(`SELECT command_json FROM fca_body_operations WHERE json_extract(command_json,'$.lease.holder')=?
      AND json_extract(command_json,'$.lease.generation')=? AND json_extract(command_json,'$.context.taskId')=?
      AND json_extract(command_json,'$.context.scopeKey')=? AND id NOT LIKE 'recheck:%' ORDER BY rowid DESC LIMIT 1`)
      .get(lease.holder, lease.generation, taskId, scopeKey);
    return row ? JSON.parse(String(row.command_json)) as MinecraftControlCommand : null;
  }
  /**
   * Whether the task has no body operation whose effect is still open. A read-only probe (`mc.probe`, `probe:` ids) touches nothing, so
   * it is never open: Minecraft run 34 (2026-10-22): a step's own probes were still in flight when the investigation's budget ran out,
   * the next guard saw them unsettled, the step was declared FCA_BODY_OUTCOME_UNKNOWN and its cancel settled them a moment later as
   * `cancelled` with every input released; seven such steps used up the body recovery limit and paused the task.
   * The task queue (a step that goes on while its items run): `open` are the ids the step itself still waits for, which are not unsafe while they
   * are unsettled; one settled with an unknown outcome or inputs not released still is.
   */
  safe(taskId: string, open?: ReadonlySet<string>): boolean {
    const ids = [...(open ?? [])];
    // The table of continue contract 1: `sent` and `settled_unknown` are unresolved; `settled_known`, `released` and `corrected` are resolved. The hold axis is the
    // operator's, not this test's.
    const unsettled = ids.length ? `(state='sent' AND id NOT IN (${ids.map(() => '?').join(',')}))` : "state='sent'";
    return this.db.prepare(`SELECT 1 FROM fca_body_operations WHERE task_id=? AND COALESCE(json_extract(command_json,'$.skill'),'')!=?
      AND (${unsettled} OR state='settled_unknown') LIMIT 1`)
      .get(taskId, PROBE_SKILL, ...ids) === undefined;
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

function rowOf(row: Record<string, unknown>): OperationRow {
  return { id: String(row.id), taskId: String(row.task_id), state: String(row.state ?? 'sent') as OperationState, hold: String(row.hold ?? 'none') as HoldState,
    told: row.told === 1, correctionSaid: row.correction_said === 1, headBoot: typeof row.head_boot === 'string' ? row.head_boot : null,
    uses: typeof row.uses_json === 'string' ? JSON.parse(row.uses_json) as UsesSnapshot[] : [], fetchSeq: Number(row.fetch_seq ?? 0),
    releasedBy: typeof row.released_by === 'string' ? row.released_by as OperationRow['releasedBy'] : null, ledgerDone: row.ledger_done === 1,
    resumeOf: typeof row.resume_of === 'string' ? row.resume_of : null,
    receipt: typeof row.receipt_json === 'string' ? JSON.parse(row.receipt_json) as MinecraftControlReceipt : null };
}
