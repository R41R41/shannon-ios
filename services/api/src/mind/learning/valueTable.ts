import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  REWARD_FORMULA,
  ROOT_VALUE,
  foldValues,
  nightlyDecision,
  rollbackTarget,
  valueCells,
  valueOf,
  versionsToPrune,
  type ValueCell,
  type ValueEvidence,
  type ValueRead,
  type ValueVersionMaker,
  type ValueVersionRecord,
} from '@shannon/learning';
import { ownerDay } from '../../companionPresence.js';
import { LockWaitMeter, tableExists, underWriteLock } from '../../infra/sqlite/lockWaits.js';
import { SQLiteChoiceLedger } from './store/sqliteChoiceLedger.js';
import { SQLiteValueTable, VALUE_VERSIONS_TABLE } from './store/sqliteValueTable.js';

/**
 * The value table and its versions (Syzygy ADR-0008 stage 1, 価値表; `docs/cognition-ledger-contract.md`). Core: emotion, guard.
 *
 * A version is a fold of her settled choices in the order they were settled (`@shannon/learning`, `valueTable.ts`). The
 * nightly pass writes one when something new was settled and the active version is not frozen; the owner can roll back to an
 * earlier version (its cells, frozen: what was settled after is not used until he resumes) and resume (a version from all the
 * evidence again). A choice reads V from the active version (`reader`). Nothing that acts reads V in this stage beyond the
 * choice ledger's record of it; the facts and the mood are step 7.
 */
export type ValuesOwnerError = 'VALUES_NO_ACTIVE_VERSION' | 'VALUES_VERSION_NOT_FOUND' | 'VALUES_NO_EARLIER_VERSION' | 'VALUES_NOT_FROZEN' | 'VALUES_NO_EVIDENCE' | 'VALUES_UNAVAILABLE';

export interface ValueVersionsOptions {
  database: DatabaseSync;
  createsSchema: boolean;
  log?: (line: string) => void;
}

export class ValueVersions {
  readonly store: SQLiteValueTable;
  private readonly choices: SQLiteChoiceLedger;
  private readonly meter: LockWaitMeter;
  private readonly cellCache = new Map<string, ValueCell[]>();
  private present = false;

  constructor(private readonly options: ValueVersionsOptions) {
    this.store = new SQLiteValueTable(options.database, { createSchema: options.createsSchema });
    this.choices = new SQLiteChoiceLedger(options.database, { createSchema: false });
    this.meter = new LockWaitMeter('value table', options.log);
  }

  /** V of a choice in a context from the active version; the root cell while there is none (or the tables are absent). */
  readonly reader = (scopeKey: string, choice: string, context: string): ValueRead => {
    if (!this.ready()) return ROOT_VALUE;
    const id = this.store.activeId(scopeKey);
    return id ? valueOf(this.cellsOf(id), choice, context, id) : ROOT_VALUE;
  };

  /** The nightly part: a new version from all settled choices, unless frozen, empty or unchanged; then retention. */
  nightly(scopeKey: string, at: string): { decision: string; versionId?: string; pruned: number } {
    if (!this.ready()) return { decision: 'unavailable', pruned: 0 };
    let result: { decision: string; versionId?: string; pruned: number } = { decision: 'empty', pruned: 0 };
    // The fold is made outside the lock; under it, only when nothing was settled or rolled back meanwhile is it written as it is.
    const seen = { lastSeq: this.choices.lastSeq(scopeKey), active: this.store.activeId(scopeKey) };
    const folded = valueCells(foldValues(this.evidence(scopeKey, seen.lastSeq)));
    underWriteLock(this.options.database, this.meter, ownerDay(at), () => {
      const lastSeq = this.choices.lastSeq(scopeKey);
      const active = this.store.active(scopeKey);
      const decision = nightlyDecision(active, lastSeq);
      result = { decision, pruned: 0 };
      if (decision === 'snapshot') {
        const same = lastSeq === seen.lastSeq && (active?.versionId ?? null) === seen.active;
        const version = this.write(scopeKey, at, 'sleep', active?.versionId ?? null, same ? folded : null, scopeKey, lastSeq);
        result = { decision, versionId: version.versionId, pruned: 0 };
      }
      const prune = versionsToPrune(this.store.versions(scopeKey), at);
      this.store.deleteVersions(prune);
      result.pruned = prune.length;
    }, 'shannon_value_table');
    return result;
  }

