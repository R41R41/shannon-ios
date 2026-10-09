import { randomUUID } from 'node:crypto';
import { normalizeDisclosure, ownerSpoke } from '@shannon/cognition';
import { reconcileSleepOutcome } from '../../mind/sleep/sleepCommitmentReview.js';
import type { BackgroundJobPayload, BackgroundJobStore, ClaimedBackgroundJob, DailyUserMessage } from '../../mind/sleep/store/backgroundJobStore.js';
import type { SleepConsolidationOutcome } from '../../mind/sleep/sleepConsolidation.js';
import { parseBackgroundJobPayload, parseTurnPayload } from './sqliteStoreCodecs.js';
import type { SQLiteCompanionRepository } from './sqliteCompanionRepository.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';
import type { MemoryProposals } from '../../mind/memory/memoryPorts.js';

interface EventRow { event_id: string; scope_key: string; observed_at: string; payload_json: string; }
interface BackgroundJobRow { job_id: string; scope_key: string; payload_json: string; attempts: number; }

export class SQLiteBackgroundJobRepository implements BackgroundJobStore {
  constructor(
    private readonly context: SQLiteStoreContext,
    private readonly companion: SQLiteCompanionRepository,
    /** Syzygy ADR-0008 stage 3 (F5): the memory outbox of this connection, or null while it is switched off. */
    private readonly memory: () => MemoryProposals | null = () => null,
  ) {}

