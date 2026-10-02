import { DatabaseSync } from 'node:sqlite';
import { REACH_OUT_SOURCE_PREFIX, reachOutOfSource } from './reachOutDelivery.js';
import {
  SHANNON_NOW_LIMITS, type ShannonNowBody, type ShannonNowDelivery, type ShannonNowLook, type ShannonNowReachOut, type ShannonNowTouch,
} from './shannonNowContract.js';

/**
 * Reads the tables other modules own, for `GET /v1/shannon/now`. The connection is
 * `query_only`: it creates no table and writes nothing. Every table is optional, so a
 * server on which a feature was never switched on (or a table a later change adds) is an
 * empty list, not an error.
 *
 * No query here selects a text column: not her line after a touch (SQLite answers only
 * whether `said_json` is empty), not the words of a message of hers, not her note of a
 * look. There is no frame anywhere in these tables.
 */

type Tables = (name: string) => boolean;

/**
 * How messages she started reached the owner, per surface. A new surface (her voice in his
 * earphones, an incoming call) adds one function here that reads its own table and returns
 * nothing while that table does not exist.
 */
export type ReachOutDeliverySource = (
  database: DatabaseSync, scopeKey: string, initiativeIds: readonly string[], tableExists: Tables,
) => Array<{ id: string } & ShannonNowDelivery>;

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');

/**
 * What a surface reported about a message (`reach_out_deliveries`): her desktop body
 * (`POST /v1/body/reach-outs/{id}/delivery`, no `surface`), or the Mac or iPhone app that said it in the
 * owner's earphones while private listening was on (`surface` `mac` or `iphone`, `docs/private-listening-contract.md`).
 * A database from before that column has rows of her body only.
 */
const reportedDeliveries: ReachOutDeliverySource = (database, scopeKey, ids, tableExists) => {
  if (!ids.length || !tableExists('reach_out_deliveries')) return [];
  const columns = database.prepare(`PRAGMA table_info('reach_out_deliveries')`).all() as unknown as Array<{ name: string }>;
  const surface = columns.some(column => column.name === 'surface') ? 'surface' : 'NULL';
  const rows = database.prepare(`
    SELECT initiative_id, outcome, reported_at, ${surface} AS surface FROM reach_out_deliveries
    WHERE scope_key = ? AND initiative_id IN (${placeholders(ids)}) ORDER BY reported_at ASC
  `).all(scopeKey, ...ids) as unknown as Array<{ initiative_id: string; outcome: string; reported_at: string; surface: string | null }>;
  return rows.map(row => ({
    id: row.initiative_id, at: row.reported_at, outcome: row.outcome === 'shown_spoken' ? 'spoken' : row.outcome,
    ...(row.surface ? { surface: 'earphones', device: row.surface } : { surface: 'body' }),
  }));
};

export const REACH_OUT_DELIVERY_SOURCES: readonly ReachOutDeliverySource[] = Object.freeze([reportedDeliveries]);

