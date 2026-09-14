import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export type RecordedTestFlightDistributionResult =
  | { readonly status: 'distributed'; readonly buildId: string; readonly version: string }
  | { readonly status: 'already-current'; readonly buildId: string; readonly version: string }
  | { readonly status: 'no-valid-build' };

export type TestFlightDeliveryStatus = RecordedTestFlightDistributionResult['status'] | 'failed';
export type TestFlightDeliveryCondition = 'healthy' | 'waiting' | 'attention';
export type TestFlightNotificationStatus = 'not-needed' | 'pending' | 'sent' | 'suppressed';
export type TestFlightReleaseGateKey = 'build' | 'archive' | 'upload' | 'processing' | 'assignment' | 'install' | 'smoke';
export type TestFlightReleaseGateStatus = 'pending' | 'complete' | 'attention';

export interface TestFlightReleaseGate {
  readonly key: TestFlightReleaseGateKey;
  readonly status: TestFlightReleaseGateStatus;
  readonly completedAt: string | null;
}

export interface TestFlightReleaseProgress {
  readonly platform: 'ios';
  readonly buildVersion: string | null;
  readonly gates: readonly TestFlightReleaseGate[];
}

export interface TestFlightDeliveryHistoryItem {
  readonly id: string;
  readonly status: TestFlightDeliveryStatus;
  readonly buildVersion: string | null;
  readonly checkedAt: string;
  readonly failureCode: string | null;
  readonly notificationStatus: TestFlightNotificationStatus;
}

export interface TestFlightDeliveryDashboard {
  readonly condition: TestFlightDeliveryCondition;
  readonly latestBuildVersion: string | null;
  readonly lastCheckedAt: string | null;
  readonly activeFailureCode: string | null;
  readonly history: readonly TestFlightDeliveryHistoryItem[];
  readonly release: TestFlightReleaseProgress;
}

export interface TestFlightDeliveryReader {
  dashboard(limit?: number, scopeKey?: string): TestFlightDeliveryDashboard;
  confirmGate?(
    scopeKey: string,
    buildVersion: string,
    gate: 'install' | 'smoke',
    at?: string,
  ): TestFlightDeliveryDashboard;
}

interface RunRow {
  run_id: string;
  status: TestFlightDeliveryStatus;
  build_version: string | null;
  failure_code: string | null;
  checked_at: string;
  notification_key: string | null;
}

interface EpisodeRow {
  episode_id: string;
  fingerprint: string;
  failure_code: string;
}

const MAXIMUM_HISTORY_ROWS = 500;

