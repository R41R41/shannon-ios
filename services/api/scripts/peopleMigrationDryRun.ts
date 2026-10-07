/**
 * Syzygy ADR-0008 stage 3, step F6: the people migration's dry-run (`scripts/shannon-people-migration.sh --dry-run`).
 *
 *   scripts/shannon-people-migration.sh --dry-run [--scope <scopeKey>] [--database <path>] [--json]
 *
 * Opens the database read-only and prints, per person, which impressions would change status with two-clock decay
 * (`SHANNON_EVIDENCE_DECAY`, off until the owner has seen this), and how many rows the additive temporal backfill would touch.
 * It changes nothing; the migration itself is additive and runs when its switch is on (`SHANNON_TEMPORAL_FACTS`).
 */
import { DatabaseSync } from 'node:sqlite';
import { peopleMigrationReport, peopleMigrationText } from '../src/mind/memory/store/peopleMigrationReport.js';
import { shannonNowOwnerScope } from '../src/contracts/shannonNowContract.js';
import { configuredDatabasePath } from '../src/infra/sqlite/sqliteStore.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
if (!args.includes('--dry-run')) {
  console.error('usage: shannon-people-migration.sh --dry-run [--scope <scopeKey>] [--database <path>] [--json]  (only the dry-run exists: it changes nothing)');
  process.exit(2);
}
const database = new DatabaseSync(option('--database') ?? configuredDatabasePath(), { readOnly: true });
try {
  const report = peopleMigrationReport(database, option('--scope') ?? shannonNowOwnerScope(process.env), new Date().toISOString());
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : peopleMigrationText(report));
} finally { database.close(); }
