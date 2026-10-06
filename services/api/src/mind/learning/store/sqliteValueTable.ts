import type { DatabaseSync } from 'node:sqlite';
import type { ValueCell, ValueLevel, ValueVersionRecord } from '@shannon/learning';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL } from '../../../predictionStore.js';

/**
 * The tables of the value table's versions (Syzygy ADR-0008 stage 1, `docs/cognition-ledger-contract.md`). Core: emotion.
 * Additive, created when absent by the API's processes only. Closed symbols, ids, numbers and instants only.
 */
export const VALUE_VERSIONS_TABLE = 'shannon_value_versions';

export function ensureValueTableSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_value_versions (
      version_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      made_by TEXT NOT NULL,
      formula TEXT NOT NULL,
      weights_json TEXT NOT NULL,
      cost_unit_yen REAL,
      base_version TEXT,
      evidence_from INTEGER NOT NULL,
      evidence_to INTEGER NOT NULL,
      state TEXT NOT NULL,
      frozen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS shannon_value_versions_scope ON shannon_value_versions (scope_key, created_at);
    CREATE TABLE IF NOT EXISTS shannon_value_cells (
      version_id TEXT NOT NULL,
      level TEXT NOT NULL,
      choice TEXT NOT NULL,
      context TEXT NOT NULL,
      n INTEGER NOT NULL,
      mean REAL NOT NULL,
      uncertainty REAL NOT NULL,
      noise REAL NOT NULL,
      volatility REAL NOT NULL,
      last_at TEXT,
      mean_world REAL NOT NULL,
      mean_serve REAL NOT NULL,
      mean_growth REAL NOT NULL,
      mean_cost_yen REAL NOT NULL,
      PRIMARY KEY (version_id, level, choice, context)
    );
  `);
}

const round = (value: number) => Math.round(value * 1e9) / 1e9;
const symbolOrEmpty = (value: string) => value === '' || PREDICTION_SYMBOL.test(value);

export class SQLiteValueTable {
  constructor(private readonly database: DatabaseSync, options: { createSchema: boolean }) {
    if (options.createSchema) ensureValueTableSchema(database);
  }

  /** Writes a version and its cells, and makes it the active one of its scope. */
  insertActive(scopeKey: string, version: ValueVersionRecord, cells: readonly ValueCell[]): void {
    if (!PREDICTION_SOURCE_ID.test(version.versionId) || (version.baseVersion && !PREDICTION_SOURCE_ID.test(version.baseVersion))) throw new Error('VALUE_IDENTIFIER');
    if (!PREDICTION_SYMBOL.test(version.formula) || !Object.keys(version.weights).every(name => PREDICTION_SYMBOL.test(name))) throw new Error('VALUE_SYMBOL');
    this.database.prepare("UPDATE shannon_value_versions SET state = 'retired' WHERE scope_key = ? AND state = 'active'").run(scopeKey);
    this.database.prepare(`
      INSERT INTO shannon_value_versions (version_id, scope_key, created_at, made_by, formula, weights_json, cost_unit_yen, base_version, evidence_from, evidence_to, state, frozen)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active', ?)
    `).run(version.versionId, scopeKey, version.createdAt, version.madeBy, version.formula, JSON.stringify(version.weights), version.baseVersion,
      version.evidenceFrom, version.evidenceTo, version.frozen ? 1 : 0);
    const insert = this.database.prepare(`
      INSERT INTO shannon_value_cells (version_id, level, choice, context, n, mean, uncertainty, noise, volatility, last_at, mean_world, mean_serve, mean_growth, mean_cost_yen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cell of cells) {
      if (!symbolOrEmpty(cell.choice) || !symbolOrEmpty(cell.context)) throw new Error('VALUE_SYMBOL');
      insert.run(version.versionId, cell.level, cell.choice, cell.context, cell.n, round(cell.mean), round(cell.uncertainty), round(cell.noise), round(cell.volatility),
        cell.lastAt === null ? null : new Date(cell.lastAt).toISOString(), round(cell.world), round(cell.serve), round(cell.growth), round(cell.costYen));
    }
  }

  active(scopeKey: string): ValueVersionRecord | null {
    const row = this.database.prepare("SELECT * FROM shannon_value_versions WHERE scope_key = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1").get(scopeKey) as Record<string, unknown> | undefined;
    return row ? parsedVersion(row) : null;
  }

  activeId(scopeKey: string): string | null {
    const row = this.database.prepare("SELECT version_id FROM shannon_value_versions WHERE scope_key = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1").get(scopeKey) as { version_id: string } | undefined;
    return row?.version_id ?? null;
  }

  versions(scopeKey: string): ValueVersionRecord[] {
    return (this.database.prepare('SELECT * FROM shannon_value_versions WHERE scope_key = ? ORDER BY created_at, version_id').all(scopeKey) as Array<Record<string, unknown>>).map(parsedVersion);
  }

  cells(versionId: string): ValueCell[] {
    return (this.database.prepare('SELECT * FROM shannon_value_cells WHERE version_id = ? ORDER BY rowid').all(versionId) as Array<Record<string, unknown>>).map(row => ({
      level: String(row.level) as ValueLevel, choice: String(row.choice), context: String(row.context), n: Number(row.n), mean: Number(row.mean),
      uncertainty: Number(row.uncertainty), noise: Number(row.noise), volatility: Number(row.volatility),
      lastAt: row.last_at === null ? null : Date.parse(String(row.last_at)), world: Number(row.mean_world), serve: Number(row.mean_serve),
      growth: Number(row.mean_growth), costYen: Number(row.mean_cost_yen),
    }));
  }

  deleteVersions(versionIds: readonly string[]): void {
    for (const id of versionIds) {
      this.database.prepare('DELETE FROM shannon_value_cells WHERE version_id = ?').run(id);
      this.database.prepare('DELETE FROM shannon_value_versions WHERE version_id = ?').run(id);
    }
  }
}

function parsedVersion(row: Record<string, unknown>): ValueVersionRecord {
  let weights: Record<string, number> = {};
  try { weights = JSON.parse(String(row.weights_json)) as Record<string, number>; } catch { weights = {}; }
  return {
    versionId: String(row.version_id), createdAt: String(row.created_at), madeBy: String(row.made_by) as ValueVersionRecord['madeBy'], formula: String(row.formula), weights,
    baseVersion: row.base_version === null ? null : String(row.base_version), evidenceFrom: Number(row.evidence_from), evidenceTo: Number(row.evidence_to),
    state: String(row.state) as ValueVersionRecord['state'], frozen: Number(row.frozen) === 1,
  };
}
