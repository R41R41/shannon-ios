import { DatabaseSync } from 'node:sqlite';

/**
 * Read-only counts of the shared database for the owner's 点検 and capability views (Syzygy ADR-0009 stage 2;
 * `docs/executive-ui-contract.md`): closed symbols, numbers and instants only, never a word. A table that does not exist (a
 * switched-off ledger, a fresh database) reads as nothing; the connection is opened read-only on first use.
 */
export interface ChoiceUse {
  readonly choice: string;
  readonly total: number;
  readonly recent: number;
  readonly lastAt: string | null;
}

export interface PredictionMark {
  readonly at: string;
  /** Settled and inside its interval; null while open. */
  readonly hit: boolean | null;
}

export interface NoticeMark {
  readonly at: string;
  /** Answered (S ≥ 0.5), unanswered (S < 0.5), or null while it waits. */
  readonly answered: boolean | null;
}

export class ExecutiveReadings {
  private database: DatabaseSync | null = null;

  constructor(private readonly path: string) {}

  /** The read-only handle, or null when the file cannot be opened. */
  connection(): DatabaseSync | null {
    if (this.database) return this.database;
    try {
      this.database = new DatabaseSync(this.path, { readOnly: true });
    } catch {
      return null;
    }
    return this.database;
  }

  /** How often each choice key was made in all, and since `since`. */
  choiceUses(scopeKey: string, since: string): readonly ChoiceUse[] {
    return this.rows('shannon_choices', database => database.prepare(`
      SELECT choice, COUNT(*) AS total, SUM(chosen_at >= ?) AS recent, MAX(chosen_at) AS last_at FROM shannon_choices WHERE scope_key = ? GROUP BY choice
    `).all(since, scopeKey).map(row => ({
      choice: String(row.choice), total: Number(row.total), recent: Number(row.recent ?? 0), lastAt: row.last_at ? String(row.last_at) : null,
    })));
  }

  /** Her predictions made since an instant (void ones left out). */
  predictions(scopeKey: string, since: string): readonly PredictionMark[] {
    return this.rows('shannon_predictions', database => database.prepare(`
      SELECT made_at, status, outcome, interval_low, interval_high FROM shannon_predictions WHERE scope_key = ? AND made_at >= ? AND status <> 'void'
    `).all(scopeKey, since).map(row => ({
      at: String(row.made_at),
      hit: row.status === 'matched' && row.outcome !== null
        ? Number(row.outcome) >= Number(row.interval_low) && Number(row.outcome) <= Number(row.interval_high) : null,
    })));
  }

  /** Her messages and calls to the owner since an instant (choices `reach_out.*`, `call.*`, `follow_up`), and what followed. */
  notices(scopeKey: string, since: string): readonly NoticeMark[] {
    return this.rows('shannon_choices', database => database.prepare(`
      SELECT chosen_at, success FROM shannon_choices
      WHERE scope_key = ? AND chosen_at >= ? AND (choice LIKE 'reach_out.%' OR choice LIKE 'call.%' OR choice = 'follow_up') AND status <> 'void'
    `).all(scopeKey, since).map(row => ({ at: String(row.chosen_at), answered: row.success === null ? null : Number(row.success) >= 0.5 })));
  }

  /** Completed sleep runs by their day. */
  sleepRuns(scopeKey: string, dayKeys: readonly string[]): ReadonlyMap<string, number> {
    const rows = this.rows('sleep_runs', database => database.prepare(`
      SELECT day_key, COUNT(*) AS n FROM sleep_runs WHERE scope_key = ? AND status = 'completed' GROUP BY day_key
    `).all(scopeKey).map(row => [String(row.day_key), Number(row.n)] as const));
    const wanted = new Set(dayKeys);
    return new Map(rows.filter(([day]) => wanted.has(day)));
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }

  private rows<T>(table: string, read: (database: DatabaseSync) => T[]): T[] {
    const database = this.connection();
    if (!database) return [];
    try {
      if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) return [];
      return read(database);
    } catch {
      return [];
    }
  }
}
