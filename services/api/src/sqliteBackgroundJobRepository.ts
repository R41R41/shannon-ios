import { randomUUID } from 'node:crypto';
import type { BackgroundJobPayload, BackgroundJobStore, ClaimedBackgroundJob, DailyUserMessage } from './backgroundJobStore.js';
import type { SleepConsolidationOutcome } from './sleepConsolidation.js';
import { parseBackgroundJobPayload, parseTurnPayload } from './sqliteStoreCodecs.js';
import type { SQLiteCompanionRepository } from './sqliteCompanionRepository.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';

interface EventRow { event_id: string; scope_key: string; observed_at: string; payload_json: string; }
interface BackgroundJobRow { job_id: string; scope_key: string; payload_json: string; attempts: number; }

export class SQLiteBackgroundJobRepository implements BackgroundJobStore {
  constructor(private readonly context: SQLiteStoreContext, private readonly companion: SQLiteCompanionRepository) {}

  enqueueTurnRefinement(
    scopeKey: string,
    experienceId: string,
    userMessage: string,
    observedAt: string,
  ): void {
    const payload: BackgroundJobPayload = { kind: 'turn-refinement', experienceId, userMessage };
    this.context.database.prepare(`
      INSERT OR IGNORE INTO background_jobs
        (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at)
      VALUES (?, ?, ?, 'turn-refinement', ?, 'pending', ?, 0, ?)
    `).run(randomUUID(), `turn:${experienceId}`, scopeKey, JSON.stringify(payload), observedAt, observedAt);
  }

  recoverUnqueuedTurnRefinements(nowIso: string): number {
    const rows = this.context.database.prepare(`
      SELECT event_id, scope_key, observed_at, payload_json
      FROM experience_events
      WHERE event_type = 'turn.completed'
        AND NOT EXISTS (
          SELECT 1 FROM background_jobs WHERE dedupe_key = 'turn:' || experience_events.event_id
        )
      ORDER BY sequence ASC
      LIMIT 500
    `).all() as unknown as EventRow[];
    let recovered = 0;
    this.context.transaction(() => {
      for (const row of rows) {
        const turn = parseTurnPayload(row.payload_json);
        if (!turn) continue;
        const payload: BackgroundJobPayload = {
          kind: 'turn-refinement',
          experienceId: row.event_id,
          userMessage: turn.userMessage,
        };
        const result = this.context.database.prepare(`
          INSERT OR IGNORE INTO background_jobs
            (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at)
          VALUES (?, ?, ?, 'turn-refinement', ?, 'pending', ?, 0, ?)
        `).run(
          randomUUID(),
          `turn:${row.event_id}`,
          row.scope_key,
          JSON.stringify(payload),
          nowIso,
          row.observed_at,
        );
        recovered += Number(result.changes);
      }
    });
    return recovered;
  }

  enqueueSleepConsolidations(dayKey: string, startAt: string, endAt: string, nowIso: string): number {
    const scopes = this.context.database.prepare(`
      SELECT DISTINCT scope_key
      FROM conversation_messages
      WHERE role = 'user' AND observed_at >= ? AND observed_at < ?
    `).all(startAt, endAt) as unknown as Array<{ scope_key: string }>;
    const insert = this.context.database.prepare(`
      INSERT OR IGNORE INTO background_jobs
        (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at)
      VALUES (?, ?, ?, 'sleep-consolidation', ?, 'pending', ?, 0, ?)
    `);
    let inserted = 0;
    this.context.transaction(() => {
      for (const row of scopes) {
        const payload: BackgroundJobPayload = { kind: 'sleep-consolidation', dayKey, startAt, endAt };
        const result = insert.run(
          randomUUID(),
          `sleep:${row.scope_key}:${dayKey}`,
          row.scope_key,
          JSON.stringify(payload),
          nowIso,
          nowIso,
        );
        inserted += Number(result.changes);
      }
    });
    return inserted;
  }

  claimNextBackgroundJob(workerId: string, nowIso: string, leaseUntilIso: string): ClaimedBackgroundJob | null {
    return this.context.transaction(() => {
      const row = this.context.database.prepare(`
        SELECT job_id, scope_key, payload_json, attempts
        FROM background_jobs
        WHERE ((status = 'pending' AND available_at <= ?)
           OR (status = 'leased' AND lease_until <= ?))
          AND NOT EXISTS (
            SELECT 1 FROM background_jobs AS active
            WHERE active.scope_key = background_jobs.scope_key
              AND active.status = 'leased'
              AND active.lease_until > ?
          )
        ORDER BY sequence ASC
        LIMIT 1
      `).get(nowIso, nowIso, nowIso) as unknown as BackgroundJobRow | undefined;
      if (!row) return null;
      const changed = this.context.database.prepare(`
        UPDATE background_jobs
        SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1
        WHERE job_id = ? AND ((status = 'pending' AND available_at <= ?) OR (status = 'leased' AND lease_until <= ?))
      `).run(workerId, leaseUntilIso, row.job_id, nowIso, nowIso);
      if (Number(changed.changes) !== 1) return null;
      return Object.freeze({
        id: row.job_id,
        scopeKey: row.scope_key,
        payload: parseBackgroundJobPayload(row.payload_json),
        attempts: Number(row.attempts) + 1,
      });
    });
  }

