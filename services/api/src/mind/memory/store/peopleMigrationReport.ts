import type { DatabaseSync } from 'node:sqlite';
import type { CompanionStateSnapshot } from '@shannon/cognition';
import { decayDryRun, type DecayDryRunPerson } from '../personFacts.js';
import { OWNER_PERSON_KEY, type PersonImpression } from '../impressions.js';

/**
 * What the people migration of Syzygy ADR-0008 stage 3 (F6) would do, read from the database without changing anything
 * (`scripts/shannon-people-migration.sh --dry-run`; owner answer 4: he sees it before `SHANNON_EVIDENCE_DECAY` is turned on):
 * - the temporal backfill: whether `person_memory_items` has its validity columns yet, and how many rows and impressions the
 *   additive backfill would give them;
 * - two-clock decay: per person, every impression whose handling would change (today's in use, not in use or retired against
 *   the new status), with its net evidence; the owner's own are exempt and never listed.
 */
export interface PeopleMigrationReport {
  scopeKey: string;
  at: string;
  temporal: { columns: boolean; itemsToBackfill: number; impressionsToBackfill: number };
  decay: Array<DecayDryRunPerson & { displayName: string }>;
  impressions: number;
}

const table = (database: DatabaseSync, name: string) => Boolean(database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

export function peopleMigrationReport(database: DatabaseSync, scopeKey: string, at: string): PeopleMigrationReport {
  const items = table(database, 'person_memory_items');
  const columns = items && (database.prepare('PRAGMA table_info(person_memory_items)').all() as Array<{ name: string }>).some(column => column.name === 'valid_at');
  const itemsToBackfill = !items ? 0 : Number((database.prepare(`SELECT COUNT(*) AS count FROM person_memory_items WHERE scope_key = ?${columns ? ' AND valid_at IS NULL' : ''}`)
    .get(scopeKey) as { count: number }).count);
  const rows: PersonImpression[] = !table(database, 'person_impressions') ? [] : (database.prepare('SELECT person_key, data_json FROM person_impressions WHERE scope_key = ?')
    .all(scopeKey) as Array<{ person_key: string; data_json: string }>).flatMap(row => {
    try {
      const value = JSON.parse(row.data_json) as PersonImpression;
      return typeof value?.id === 'string' && Array.isArray(value.evidence) ? [{ ...value, personKey: row.person_key }] : [];
    } catch { return []; }
  });
  const stateRow = table(database, 'companion_states')
    ? database.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scopeKey) as { snapshot_json: string } | undefined : undefined;
  let controls: CompanionStateSnapshot['memoryControls'] = [];
  try { controls = stateRow ? (JSON.parse(stateRow.snapshot_json) as CompanionStateSnapshot).memoryControls ?? [] : []; } catch { controls = []; }
  const names = new Map(table(database, 'people')
    ? (database.prepare('SELECT person_id, display_name FROM people WHERE scope_key = ?').all(scopeKey) as Array<{ person_id: string; display_name: string }>).map(row => [row.person_id, row.display_name] as const)
    : []);
  return {
    scopeKey, at,
    temporal: { columns, itemsToBackfill, impressionsToBackfill: rows.filter(row => row.validAt === undefined).length },
    decay: decayDryRun(rows, { memoryControls: controls }, at).map(person => ({ ...person,
      displayName: person.personKey === OWNER_PERSON_KEY ? 'ライ氏（持ち主）' : names.get(person.personKey) ?? '（名前のない人）' })),
    impressions: rows.length,
  };
}

/** The report as the owner reads it in a terminal: one line per change, grouped by person. */
export function peopleMigrationText(report: PeopleMigrationReport): string {
  const lines = [
    `people migration dry-run (scope ${report.scopeKey}, at ${report.at}); nothing was changed`,
    `temporal columns: ${report.temporal.columns ? 'present' : 'absent'}; rows to backfill: ${report.temporal.itemsToBackfill}; impressions to backfill: ${report.temporal.impressionsToBackfill}`,
    `two-clock decay (SHANNON_EVIDENCE_DECAY): ${report.decay.reduce((sum, person) => sum + person.transitions.length, 0)} of ${report.impressions} impressions would change`,
  ];
  for (const person of report.decay) {
    lines.push(`- ${person.displayName}:`);
    for (const item of person.transitions) lines.push(`  - ${item.pattern} : ${item.current} -> ${item.after} (net ${item.net.toFixed(2)})`);
  }
  return lines.join('\n');
}
