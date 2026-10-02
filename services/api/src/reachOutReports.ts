import { DatabaseSync } from 'node:sqlite';
import { REACH_OUT_DELIVERY_OUTCOMES, type ReachOutDeliveryOutcome, type ReachOutFacts } from './autonomyLoopObservations.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

/**
 * What her body says it did with a message she started on her own (`docs/body-contract.md`,
 * "What the body did with her message"), and when a body last read presence.
 *
 * The API process writes both; her activity loop, a separate process, reads them after it
 * sent a message, to know whether it was shown and whether her window is showing. A report
 * is a closed outcome for one of her own messages, by a device that registered as her body.
 * Both tables hold identifiers, a closed vocabulary and timestamps: no text.
 */
/** A report is accepted this long after the message was written. */
export const REACH_OUT_REPORT_WINDOW_MILLISECONDS = 24 * 60 * 60_000;
/** A presence read this recent means her window is showing. */
export const REACH_OUT_PRESENCE_FRESH_MILLISECONDS = 30_000;
/** The body's away and returned events are read this far back. */
export const REACH_OUT_OWNER_EVENT_WINDOW_MILLISECONDS = 60 * 60_000;

/** When two bodies report differently, the one that got furthest stands. */
const RANK: Readonly<Record<ReachOutDeliveryOutcome, number>> = Object.freeze({ shown_spoken: 5, shown: 4, away: 3, hidden: 2, muted: 1 });

export type ReachOutReportResult = 'stored' | 'duplicate' | 'conflict' | 'not_found' | 'expired';

export class SQLiteReachOutReports {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS reach_out_deliveries (
        scope_key TEXT NOT NULL,
        initiative_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('shown_spoken', 'shown', 'away', 'hidden', 'muted')),
        reported_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, initiative_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS reach_out_body_presence (
        scope_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, device_id)
      );
    `);
    secureDatabaseFiles(path);
  }

  /**
   * Stores what one device did with one of her own messages, once. The same outcome again is a duplicate;
   * another outcome from the same device is a conflict and changes nothing.
   */
  report(scopeKey: string, deviceId: string, initiativeId: string, outcome: ReachOutDeliveryOutcome, at: string): ReachOutReportResult {
    const message = this.tableExists('initiative_messages') ? this.database.prepare(`
      SELECT created_at FROM initiative_messages WHERE scope_key = ? AND initiative_id = ? AND source_item_id LIKE 'reach-out:%'
    `).get(scopeKey, initiativeId) as unknown as { created_at: string } | undefined : undefined;
    if (!message) return 'not_found';
    const known = this.database.prepare(`
      SELECT outcome FROM reach_out_deliveries WHERE scope_key = ? AND initiative_id = ? AND device_id = ?
    `).get(scopeKey, initiativeId, deviceId) as unknown as { outcome: string } | undefined;
    if (known) return known.outcome === outcome ? 'duplicate' : 'conflict';
    if (Date.parse(at) - Date.parse(message.created_at) > REACH_OUT_REPORT_WINDOW_MILLISECONDS) return 'expired';
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO reach_out_deliveries (scope_key, initiative_id, device_id, outcome, reported_at) VALUES (?, ?, ?, ?, ?)
    `).run(scopeKey, initiativeId, deviceId, outcome, at);
    if (Number(inserted.changes) > 0) return 'stored';
    // Another request of the same device won the row meanwhile: the answer follows what is stored.
    const stored = this.database.prepare(`
      SELECT outcome FROM reach_out_deliveries WHERE scope_key = ? AND initiative_id = ? AND device_id = ?
    `).get(scopeKey, initiativeId, deviceId) as unknown as { outcome: string } | undefined;
    return stored?.outcome === outcome ? 'duplicate' : 'conflict';
  }

  /** What her body did with the message, or null while no body has reported. */
  delivery(scopeKey: string, initiativeId: string): ReachOutDeliveryOutcome | null {
    const rows = this.database.prepare(`
      SELECT outcome FROM reach_out_deliveries WHERE scope_key = ? AND initiative_id = ?
    `).all(scopeKey, initiativeId) as unknown as Array<{ outcome: string }>;
    const outcomes = rows.flatMap(row => REACH_OUT_DELIVERY_OUTCOMES.filter(value => value === row.outcome));
    return outcomes.sort((left, right) => RANK[right] - RANK[left])[0] ?? null;
  }

  /** A body read presence: her window is showing on that device. */
  markPresence(scopeKey: string, deviceId: string, at: string): void {
    this.database.prepare(`
      INSERT INTO reach_out_body_presence (scope_key, device_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT (scope_key, device_id) DO UPDATE SET read_at = excluded.read_at
    `).run(scopeKey, deviceId, at);
  }

  /** Whether a body read presence in the half minute before the instant. */
  windowVisible(scopeKey: string, at: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM reach_out_body_presence WHERE scope_key = ? AND read_at >= ? AND read_at <= ? LIMIT 1
    `).get(scopeKey, new Date(Date.parse(at) - REACH_OUT_PRESENCE_FRESH_MILLISECONDS).toISOString(), at));
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}

/** The body store, as far as this module reads it: the newest away or returned event, and who is around. */
export interface ReachOutBodyReader {
  latestOfTypes(scopeKey: string, types: readonly string[], since: string, until: string): { type: string; occurredAt: string } | null;
  othersPresent(scopeKey: string, at: string, freshMilliseconds: number, eventWindowMilliseconds: number): boolean;
}

/**
 * What the server already knows of her body at an instant, for the loop: her window showing, the newest of
 * the owner's away and returned events of the last hour, and whether others are present. Facts the body reported.
 */
export function reachOutBodyFacts(
  reports: Pick<SQLiteReachOutReports, 'windowVisible'>, body: ReachOutBodyReader, scopeKey: string, at: string,
  audience: { freshMilliseconds: number; eventWindowMilliseconds: number },
): Pick<ReachOutFacts, 'windowVisible' | 'owner' | 'others'> {
  const since = new Date(Date.parse(at) - REACH_OUT_OWNER_EVENT_WINDOW_MILLISECONDS).toISOString();
  const newest = body.latestOfTypes(scopeKey, ['ownerAway', 'ownerReturned'], since, at);
  return {
    windowVisible: reports.windowVisible(scopeKey, at),
    owner: newest?.type === 'ownerAway' ? 'away' : newest?.type === 'ownerReturned' ? 'returned' : 'unknown',
    others: body.othersPresent(scopeKey, at, audience.freshMilliseconds, audience.eventWindowMilliseconds),
  };
}
