/**
 * Moves her study to Aether (Syzygy ADR-0007, revised 2026-10-06): stories to 「シャノンの書斎」, notes to 「シャノン用フォルダ」.
 *
 *   tsx --env-file-if-exists=../../.env scripts/migrate-study-to-aether.ts [--scope <scopeKey>] [--database <path>]
 *     Dry run (the default): prints, for each piece, its kind, title, length, stage, whether the owner has seen it, and
 *     where it goes. Metadata only; no body is printed. Show this to the owner before anything moves.
 *   ... --apply
 *     Moves what the dry run listed. Needs SHANNON_AETHER_API_URL and SHANNON_AETHER_SHANNON_TOKEN. Idempotent: run it again
 *     after an interruption. The mapping from each piece's id to its Aether document is kept in `study_aether_links`.
 *
 * Back up the database first (docs/self-improvement-runbook.md). The token is read from the environment and never printed.
 */
import { configuredAetherAccess } from '../src/aetherAccess.js';
import { autonomyDayKey, configuredAutonomy } from '../src/autonomyBudget.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { configuredDatabasePath } from '../src/sqliteStore.js';
import { applyMigration, migrationPlan, migrationReport } from '../src/studyMigration.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const apply = args.includes('--apply');
const databasePath = option('--database') ?? configuredDatabasePath();
const store = new SQLiteAutonomyStore(databasePath);
try {
  const scopes = option('--scope') ? [option('--scope')!] : store.study.aether.scopes();
  if (!scopes.length) console.log('書斎には何もありません。');
  const access = apply ? configuredAetherAccess(process.env) : null;
  if (apply && !access) {
    console.error('Aetherが設定されていません（SHANNON_AETHER_API_URL と SHANNON_AETHER_SHANNON_TOKEN）。何も移していません。');
    process.exitCode = 2;
  } else {
    const config = configuredAutonomy(process.env, { databasePath });
    for (const scopeKey of scopes) {
      if (access) {
        const outcome = await applyMigration(store, access, scopeKey, { now: () => new Date().toISOString(), dayKey: at => autonomyDayKey(at, config) });
        console.log(migrationReport(scopeKey, migrationPlan(store, scopeKey), true));
        for (const failure of outcome.failed) console.log(`移せなかったもの: ${failure.pieceId}（${failure.code}）`);
        if (outcome.failed.length) process.exitCode = 1;
      } else {
        console.log(migrationReport(scopeKey, migrationPlan(store, scopeKey)));
      }
      console.log('');
    }
  }
} finally {
  store.close();
}
