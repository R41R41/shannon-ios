/**
 * The owner's controls of her value table on the server (Syzygy ADR-0008 stage 1 §7; `docs/cognition-ledger-contract.md`).
 *
 *   scripts/shannon-values.sh show      [--scope <scopeKey>] [--database <path>]
 *   scripts/shannon-values.sh rollback  [--scope <scopeKey>] [--database <path>] [--version <versionId>]
 *   scripts/shannon-values.sh resume    [--scope <scopeKey>] [--database <path>]
 *
 * `show` prints the versions, the active version's cells, the calibration and the choices by status (numbers and closed
 * symbols). `rollback` returns to an earlier version (by default the newest one that learned from less) and freezes: what is
 * settled after it is not used until `resume`, which makes a version from all the evidence again. Each control is written to
 * the activity record as an owner action, like the route `POST /v1/autonomy/values/…`. The scope defaults to
 * `SHANNON_OWNER_SCOPE_KEY` (or `owner`). Nothing is created: the API makes the tables.
 */
import { DatabaseSync } from 'node:sqlite';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { ownerValueRecorder, valuesView } from '../src/infra/http/learningRoutes.js';
import { PredictionLedger } from '../src/mind/learning/predictionLedger.js';
import { SQLiteChoiceLedger } from '../src/mind/learning/store/sqliteChoiceLedger.js';
import { ValueVersions } from '../src/mind/learning/valueTable.js';
import { shannonNowOwnerScope } from '../src/contracts/shannonNowContract.js';
import { configuredDatabasePath } from '../src/sqliteStore.js';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const command = args[0];
if (command !== 'show' && command !== 'rollback' && command !== 'resume') {
  console.error('usage: shannon-values.sh show|rollback|resume [--scope <scopeKey>] [--database <path>] [--version <versionId>]');
  process.exit(2);
}
const scopeKey = option('--scope') ?? shannonNowOwnerScope(process.env);
const databasePath = option('--database') ?? configuredDatabasePath();
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout = 5000;');
const values = new ValueVersions({ database, createsSchema: false });
const predictions = new PredictionLedger({ database, createsSchema: false, log: () => undefined });
const choices = new SQLiteChoiceLedger(database, { createSchema: false });
const view = () => valuesView({
  values, calibration: key => predictions.calibration(key),
  choices: key => { try { return choices.counts(key); } catch { return {}; } },
}, scopeKey);
let exitCode = 0;
if (command === 'show') {
  console.log(JSON.stringify(view(), null, 2));
} else {
  const at = new Date().toISOString();
  const result = command === 'rollback' ? values.rollback(scopeKey, at, option('--version')) : values.resume(scopeKey, at);
  if (typeof result === 'string') {
    console.error(result);
    exitCode = 1;
  } else {
    const autonomy = new SQLiteAutonomyStore(databasePath);
    try { ownerValueRecorder(autonomy.activity, configuredAutonomy(process.env, { databasePath }))(scopeKey, command, result.versionId, at); } finally { autonomy.close(); }
    console.log(JSON.stringify({ [command]: result, ...view() }, null, 2));
  }
}
database.close();
process.exitCode = exitCode;