  completeClaimedBackgroundJob(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    operation: () => void,
  ): void {
    this.context.transaction(() => {
      this.assertJobLease(job.id, workerId);
      operation();
      this.markJobCompleted(job.id, workerId, completedAt);
    });
  }

  failClaimedBackgroundJob(
    job: ClaimedBackgroundJob,
    workerId: string,
    nowIso: string,
    errorCode: string,
  ): void {
    const permanent = job.attempts >= 5;
    const retryAt = new Date(Date.parse(nowIso) + Math.min(300, 2 ** job.attempts) * 1_000).toISOString();
    this.context.database.prepare(`
      UPDATE background_jobs
      SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
          completed_at = ?, last_error = ?
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(
      permanent ? 'failed' : 'pending',
      retryAt,
      permanent ? nowIso : null,
      errorCode.slice(0, 120),
      job.id,
      workerId,
    );
  }

  dailyUserMessages(scopeKey: string, startAt: string, endAt: string): readonly DailyUserMessage[] {
    const rows = this.context.database.prepare(`
      SELECT content, observed_at
      FROM conversation_messages
      WHERE scope_key = ? AND role = 'user' AND observed_at >= ? AND observed_at < ?
      ORDER BY sequence ASC
      LIMIT 200
    `).all(scopeKey, startAt, endAt) as unknown as Array<{ content: string; observed_at: string }>;
    return Object.freeze(rows.map(row => Object.freeze({ content: row.content, observedAt: row.observed_at })));
  }

  applySleepOutcome(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    outcome: SleepConsolidationOutcome,
  ): void {
    this.completeClaimedBackgroundJob(job, workerId, completedAt, () => {
      for (const fact of outcome.facts) {
        this.companion.apply(job.scopeKey, { type: 'user-fact-upserted', fact, source: 'sleep' });
      }
      for (const relationship of outcome.relationships) {
        this.companion.apply(job.scopeKey, { type: 'relationship-upserted', relationship, source: 'sleep' });
      }
      for (const interest of outcome.interests) {
        this.companion.apply(job.scopeKey, { type: 'interest-observed', interest, source: 'sleep' });
      }
      this.context.insertEvent(job.scopeKey, 'sleep.completed', completedAt, {
        dayKey: job.payload.kind === 'sleep-consolidation' ? job.payload.dayKey : null,
        appliedFactIds: outcome.facts.map(fact => fact.id),
        appliedRelationshipIds: outcome.relationships.map(relationship => relationship.id),
        appliedInterests: outcome.interests,
        ...outcome.report,
      });
      const dayKey = job.payload.kind === 'sleep-consolidation' ? job.payload.dayKey : completedAt.slice(0, 10);
      this.context.database.prepare(`
        INSERT INTO sleep_runs
          (sleep_run_id, scope_key, day_key, status, summary_json, started_at, completed_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?)
        ON CONFLICT(scope_key, day_key) DO UPDATE SET
          status = 'completed', summary_json = excluded.summary_json, completed_at = excluded.completed_at
      `).run(job.id, job.scopeKey, dayKey, JSON.stringify(outcome.report), completedAt, completedAt);
      this.companion.writePersonalityProfile(job.scopeKey, this.companion.snapshot(job.scopeKey), completedAt);
      this.companion.writePromptProjection(job.scopeKey, this.companion.snapshot(job.scopeKey));
      this.context.insertActivity(job.scopeKey, 'sleep', '睡眠バッチ', dayKey, completedAt, outcome.report);
    });
  }

  pendingBackgroundJobCount(): number {
    const row = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM background_jobs WHERE status IN ('pending', 'leased')
    `).get() as unknown as { count: number };
    return Number(row.count);
  }


  private assertJobLease(jobId: string, workerId: string): void {
    const row = this.context.database.prepare(`
      SELECT 1 AS held FROM background_jobs
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).get(jobId, workerId);
    if (!row) throw new Error('BACKGROUND_JOB_LEASE_LOST');
  }

  private markJobCompleted(jobId: string, workerId: string, completedAt: string): void {
    const changed = this.context.database.prepare(`
      UPDATE background_jobs
      SET status = 'completed', completed_at = ?, lease_owner = NULL, lease_until = NULL, last_error = NULL
      WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
    `).run(completedAt, jobId, workerId);
    if (Number(changed.changes) !== 1) throw new Error('BACKGROUND_JOB_LEASE_LOST');
  }


}