export class SQLiteTestFlightDeliveryStore implements TestFlightDeliveryReader {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS testflight_delivery_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('distributed','already-current','no-valid-build','failed')),
        build_id TEXT,
        build_version TEXT,
        failure_code TEXT,
        checked_at TEXT NOT NULL,
        notification_key TEXT
      );
      CREATE INDEX IF NOT EXISTS testflight_delivery_runs_checked
        ON testflight_delivery_runs (checked_at DESC);

      CREATE TABLE IF NOT EXISTS testflight_failure_episodes (
        episode_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        failure_code TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
        closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS testflight_failure_episodes_active
        ON testflight_failure_episodes (closed_at, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS testflight_release_confirmations (
        scope_key TEXT NOT NULL,
        build_version TEXT NOT NULL,
        installed_at TEXT,
        smoke_at TEXT,
        PRIMARY KEY (scope_key, build_version)
      );
    `);
    this.secureFiles();
  }

  recordResult(result: RecordedTestFlightDistributionResult, at = new Date().toISOString()): void {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE testflight_failure_episodes SET closed_at = ? WHERE closed_at IS NULL
      `).run(at);
      this.database.prepare(`
        INSERT INTO testflight_delivery_runs
          (run_id, status, build_id, build_version, failure_code, checked_at, notification_key)
        VALUES (?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        randomUUID(),
        result.status,
        'buildId' in result ? result.buildId : null,
        'version' in result ? result.version : null,
        at,
      );
      this.prune();
    });
    this.secureFiles();
  }

  recordFailure(error: unknown, at = new Date().toISOString()): { notificationQueued: boolean; failureCode: string } {
    const failureCode = classifyTestFlightFailure(error);
    const fingerprint = failureCode;
    let notificationQueued = false;
    this.transaction(() => {
      const active = this.database.prepare(`
        SELECT episode_id, fingerprint, failure_code
        FROM testflight_failure_episodes
        WHERE closed_at IS NULL
        ORDER BY opened_at DESC
        LIMIT 1
      `).get() as unknown as EpisodeRow | undefined;
      let notificationKey: string | null = null;
      if (active?.fingerprint === fingerprint) {
        this.database.prepare(`
          UPDATE testflight_failure_episodes
          SET last_seen_at = ?, occurrence_count = occurrence_count + 1
          WHERE episode_id = ?
        `).run(at, active.episode_id);
      } else {
        this.database.prepare(`
          UPDATE testflight_failure_episodes SET closed_at = ? WHERE closed_at IS NULL
        `).run(at);
        const episodeId = randomUUID();
        notificationKey = `testflight:${episodeId}`;
        this.database.prepare(`
          INSERT INTO testflight_failure_episodes
            (episode_id, fingerprint, failure_code, opened_at, last_seen_at, occurrence_count, closed_at)
          VALUES (?, ?, ?, ?, ?, 1, NULL)
        `).run(episodeId, fingerprint, failureCode, at, at);
        notificationQueued = true;
      }
      this.database.prepare(`
        INSERT INTO testflight_delivery_runs
          (run_id, status, build_id, build_version, failure_code, checked_at, notification_key)
        VALUES (?, 'failed', NULL, NULL, ?, ?, ?)
      `).run(randomUUID(), failureCode, at, notificationKey);
      this.prune();
    });
    this.secureFiles();
    return { notificationQueued, failureCode };
  }

  dashboard(limit = 30, scopeKey = 'local-owner'): TestFlightDeliveryDashboard {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT run_id, status, build_version, failure_code, checked_at, notification_key
      FROM testflight_delivery_runs
      ORDER BY checked_at DESC
      LIMIT ?
    `).all(boundedLimit) as unknown as RunRow[];
    const active = this.database.prepare(`
      SELECT episode_id, fingerprint, failure_code
      FROM testflight_failure_episodes
      WHERE closed_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1
    `).get() as unknown as EpisodeRow | undefined;
    const latestBuild = this.database.prepare(`
      SELECT build_version
      FROM testflight_delivery_runs
      WHERE build_version IS NOT NULL
      ORDER BY checked_at DESC
      LIMIT 1
    `).get() as unknown as { build_version: string } | undefined;
    const deliveryExists = this.tableExists('push_delivery_state');
    const history = rows.map(row => Object.freeze({
      id: row.run_id,
      status: row.status,
      buildVersion: row.build_version,
      checkedAt: row.checked_at,
      failureCode: row.failure_code,
      notificationStatus: this.notificationStatus(row, deliveryExists),
    }));
    const latest = rows[0];
    const condition: TestFlightDeliveryCondition = active
      ? 'attention'
      : !latest || latest.status === 'no-valid-build' ? 'waiting' : 'healthy';
    const buildVersion = latestBuild?.build_version ?? null;
    const confirmation = buildVersion ? this.database.prepare(`
      SELECT installed_at, smoke_at FROM testflight_release_confirmations
      WHERE scope_key = ? AND build_version = ?
    `).get(scopeKey, buildVersion) as unknown as { installed_at: string | null; smoke_at: string | null } | undefined : undefined;
    const distribution = buildVersion ? rows.find(row => row.build_version === buildVersion
      && (row.status === 'distributed' || row.status === 'already-current')) : undefined;
    const releaseCompletedAt = distribution?.checked_at ?? null;
    const release = Object.freeze({
      platform: 'ios' as const,
      buildVersion,
      gates: Object.freeze([
        releaseGate('build', Boolean(buildVersion), releaseCompletedAt),
        releaseGate('archive', Boolean(buildVersion), releaseCompletedAt),
        releaseGate('upload', Boolean(buildVersion), releaseCompletedAt),
        releaseGate('processing', Boolean(buildVersion), releaseCompletedAt),
        releaseGate('assignment', Boolean(distribution), releaseCompletedAt, active ? 'attention' : 'pending'),
        releaseGate('install', Boolean(confirmation?.installed_at), confirmation?.installed_at ?? null),
        releaseGate('smoke', Boolean(confirmation?.smoke_at), confirmation?.smoke_at ?? null),
      ]),
    });
    return Object.freeze({
      condition,
      latestBuildVersion: latestBuild?.build_version ?? null,
      lastCheckedAt: latest?.checked_at ?? null,
      activeFailureCode: active?.failure_code ?? null,
      history: Object.freeze(history),
      release,
    });
  }

  confirmGate(
    scopeKey: string,
    buildVersion: string,
    gate: 'install' | 'smoke',
    at = new Date().toISOString(),
  ): TestFlightDeliveryDashboard {
    const build = this.database.prepare(`
      SELECT 1 AS found FROM testflight_delivery_runs
      WHERE build_version = ? AND status IN ('distributed','already-current') LIMIT 1
    `).get(buildVersion);
    if (!build) throw new Error('TESTFLIGHT_BUILD_NOT_DISTRIBUTED');
    const previous = this.database.prepare(`
      SELECT installed_at FROM testflight_release_confirmations
      WHERE scope_key = ? AND build_version = ?
    `).get(scopeKey, buildVersion) as unknown as { installed_at: string | null } | undefined;
    if (gate === 'smoke' && !previous?.installed_at) throw new Error('TESTFLIGHT_INSTALL_REQUIRED');
    this.database.prepare(`
      INSERT INTO testflight_release_confirmations (scope_key, build_version, installed_at, smoke_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key, build_version) DO UPDATE SET
        installed_at = COALESCE(excluded.installed_at, installed_at),
        smoke_at = COALESCE(excluded.smoke_at, smoke_at)
    `).run(scopeKey, buildVersion, gate === 'install' ? at : previous?.installed_at ?? null, gate === 'smoke' ? at : null);
    this.secureFiles();
    return this.dashboard(30, scopeKey);
  }

  close(): void {
    this.secureFiles();
    this.database.close();
  }

  private notificationStatus(row: RunRow, deliveryExists: boolean): TestFlightNotificationStatus {
    if (row.status !== 'failed') return 'not-needed';
    if (!row.notification_key) return 'suppressed';
    if (!deliveryExists) return 'pending';
    const sent = this.database.prepare(`
      SELECT 1 AS found FROM push_delivery_state
      WHERE initiative_id = ? AND delivered_at IS NOT NULL
      LIMIT 1
    `).get(row.notification_key);
    return sent ? 'sent' : 'pending';
  }

  private prune(): void {
    this.database.prepare(`
      DELETE FROM testflight_delivery_runs
      WHERE run_id IN (
        SELECT run_id FROM testflight_delivery_runs
        ORDER BY checked_at DESC
        LIMIT -1 OFFSET ?
      )
    `).run(MAXIMUM_HISTORY_ROWS);
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(name));
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }
}

function releaseGate(
  key: TestFlightReleaseGateKey,
  completed: boolean,
  completedAt: string | null,
  incompleteStatus: TestFlightReleaseGateStatus = 'pending',
): TestFlightReleaseGate {
  return Object.freeze({ key, status: completed ? 'complete' : incompleteStatus, completedAt: completed ? completedAt : null });
}

export function classifyTestFlightFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const status = message.match(/APP_STORE_CONNECT_(\d{3})/u)?.[1];
  if (status === '401') return 'authentication';
  if (status === '403') return 'permission';
  if (status === '429') return 'rate-limit';
  if (status?.startsWith('5')) return 'app-store-connect';
  if (message.includes('SHANNON_ASC_')) return 'configuration';
  if (/timeout|network|fetch failed|ECONN|ENOTFOUND/iu.test(message)) return 'network';
  return 'unexpected';
}