export class SQLiteShannonNowReader {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly deliverySources: readonly ReachOutDeliverySource[] = REACH_OUT_DELIVERY_SOURCES) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
  }

  /** Whether a state was ever stored for the scope. The state store writes a first state when asked for one; this read never causes that. */
  hasState(scopeKey: string): boolean {
    return guarded(false, () => this.tableExists('companion_states')
      && Boolean(this.database.prepare('SELECT 1 AS found FROM companion_states WHERE scope_key = ?').get(scopeKey)));
  }

  /** Whether a body read presence lately, from the two places a presence read is noted. */
  body(scopeKey: string, at: string): ShannonNowBody {
    return guarded({ known: false, present: false, lastReadAt: null, freshSeconds: SHANNON_NOW_LIMITS.bodyFreshSeconds, camera: null }, () => this.readBody(scopeKey, at));
  }

  private readBody(scopeKey: string, at: string): ShannonNowBody {
    const reads = ['reach_out_body_presence', 'body_look_presence'].flatMap(table => {
      if (!this.tableExists(table)) return [];
      const row = this.database.prepare(`SELECT MAX(read_at) AS latest FROM ${table} WHERE scope_key = ?`).get(scopeKey) as unknown as { latest: string | null };
      return row.latest ? [row.latest] : [];
    });
    const lastReadAt = reads.sort().at(-1) ?? null;
    const age = lastReadAt ? Date.parse(at) - Date.parse(lastReadAt) : Number.POSITIVE_INFINITY;
    return {
      known: lastReadAt !== null,
      present: age >= 0 && age <= SHANNON_NOW_LIMITS.bodyFreshSeconds * 1_000,
      lastReadAt, freshSeconds: SHANNON_NOW_LIMITS.bodyFreshSeconds, camera: this.camera(scopeKey),
    };
  }

  /** Looks through her body's camera and through the app's, newest first. Who, where, how it ended: nothing of what she saw. */
  looks(scopeKey: string, since: string): ShannonNowLook[] {
    return newestFirst([...guarded([], () => this.bodyLooks(scopeKey, since)), ...guarded([], () => this.appLooks(scopeKey, since))]);
  }

  private bodyLooks(scopeKey: string, since: string): ShannonNowLook[] {
    const looks: ShannonNowLook[] = [];
    if (this.tableExists('body_looks')) {
      const rows = this.database.prepare(`
        SELECT look_id, requested_at, owner_asked, outcome, code FROM body_looks
        WHERE scope_key = ? AND requested_at >= ? ORDER BY requested_at DESC LIMIT ?
      `).all(scopeKey, since, SHANNON_NOW_LIMITS.items) as unknown as Array<{ look_id: string; requested_at: string; owner_asked: number; outcome: string; code: string | null }>;
      for (const row of rows) {
        looks.push({
          id: row.look_id, at: row.requested_at, askedBy: Number(row.owner_asked) === 1 ? 'owner' : 'herself', surface: 'body',
          outcome: lookOutcome(row.outcome), ...(row.code ? { code: row.code } : {}),
        });
      }
    }
    return looks;
  }

  private appLooks(scopeKey: string, since: string): ShannonNowLook[] {
    const looks: ShannonNowLook[] = [];
    if (this.tableExists('app_looks')) {
      const rows = this.database.prepare(`
        SELECT look_id, requested_at, outcome, code FROM app_looks
        WHERE scope_key = ? AND requested_at >= ? ORDER BY requested_at DESC LIMIT ?
      `).all(scopeKey, since, SHANNON_NOW_LIMITS.items) as unknown as Array<{ look_id: string; requested_at: string; outcome: string; code: string | null }>;
      for (const row of rows) {
        // The row of an app look does not say whether he asked or she wanted to.
        looks.push({ id: row.look_id, at: row.requested_at, askedBy: 'unknown', surface: 'app', outcome: lookOutcome(row.outcome), ...(row.code ? { code: row.code } : {}) });
      }
    }
    return looks;
  }

  /** Runs of touches, newest first: the kind, how many, and whether she answered with a line. */
  touches(scopeKey: string, since: string): ShannonNowTouch[] {
    return guarded([], () => this.readTouches(scopeKey, since));
  }

  private readTouches(scopeKey: string, since: string): ShannonNowTouch[] {
    if (!this.tableExists('body_touch_bursts')) return [];
    const rows = this.database.prepare(`
      SELECT burst_id, touch_type, last_at, touch_count, (said_json IS NOT NULL AND said_json NOT IN ('', '[]')) AS answered FROM body_touch_bursts
      WHERE scope_key = ? AND last_at >= ? ORDER BY last_at DESC LIMIT ?
    `).all(scopeKey, since, SHANNON_NOW_LIMITS.items) as unknown as Array<{ burst_id: string; touch_type: string; last_at: string; touch_count: number; answered: number }>;
    return rows.map(row => ({ id: row.burst_id, at: row.last_at, kind: row.touch_type, count: Number(row.touch_count), answered: Number(row.answered) === 1 }));
  }

  /** Messages she started on her own, newest first, each with how it was delivered. Never the words. */
  reachOuts(scopeKey: string, since: string): ShannonNowReachOut[] {
    return guarded([], () => this.readReachOuts(scopeKey, since));
  }

  private readReachOuts(scopeKey: string, since: string): ShannonNowReachOut[] {
    if (!this.tableExists('initiative_messages')) return [];
    const rows = this.database.prepare(`
      SELECT initiative_id, created_at, source_item_id, read_at FROM initiative_messages
      WHERE scope_key = ? AND source_item_id LIKE ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?
    `).all(scopeKey, `${REACH_OUT_SOURCE_PREFIX}%`, since, SHANNON_NOW_LIMITS.items) as unknown as Array<{ initiative_id: string; created_at: string; source_item_id: string; read_at: string | null }>;
    const ids = rows.map(row => row.initiative_id);
    const delivered = new Map<string, ShannonNowDelivery[]>();
    const add = (id: string, delivery: ShannonNowDelivery) => delivered.set(id, [...delivered.get(id) ?? [], delivery]);
    for (const source of this.deliverySources) {
      // One surface whose table is in another shape must not take the page away.
      try { for (const { id, ...delivery } of source(this.database, scopeKey, ids, name => this.tableExists(name))) add(id, delivery); } catch { /* that surface is left out */ }
    }
    for (const row of rows) if (row.read_at) add(row.initiative_id, { surface: 'app', outcome: 'read', at: row.read_at });
    return rows.map(row => {
      const reason = reachOutOfSource(row.source_item_id)?.reason;
      return {
        id: row.initiative_id, at: row.created_at, ...(reason ? { reason } : {}),
        deliveries: (delivered.get(row.initiative_id) ?? []).sort((left, right) => left.at.localeCompare(right.at)),
      };
    });
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private camera(scopeKey: string): boolean | null {
    if (!this.tableExists('body_capabilities')) return null;
    const rows = this.database.prepare('SELECT flags_json FROM body_capabilities WHERE scope_key = ?').all(scopeKey) as unknown as Array<{ flags_json: string }>;
    if (!rows.length) return null;
    return rows.some(row => {
      try { return (JSON.parse(row.flags_json) as Record<string, unknown>).camera === true; } catch { return false; }
    });
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}

/**
 * A table in a shape this reader does not know (an older database, a later change) leaves its part of the page
 * empty; the rest still arrives.
 */
function guarded<T>(fallback: T, read: () => T): T {
  try { return read(); } catch { return fallback; }
}

/** `pending` and `seeing` are one state for the owner: she is looking. */
function lookOutcome(stored: string): string {
  return stored === 'pending' || stored === 'seeing' ? 'looking' : stored;
}

function newestFirst<T extends { at: string }>(items: T[]): T[] {
  return items.sort((left, right) => right.at.localeCompare(left.at)).slice(0, SHANNON_NOW_LIMITS.items);
}
