/**
 * Moves her study to Aether (Syzygy ADR-0007, revised 2026-10-06): stories to 「シャノンの書斎」, notes to 「シャノン用フォルダ」.
 *
 *   tsx --env-file-if-exists=../../.env scripts/migrate-study-to-aether.ts [--scope <scopeKey>] [--database <path>]
 *     Dry run (the default): prints, for each piece, its kind, title, length, stage, whether the owner has seen it, and
 *     where it goes. Metadata only; no body is printed or read. The database is opened read-only: nothing is created,
 *     added or written, so it is safe against the production database. Show this to the owner before anything moves.
 *   ... --apply --services-not-on-aether
 *     Moves what the dry run listed. Run it before SHANNON_AETHER_API_URL is set for the API and the autonomy service, or with
 *     both stopped: a service syncing her study with Aether while pieces move could take a moved story in as a second piece.
 *     The second flag says so and is required. Needs SHANNON_AETHER_API_URL and SHANNON_AETHER_SHANNON_TOKEN in this command's
 *     environment. Back up the database first (docs/self-improvement-runbook.md): it opens the database read-write and adds
 *     the study's Aether tables. Idempotent: run it again after an interruption. The mapping from each piece's id to its
 *     Aether document is kept in `study_aether_links`.
 *
 * The token is read from the environment and never printed.
 */
import { configuredAetherAccess } from '../src/aetherAccess.js';
import { autonomyDayKey, configuredAutonomy } from '../src/autonomyBudget.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { configuredDatabasePath } from '../src/sqliteStore.js';
import { applyMigration, migrationPlan, migrationReport, readOnlyMigrationPlan } from '../src/studyMigration.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const databasePath = option('--database') ?? configuredDatabasePath();
const scope = option('--scope');

if (!args.includes('--apply')) {
  let plans: ReadonlyMap<string, ReturnType<typeof migrationPlan>>;
  try { plans = readOnlyMigrationPlan(databasePath, scope); } catch {
    console.error(`データベースを読み取り専用で開けませんでした（${databasePath}）。何も変えていません。`);
    process.exit(2);
  }
  if (!plans.size) console.log('書斎には何もありません。');
  for (const [scopeKey, items] of plans) console.log(`${migrationReport(scopeKey, items)}\n`);
} else if (!args.includes('--services-not-on-aether')) {
  console.error('--apply は、APIと自律サービスがまだAetherを使っていない時（SHANNON_AETHER_API_URL を設定する前）か、両方を止めている時に、--services-not-on-aether をつけて実行してください。何も移していません。');
  process.exit(2);
} else {
  const access = configuredAetherAccess(process.env);
  if (!access) {
    console.error('Aetherが設定されていません（SHANNON_AETHER_API_URL と SHANNON_AETHER_SHANNON_TOKEN）。何も移していません。');
    process.exit(2);
  }
  const store = new SQLiteAutonomyStore(databasePath);
  try {
    const config = configuredAutonomy(process.env, { databasePath });
    for (const scopeKey of scope ? [scope] : store.study.aether.scopes()) {
      const outcome = await applyMigration(store, access, scopeKey, { now: () => new Date().toISOString(), dayKey: at => autonomyDayKey(at, config) });
      console.log(migrationReport(scopeKey, migrationPlan(store, scopeKey), true));
      for (const failure of outcome.failed) console.log(`移せなかったもの: ${failure.pieceId}（${failure.code}）`);
      if (outcome.failed.length) process.exitCode = 1;
      console.log('');
    }
  } finally {
    store.close();
  }
}