  /** The owner's rollback: a new active version with the cells of an earlier one, frozen until he resumes. */
  rollback(scopeKey: string, at: string, versionId?: string): ValueVersionRecord | ValuesOwnerError {
    if (!this.ready()) return 'VALUES_UNAVAILABLE';
    let result: ValueVersionRecord | ValuesOwnerError = 'VALUES_NO_ACTIVE_VERSION';
    underWriteLock(this.options.database, this.meter, ownerDay(at), () => {
      const target = rollbackTarget(this.store.versions(scopeKey), this.store.active(scopeKey), versionId);
      if (typeof target === 'string') { result = target; return; }
      result = this.insert(scopeKey, {
        versionId: randomUUID(), createdAt: at, madeBy: 'owner_rollback', formula: REWARD_FORMULA.id, weights: { ...REWARD_FORMULA.weights }, baseVersion: target.versionId,
        evidenceFrom: target.evidenceFrom, evidenceTo: target.evidenceTo, state: 'active', frozen: true,
      }, this.store.cells(target.versionId));
    }, 'shannon_value_table');
    return result;
  }

  /** The owner's resume: a new active version from all the evidence again, no longer frozen. */
  resume(scopeKey: string, at: string): ValueVersionRecord | ValuesOwnerError {
    if (!this.ready()) return 'VALUES_UNAVAILABLE';
    let result: ValueVersionRecord | ValuesOwnerError = 'VALUES_NOT_FROZEN';
    underWriteLock(this.options.database, this.meter, ownerDay(at), () => {
      const active = this.store.active(scopeKey);
      if (!active?.frozen) return;
      const lastSeq = this.choices.lastSeq(scopeKey);
      result = this.write(scopeKey, at, 'owner_resume', active.versionId, null, scopeKey, lastSeq);
    }, 'shannon_value_table');
    return result;
  }

  /** What the owner is shown: the versions, the active one's cells, and whether it is frozen. */
  overview(scopeKey: string): { active: ValueVersionRecord | null; frozen: boolean; versions: ValueVersionRecord[]; cells: ValueCell[] } {
    if (!this.ready()) return { active: null, frozen: false, versions: [], cells: [] };
    const active = this.store.active(scopeKey);
    return { active, frozen: active?.frozen ?? false, versions: this.store.versions(scopeKey).slice(-30), cells: active ? this.cellsOf(active.versionId) : [] };
  }

  lockWaits() { return this.meter.summary(); }

  flushLockWaits(): void { this.meter.flush(); }

  private evidence(scopeKey: string, upTo: number): ValueEvidence[] {
    return this.choices.settledInOrder(scopeKey, upTo).filter(choice => choice.reward !== null).map(choice => ({
      choice: choice.choice, context: choice.context, reward: choice.reward!, world: choice.world ?? 0, serve: choice.serve ?? 0, growth: choice.growth ?? 0,
      costYen: choice.costYen, settledAt: choice.settledAt ?? choice.chosenAt,
    }));
  }

  /** A new active version from all the evidence up to `lastSeq`: the cells given (folded outside the lock), or folded here. */
  private write(scopeKey: string, at: string, madeBy: ValueVersionMaker, base: string | null, cells: ValueCell[] | null, evidenceScope: string, lastSeq: number): ValueVersionRecord {
    return this.insert(scopeKey, {
      versionId: randomUUID(), createdAt: at, madeBy, formula: REWARD_FORMULA.id, weights: { ...REWARD_FORMULA.weights }, baseVersion: base,
      evidenceFrom: lastSeq > 0 ? 1 : 0, evidenceTo: lastSeq, state: 'active', frozen: false,
    }, cells ?? valueCells(foldValues(this.evidence(evidenceScope, lastSeq))));
  }

  private insert(scopeKey: string, version: ValueVersionRecord, cells: readonly ValueCell[]): ValueVersionRecord {
    this.store.insertActive(scopeKey, version, cells);
    return version;
  }

  private cellsOf(versionId: string): ValueCell[] {
    let cells = this.cellCache.get(versionId);
    if (!cells) {
      cells = this.store.cells(versionId);
      if (this.cellCache.size > 16) this.cellCache.clear();
      this.cellCache.set(versionId, cells);
    }
    return cells;
  }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, VALUE_VERSIONS_TABLE);
    return this.present;
  }
}
