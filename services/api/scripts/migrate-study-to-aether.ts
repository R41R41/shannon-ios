/**
 * Moves her study to Aether (Syzygy ADR-0007, revised 2026-10-06): stories to 「シャノンの書斎」, notes to 「シャノン用フォルダ」.
 *
 *   tsx --env-file-if-exists=../../.env scripts/migrate-study-to-aether.ts [--scope <scopeKey>] [--database <path>]
 *     Dry run (the default): prints, for each piece, its kind, title, length, stage, whether the owner has seen it, and
 *     where it goes. Metadata only; no body is printed or read. The database is opened read-only: nothing is created,
 *     added or written, so it is safe against the production database. Show this to the owner before anything moves.
 *   ... --apply --services-stopped
 *     Moves what the dry run listed. Stop the API and the autonomy service first and keep them stopped from --apply until
 *     SHANNON_AETHER_API_URL is set for both: a service syncing her study during the move could take a moved story in as a
 *     second piece, and a piece she revises in Shannon in between leaves Aether behind. The second flag says they are
 *     stopped and is required; the autonomy loop's lease is also checked (refused while its runner reported in the last
 *     five minutes). Run --apply again right before setting the address: a moved piece revised or put in her trash since
 *     is sent to Aether then (from the version Aether has). Needs SHANNON_AETHER_API_URL and SHANNON_AETHER_SHANNON_TOKEN in this command's
 *     environment. Back up the database first (docs/self-improvement-runbook.md): it opens the database read-write and adds
 *     the study's Aether tables. Idempotent: run it again after an interruption. The mapping from each piece's id to its
 *     Aether document is kept in `study_aether_links`.
 *
 * The token is read from the environment and never printed.
 */
import { aetherStudyScope, configuredAetherAccess } from '../src/integrations/aether/aetherAccess.js';
import { autonomyDayKey, configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { SQLiteAutonomyStore } from '../src/mind/action/ownTime/store/autonomyStore.js';
import { configuredDatabasePath } from '../src/infra/sqlite/sqliteStore.js';
import { DatabaseSync } from 'node:sqlite';
import { applyMigration, migrationPlan, migrationReport, readOnlyMigrationPlan } from '../src/mind/action/ownTime/store/studyMigration.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const databasePath = option('--database') ?? configuredDatabasePath();
// Only the owner's scope moves (`SHANNON_OWNER_SCOPE_KEY`, default `owner`): Aether has one シャノン用フォルダ. Every other scope keeps the SQLite study.
const scope = aetherStudyScope(process.env);
if (option('--scope') && option('--scope') !== scope) {
  console.error(`Aetherへ移せるのは scope「${scope}」の書斎だけです（SHANNON_OWNER_SCOPE_KEY）。何も変えていません。`);
  process.exit(2);
}

if (!args.includes('--apply')) {
  let plans: ReadonlyMap<string, ReturnType<typeof migrationPlan>>;
  try { plans = readOnlyMigrationPlan(databasePath); } catch {
    console.error(`データベースを読み取り専用で開けませんでした（${databasePath}）。何も変えていません。`);
    process.exit(2);
  }
  console.log(`${migrationReport(scope, plans.get(scope) ?? [])}\n`);
  const others = [...plans.keys()].filter(key => key !== scope);
  if (others.length) console.log(`ほかの scope（${others.join('、')}）の書斎は移さず、Shannonに残ります。`);
} else if (!args.includes('--services-stopped')) {
  console.error('--apply は、APIと自律サービスを止めてから（SHANNON_AETHER_API_URL を両方に設定して起動し直すまで止めたまま）、--services-stopped をつけて実行してください。何も移していません。');
  process.exit(2);
} else if (loopRunning(databasePath)) {
  console.error('自律サービスがこの5分以内に動いていました。止めてから、もう一度実行してください。何も移していません。');
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
    for (const scopeKey of [scope]) {
      const outcome = await applyMigration(store, access, scopeKey, { now: () => new Date().toISOString(), dayKey: at => autonomyDayKey(at, config) });
      console.log(migrationReport(scopeKey, migrationPlan(store, scopeKey), true));
      console.log(`この実行で移したもの ${outcome.moved.length}件、移したあとの変更を送ったもの ${outcome.caughtUp.length}件。`);
      for (const failure of outcome.failed) console.log(`移せなかったもの: ${failure.pieceId}（${failure.code}）`);
      if (outcome.failed.length) process.exitCode = 1;
      console.log('');
    }
  } finally {
    store.close();
  }
}

/** Whether the autonomy loop's runner reported in the last five minutes (its lease), read without changing anything. */
function loopRunning(path: string): boolean {
  let database: DatabaseSync;
  try { database = new DatabaseSync(path, { readOnly: true }); } catch { return false; }
  try {
    if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'autonomy_loop_lease'`).get()) return false;
    const rows = database.prepare('SELECT heartbeat_at FROM autonomy_loop_lease').all() as unknown as Array<{ heartbeat_at: string }>;
    return rows.some(row => Date.now() - Date.parse(row.heartbeat_at) < 5 * 60_000);
  } finally {
    database.close();
  }
}
