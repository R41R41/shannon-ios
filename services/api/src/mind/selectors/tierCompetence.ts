import { randomUUID } from 'node:crypto';
import { tierOutcome, type Competence } from '@shannon/learning';
import { LockWaitMeter, loggedFailure, ownerDayKey, tableExists, underWriteLock, type SqliteConnection } from '../../infra/sqlite/lockWaits.js';
import { SQLiteTierOutcomes, TIER_OUTCOMES_TABLE } from './store/sqliteTierOutcomes.js';

/**
 * The competence table of her tiers (Syzygy ADR-0008 stage 2, step 4, `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * A turn the difficulty policy routed is recorded with its tier, kind and G at its end; the owner's next turn in the same Talk
 * (Jev's retry-or-correction probability) settles it, or 30 minutes without one settle it from G alone. Competence is the
 * Beta-Bernoulli fold of the settled outcomes per (tier, kind), read by the policy for routing. It never touches reward, mood
 * or the value table. Writes are deferred, under the write lock, measured; a failure is logged and swallowed.
 */
export const TIER_OUTCOME_RETENTION_DAYS = 90;
export const TIER_NEXT_TURN_MINUTES = 30;
const DAY = 24 * 60 * 60_000;

export class TierCompetence {
  readonly store: SQLiteTierOutcomes;
  private readonly meter: LockWaitMeter;
  private readonly defer: (task: () => void) => void;
  private present = false;

  constructor(private readonly options: { database: SqliteConnection; createsSchema: boolean; defer?: (task: () => void) => void; log?: (line: string) => void }) {
    this.store = new SQLiteTierOutcomes(options.database, { createSchema: options.createsSchema });
    this.meter = new LockWaitMeter('tier outcomes', options.log);
    this.defer = options.defer ?? (task => { setImmediate(task); });
  }

  /** What has been learned of a (tier, kind); null while nothing can be read. */
  competence(scopeKey: string, tier: string, taskKind: string): Competence | null {
    try { return this.ready() ? this.store.competence(scopeKey, tier, taskKind) : null; } catch { return null; }
  }

  record(scopeKey: string, turn: { talkId: string; surface: 'text' | 'voice'; tier: string; taskKind: string; growth: number }, at: string): void {
    this.later(at, () => {
      this.store.insert({ outcomeId: randomUUID(), scopeKey, chosenAt: at, ...turn });
      this.expire(scopeKey, at);
    });
  }

  /** The owner's next turn in a Talk, as S: settles the turn before. */
  nextTurn(scopeKey: string, talkId: string, serve: number, at: string): void {
    this.later(at, () => {
      for (const row of this.store.pendingInTalk(scopeKey, talkId)) {
        if (Date.parse(row.chosenAt) <= Date.parse(at)) this.store.settle(scopeKey, row.outcomeId, tierOutcome(row.growth, serve), 'next_turn', at);
      }
      this.expire(scopeKey, at);
    });
  }

  rows(scopeKey: string) { return this.ready() ? this.store.all(scopeKey) : []; }

  private expire(scopeKey: string, at: string): void {
    const before = new Date(Date.parse(at) - TIER_NEXT_TURN_MINUTES * 60_000).toISOString();
    for (const row of this.store.pendingBefore(scopeKey, before)) this.store.settle(scopeKey, row.outcomeId, tierOutcome(row.growth, null), 'turn_expired', at);
    this.store.pruneBefore(new Date(Date.parse(at) - TIER_OUTCOME_RETENTION_DAYS * DAY).toISOString());
  }

  private later(at: string, operation: () => void): void {
    this.defer(() => {
      if (!this.options.database.isOpen) return;
      try {
        if (this.ready()) underWriteLock(this.options.database, this.meter, ownerDayKey(at), operation, 'shannon_tier_outcomes');
      } catch (error) { loggedFailure('tier outcomes', error); }
    });
  }

  private ready(): boolean {
    if (!this.present) this.present = tableExists(this.options.database, TIER_OUTCOMES_TABLE);
    return this.present;
  }
}