  enqueueTurnRefinement(
    scopeKey: string,
    experienceId: string,
    userMessage: string,
    observedAt: string,
    timeZone?: string,
  ): void {
    const payload: BackgroundJobPayload = { kind: 'turn-refinement', experienceId, userMessage, observedAt, ...(timeZone ? { timeZone } : {}) };
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
          observedAt: row.observed_at,
          ...(turn.timeZone ? { timeZone: turn.timeZone } : {}),
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

  claimNextBackgroundJob(workerId: string, nowIso: string, leaseUntilIso: string, excludedSleepScope?: string): ClaimedBackgroundJob | null {
    return this.context.transaction(() => {
      const bound = Boolean(this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fca_task_maintenance'").get());
      const exclusion = bound ? 'AND NOT EXISTS (SELECT 1 FROM fca_task_maintenance m WHERE m.scope_key=background_jobs.scope_key AND m.job_id=background_jobs.job_id)' : '';
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
              ${bound ? 'AND NOT EXISTS (SELECT 1 FROM fca_task_maintenance m WHERE m.scope_key=active.scope_key AND m.job_id=active.job_id)' : ''}
          )
        ${exclusion}
        AND NOT (job_kind='sleep-consolidation' AND scope_key=? AND attempts=0 AND status='pending')
        ORDER BY sequence ASC
        LIMIT 1
      `).get(nowIso, nowIso, nowIso, excludedSleepScope ?? '') as unknown as BackgroundJobRow | undefined;
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
      SELECT cm.content, cm.observed_at, cm.turn_id, e.payload_json
      FROM conversation_messages cm
      LEFT JOIN experience_events e ON e.event_id = cm.turn_id AND e.scope_key = cm.scope_key
      WHERE cm.scope_key = ? AND cm.role = 'user' AND cm.observed_at >= ? AND cm.observed_at < ?
      ORDER BY cm.sequence ASC
      LIMIT 200
    `).all(scopeKey, startAt, endAt) as unknown as Array<{ content: string; observed_at: string; turn_id: string; payload_json: string | null }>;
    // The sleep batch learns about the owner only from turns the owner spoke alone or as the verified author.
    return Object.freeze(rows.filter(row => ownerSpoke(normalizeDisclosure(row.payload_json ? parseTurnPayload(row.payload_json)?.disclosure : undefined)))
      .map(row => Object.freeze({ content: row.content, observedAt: row.observed_at, sourceExperienceId: row.turn_id })));
  }

  applySleepOutcome(
    job: ClaimedBackgroundJob,
    workerId: string,
    completedAt: string,
    outcome: SleepConsolidationOutcome,
    finishJob = true,
  ): void {
    const apply = () => {
      outcome = reconcileSleepOutcome(outcome, this.companion.snapshot(job.scopeKey), completedAt);
      const memory = this.memory();
      if (memory) {
        // ADR-0008 stage 3 (F5): what the sleep batch learned is proposed, in this transaction; the one writer applies it.
        const episodes = (item: { sourceExperienceId?: string }) => (item.sourceExperienceId ? [item.sourceExperienceId] : []);
        for (const fact of outcome.facts) memory.propose({ opId: `sleep:${job.id}:fact:${fact.id}`, scopeKey: job.scopeKey, kind: 'fact.upsert', origin: 'sleep',
          subjectKey: `fact:${fact.id}`, payload: { fact, source: 'sleep' }, episodeIds: episodes(fact), disclosure: fact.disclosure ?? null });
        for (const relationship of outcome.relationships) memory.propose({ opId: `sleep:${job.id}:relationship:${relationship.id}`, scopeKey: job.scopeKey,
          kind: 'relationship.upsert', origin: 'sleep', subjectKey: `relationship:${relationship.id}`, payload: { relationship, source: 'sleep' },
          episodeIds: episodes(relationship), disclosure: relationship.disclosure ?? null });
        for (const interest of outcome.interests) memory.propose({ opId: `sleep:${job.id}:interest:${interest}`.slice(0, 200), scopeKey: job.scopeKey,
          kind: 'interest.change', origin: 'sleep', subjectKey: `interest:${interest}`.slice(0, 240), payload: { interest, source: 'sleep',
            ...(outcome.interestEvidence ? { provenance: 'owner_explicit' } : {}) },
          ...(outcome.interestEvidence ? { episodeIds: outcome.interestEvidence.find(item => item.interest === interest)?.episodeIds ?? [] } : {}) });
        for (const [index, draft] of (outcome.selfInterestDrafts ?? []).entries()) memory.propose({ opId: `sleep:${job.id}:self-interest:${index}`, scopeKey: job.scopeKey,
          kind: 'self.interest.propose', origin: 'sleep', subjectKey: `self-interest:${draft.proposal.itemId ?? draft.proposal.title}`.slice(0, 240),
          payload: { ...draft.proposal, provenance: 'sleep_self' }, episodeIds: draft.proposal.evidenceRefs, disclosure: draft.proposal.disclosure });
        if (outcome.interestEvidence) memory.propose({ opId: `sleep:${job.id}:self-interest-night`, scopeKey: job.scopeKey,
          kind: 'self.interest.night', origin: 'sleep', subjectKey: 'self-interest-night', payload: {} });
      } else {
        for (const fact of outcome.facts) {
          this.companion.apply(job.scopeKey, { type: 'user-fact-upserted', fact, source: 'sleep' });
        }
        for (const relationship of outcome.relationships) {
          this.companion.apply(job.scopeKey, { type: 'relationship-upserted', relationship, source: 'sleep' });
        }
        for (const interest of outcome.interests) {
          this.companion.apply(job.scopeKey, { type: 'interest-observed', interest, source: 'sleep' });
        }
      }
      this.context.insertEvent(job.scopeKey, finishJob ? 'sleep.completed' : 'sleep.memory_consolidated', completedAt, {
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
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, day_key) DO UPDATE SET
          status = excluded.status, summary_json = excluded.summary_json, completed_at = excluded.completed_at
      `).run(job.id, job.scopeKey, dayKey, finishJob ? 'completed' : 'running', JSON.stringify(outcome.report), completedAt, finishJob ? completedAt : null);
      this.companion.writePersonalityProfile(job.scopeKey, this.companion.snapshot(job.scopeKey), completedAt);
      this.companion.writePromptProjection(job.scopeKey, this.companion.snapshot(job.scopeKey));
      if (finishJob) this.context.insertActivity(job.scopeKey, 'sleep', '睡眠バッチ', dayKey, completedAt, outcome.report);
    };
    if (finishJob) this.completeClaimedBackgroundJob(job, workerId, completedAt, apply);
    else this.context.transaction(() => { this.assertJobLease(job.id, workerId); apply(); });
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
