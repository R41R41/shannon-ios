import { QUIET_END_HOUR, QUIET_START_HOUR, USER_COOLDOWN_MILLISECONDS } from '../../../contracts/initiativeTiming.js';
export { QUIET_END_HOUR, QUIET_START_HOUR, USER_COOLDOWN_MILLISECONDS } from '../../../contracts/initiativeTiming.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { restoreCompanionState } from '@shannon/cognition';
import type { DailyMindFocus } from '../../../mind/action/respond/dailyMind.js';
import { commitmentAwaitingTodaySlot, dueCommitmentCandidate, neutralCommitmentLine } from '../../../mind/action/respond/commitmentInitiative.js';
import { bodyLookIdOfSource } from '../../../contracts/bodyLookContract.js';
import { isRoomLookSource } from '../../../mind/perception/roomLookSource.js';
import { reachOutOfSource } from '../reachOutDelivery.js';
import { promisePassesHold, tellDuePromises } from './promiseNotices.js';
import type { ProactiveDeliveryGate } from '../../../mind/attention/attentionPorts.js';
import { evaluationSummary, firstWritten, initiativeIntent, secureDatabaseFiles, type InitiativeWrite } from '../initiativeIntent.js';
import { authoredWorldOpening, topicMatchesSource, worldVisibleInterests } from '../../../integrations/world/worldInterestRelevance.js';
import {
  intentInitiativeCandidateIsCurrent,
  intentInitiativeCandidates,
} from './initiativeIntentCandidates.js';

import {
  candidateScore,
  firstInterest,
  isRepeatedWorldSignal,
  localDateParts,
  pad,
  parseState,
  recentSignalCutoff,
  selectCandidate,
  signalCandidate,
  finite,
  truncate,
  type CandidateRow,
  type CompanionStateShape,
  type RecentWorldSignal,
} from '../../../mind/action/respond/initiativeSelection.js';

const CANDIDATE_MAX_AGE_MILLISECONDS = 48 * 60 * 60_000;

interface InitiativeCandidate extends CandidateRow {
  score: number;
  thread_id?: string;
}

export type {
  InitiativeEvaluationReader, InitiativeEvaluationSummary, InitiativeInbox, InitiativeLoopResult, InitiativeMessage,
} from './initiativeStoreTypes.js';
import type { InitiativeEvaluationSummary, InitiativeInbox, InitiativeLoopResult, InitiativeMessage } from './initiativeStoreTypes.js';

export class SQLiteInitiativeStore implements InitiativeInbox {
  private readonly database: DatabaseSync;
  /** Her lines for promises due now (owner 2026-10-14, `commitmentLine.ts`), by item id, for this run; else the neutral factual line. */
  private commitmentLines: ReadonlyMap<string, string> = new Map();

  // gate: Syzygy ADR-0008 stage 3, the proactive gate every message she starts passes where it is written; absent (switched off), as before.
  // promisesOnTime (`SHANNON_PROMISE_ON_TIME`): due promises are told by `deliverDuePromises`, not by `runOnce` (`promiseNotices.ts`).
  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString(), private readonly gate: ProactiveDeliveryGate | null = null,
    private readonly options: { promisesOnTime?: boolean } = {}) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS initiative_messages (
        initiative_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        content TEXT NOT NULL,
        expression TEXT NOT NULL CHECK (expression IN ('curious','excited','thinking')),
        day_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        UNIQUE (scope_key, source_item_id),
        UNIQUE (scope_key, day_key)
      );
      CREATE INDEX IF NOT EXISTS initiative_messages_unread
        ON initiative_messages (scope_key, read_at, created_at DESC);
      CREATE TABLE IF NOT EXISTS initiative_loop_runs (
        run_id TEXT PRIMARY KEY,
        considered INTEGER NOT NULL CHECK (considered >= 0),
        sent INTEGER NOT NULL CHECK (sent >= 0),
        repeated_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (repeated_suppressed >= 0),
        stopped TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS initiative_loop_runs_occurred
        ON initiative_loop_runs (occurred_at DESC);
    `);
    this.migrateInitiativeLoopRuns();
    this.secureFiles();
  }

  runOnce(
    at = this.now(),
    timeZone = 'Asia/Tokyo',
    dailyFocuses: ReadonlyMap<string, DailyMindFocus> = new Map(),
    /** `SHANNON_MORNING_BRIEF` (`wiring/dailyReadWiring.ts`): today's brief by scope, handed in only in the owner's morning. */
    morningBriefs: ReadonlyMap<string, InitiativeCandidate> = new Map(),
    commitmentLines: ReadonlyMap<string, string> = new Map(),
  ): InitiativeLoopResult {
    this.commitmentLines = commitmentLines;
    const local = localDateParts(new Date(at), timeZone);
    if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
      return this.finish({ considered: 0, sent: 0, stopped: 'quiet-hours' }, at);
    }
    if (!this.tableExists('companion_states') || !this.tableExists('conversation_messages')) {
      return this.finish({ considered: 0, sent: 0, stopped: 'no-owner' }, at);
    }
    const scopes = this.database.prepare(`SELECT scope_key, snapshot_json FROM companion_states ORDER BY scope_key`).all() as unknown as Array<{
      scope_key: string;
      snapshot_json: string;
    }>;
    if (!scopes.length) return this.finish({ considered: 0, sent: 0, stopped: 'no-owner' }, at);

    let considered = 0;
    let sent = 0;
    let repeatedSuppressed = 0;
    let lastStop: InitiativeLoopResult['stopped'] = null;
    for (const scope of scopes) {
      const dayKey = `${local.year}-${pad(local.month)}-${pad(local.day)}`, briefKey = `${dayKey}:morning-brief`;
      const state = parseState(scope.snapshot_json);
      const delivered = (itemId: string) => Boolean(this.database
        .prepare('SELECT 1 FROM initiative_messages WHERE scope_key = ? AND source_item_id = ?').get(scope.scope_key, itemId));
      // Syzygy ADR-0008 stage 3 (review M4): a candidate the gate held today is passed over, and a hold moves on to the next one.
      const fresh = <T extends CandidateRow>(candidate: T) => !this.gate?.heldToday(scope.scope_key, 'initiative', initiativeIntent(candidate, at), at);
      // SHANNON_MORNING_BRIEF, every morning as asked (2026-10-13): its own daily key, so neither the day's slot nor a due promise blocks it.
      const brief = morningBriefs.get(scope.scope_key), briefOpen = brief !== undefined && !delivered(brief.item_id) && fresh(brief);
      if (briefOpen) considered += 1;
      if (briefOpen && this.persistMessage(scope.scope_key, state, brief, null, null, briefKey, at) === 'sent') sent += 1;
      if (this.sentOnDay(scope.scope_key, dayKey)) {
        lastStop = 'today-is-enough';
        continue;
      }
      if (this.hasRecentUserMessage(scope.scope_key, at)) {
        lastStop = 'recent-conversation';
        continue;
      }
      // With promises told on time (`deliverDuePromises`), none of them waits for, or keeps, the day's slot of a topic.
      const promises = this.options.promisesOnTime ? [] : dueCommitmentCandidate(scope.scope_key, JSON.parse(scope.snapshot_json), at);
      considered += promises.length;
      const open = promises.filter(candidate => !delivered(candidate.item_id));
      if (open.length) {
        if (firstWritten(open.filter(fresh), candidate => this.persistMessage(scope.scope_key, state, candidate, null, null, dayKey, at)) === 'sent') sent += 1;
        continue;
      }
      // A promise due later today keeps the day's only slot; a spontaneous topic can wait.
      if (!this.options.promisesOnTime && commitmentAwaitingTodaySlot(scope.scope_key, JSON.parse(scope.snapshot_json), at, timeZone, delivered)) {
        lastStop = 'reserved-for-commitment';
        continue;
      }
      if (this.sentOnDay(scope.scope_key, briefKey)) { // The brief stands for the day's spontaneous topic.
        lastStop = 'today-is-enough';
        continue;
      }
      const intentCandidates = intentInitiativeCandidates(this.database, scope.scope_key, at);
      considered += intentCandidates.length;
      const openIntents = intentCandidates.filter(candidate => !delivered(candidate.item_id));
      if (openIntents.length) {
        if (firstWritten(openIntents.filter(fresh), candidate => this.persistMessage(scope.scope_key, state, candidate, null, null, dayKey, at)) === 'sent') sent += 1;
        continue;
      }
      const interests = worldVisibleInterests(restoreCompanionState(scope.scope_key, JSON.parse(scope.snapshot_json), at));
      const interest = firstInterest(interests);
      const dailyFocus = dailyFocuses.get(scope.scope_key) ?? null;
      if (dailyFocus && (!dailyFocus.openingLine || !dailyFocus.sourceItemId)) {
        lastStop = 'nothing-worth-saying';
        continue;
      }
      const candidates = this.candidates(scope.scope_key, at);
      considered += candidates.length;
      const recentSignals = this.recentSignals(scope.scope_key, at);
      const distinctCandidates = candidates.filter(candidate => !isRepeatedWorldSignal(signalCandidate(candidate), recentSignals));
      repeatedSuppressed += candidates.length - distinctCandidates.length;
      let pool = distinctCandidates.filter(fresh);
      // A topic like one of her recent messages is damped: its score × (1 − eff) (owner answer 2).
      const damping = (candidate: CandidateRow) => this.gate?.topicReuse(scope.scope_key, initiativeIntent(candidate, at).text, at) ?? 0;
      const preferred = dailyFocus?.sourceItemId
        ? pool.find(candidate => candidate.item_id === dailyFocus.sourceItemId)
        : undefined;
      if (dailyFocus?.sourceItemId && !preferred) {
        // A weather or otherwise excluded focus must never donate its wording or
        // explanation to an unrelated eligible source.
        lastStop = 'nothing-worth-saying';
        continue;
      }
      let written: InitiativeWrite | 'none' = 'none';
      for (let tries = 0; tries < 5 && written === 'none'; tries += 1) {
        const selected = preferred
          ? { ...preferred, score: candidateScore(preferred, dailyFocus?.topic ?? interest, finite(state.temperament?.initiative, 0.25), at) }
          : selectCandidate(pool, recentSignals, dailyFocus?.topic ?? interest, finite(state.temperament?.initiative, 0.25), at, damping);
        if (!selected) break;
        const matchedInterest = interests.find(value => topicMatchesSource(value, selected.title, selected.summary ?? '')) ?? null;
        if (dailyFocus && interest && !matchedInterest) break;
        written = firstWritten([selected], candidate => this.persistMessage(scope.scope_key, state, candidate, matchedInterest, dailyFocus, dayKey, at));
        if (preferred) break;
        pool = pool.filter(candidate => candidate.item_id !== selected.item_id);
      }
      if (written === 'sent') sent += 1;
      lastStop = written === 'none' || written.startsWith('held:') ? 'nothing-worth-saying' : null;
    }
    this.secureFiles();
    return this.finish({ considered, sent, stopped: sent > 0 ? null : lastStop }, at, repeatedSuppressed);
  }

  /** Due promises, told at their time (`SHANNON_PROMISE_ON_TIME`, `promiseNotices.ts`): her line when written and trusted, else the neutral one. */
  deliverDuePromises(at = this.now(), timeZone = 'Asia/Tokyo', commitmentLines: ReadonlyMap<string, string> = new Map()): { due: number; sent: number } {
    this.commitmentLines = commitmentLines;
    const told = tellDuePromises(this.database, at, timeZone, (scopeKey, snapshot, candidate, dayKey) =>
      this.persistMessage(scopeKey, parseState(snapshot), candidate, null, null, dayKey, at, true));
    if (told.sent > 0) this.secureFiles();
    return told;
  }

  initiativeEvaluation(windowDays = 30, at = this.now()): InitiativeEvaluationSummary {
    const days = Math.max(1, Math.min(90, Math.trunc(windowDays)));
    const cutoff = new Date(Date.parse(at) - days * 24 * 60 * 60_000).toISOString();
    const rows = this.database.prepare(`
      SELECT considered, sent, repeated_suppressed, stopped FROM initiative_loop_runs
      WHERE occurred_at >= ? ORDER BY occurred_at DESC
    `).all(cutoff) as unknown as Array<{
      considered: number; sent: number; repeated_suppressed: number; stopped: string | null;
    }>;
    const sourceRows = this.database.prepare(`
      SELECT source_title, COUNT(*) AS count
      FROM initiative_messages
      WHERE created_at >= ?
      GROUP BY source_title
      ORDER BY count DESC, source_title ASC
      LIMIT 8
    `).all(cutoff) as unknown as Array<{ source_title: string; count: number }>;
    return evaluationSummary(days, rows, sourceRows);
  }

  unreadMessages(scopeKey: string): readonly InitiativeMessage[] {
    const rows = this.database.prepare(`
      SELECT initiative_id, thread_id, content, expression, source_title, source_url, created_at, read_at, source_item_id
      FROM initiative_messages
      WHERE scope_key = ? AND read_at IS NULL
      ORDER BY created_at ASC LIMIT 20
    `).all(scopeKey) as unknown as Array<Record<string, unknown>>;
    return Object.freeze(rows.map(row => Object.freeze({
      id: String(row.initiative_id),
      threadId: String(row.thread_id),
      content: String(row.content),
      expression: String(row.expression) as InitiativeMessage['expression'],
      sourceTitle: String(row.source_title),
      sourceURL: String(row.source_url),
      createdAt: String(row.created_at),
      ...(row.read_at ? { readAt: String(row.read_at) } : {}),
      ...(bodyLookIdOfSource(row.source_item_id) ? { bodyLookId: bodyLookIdOfSource(row.source_item_id)! } : {}), ...reachOutOfSource(row.source_item_id),
      roomLook: isRoomLookSource(row.source_item_id),
    })));
  }

  markRead(scopeKey: string, threadId?: string, readAt = this.now()): number {
    const result = threadId
      ? this.database.prepare(`
          UPDATE initiative_messages SET read_at = ?
          WHERE scope_key = ? AND thread_id = ? AND read_at IS NULL
        `).run(readAt, scopeKey, threadId)
      : this.database.prepare(`
          UPDATE initiative_messages SET read_at = ? WHERE scope_key = ? AND read_at IS NULL
        `).run(readAt, scopeKey);
    return Number(result.changes);
  }

  close(): void {
    this.secureFiles();
    this.database.close();
  }

  private finish(result: InitiativeLoopResult, at: string, repeatedSuppressed = 0): InitiativeLoopResult {
    this.database.prepare(`
      INSERT INTO initiative_loop_runs (run_id, considered, sent, repeated_suppressed, stopped, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), result.considered, result.sent, repeatedSuppressed, result.stopped, at);
    this.database.prepare(`DELETE FROM initiative_loop_runs WHERE occurred_at < ?`)
      .run(new Date(Date.parse(at) - 90 * 24 * 60 * 60_000).toISOString());
    this.secureFiles();
    return Object.freeze({ ...result });
  }

  private migrateInitiativeLoopRuns(): void {
    const columns = this.database.prepare(`PRAGMA table_info(initiative_loop_runs)`).all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'repeated_suppressed')) {
      this.database.exec(`
        ALTER TABLE initiative_loop_runs
        ADD COLUMN repeated_suppressed INTEGER NOT NULL DEFAULT 0 CHECK (repeated_suppressed >= 0)
      `);
    }
  }

  private persistMessage(
    scopeKey: string,
    state: CompanionStateShape,
    candidate: InitiativeCandidate,
    interest: string | null,
    dailyFocus: DailyMindFocus | null,
    dayKey: string,
    createdAt: string,
    /** A due promise told at its time (`deliverDuePromises`): only the gate's own error and a repeat hold it. */
    promiseOnTime = false,
  ): InitiativeWrite {
    const initiativeId = randomUUID();
    const threadId = candidate.thread_id ?? this.latestThread(scopeKey, createdAt);
    const expression: InitiativeMessage['expression'] = candidate.score >= 0.85 ? 'excited' : interest ? 'curious' : 'thinking';
    const reason = interest ? `今日の関心「${truncate(interest, 120)}」と近いからです。` : 'ボクが気になったからです。';
    const spoken = dailyFocus?.openingLine ? authoredWorldOpening(dailyFocus.openingLine, candidate.title, interest) : null;
    const content = candidate.source_id === 'commitment'
      ? this.commitmentLines.get(candidate.item_id) ?? neutralCommitmentLine({ title: candidate.title, when: null, others: false })
      : candidate.source_id === 'morning-brief' ? (candidate.summary ?? candidate.title).slice(0, 2_000)
      : candidate.source_id === 'intent' ? truncate(candidate.summary ?? `「${candidate.title}」`, 500)
      // A topic of the world in her own words or none (owner 2026-10-14): the daily mind's grounded line, else its title and address only.
      : `${spoken ? `${spoken}\n\n` : ''}${truncate(candidate.title, 180)}\n${candidate.url}`;
    const metadata = JSON.stringify({
      stateVersion: Math.max(0, Math.trunc(finite(state.version, 0))),
      messageEmotion: {
        valence: finite(state.emotion?.valence, 0.18),
        arousal: finite(state.emotion?.arousal, 0.28),
        openness: finite(state.emotion?.openness, 0.66),
        expression,
      },
      initiativeId,
      sourceItemId: candidate.item_id,
      dailyMindDayKey: dailyFocus?.dayKey ?? null, authoredOpening: spoken !== null,
      ...(candidate.source_id === 'intent' || candidate.source_id === 'commitment' || candidate.source_id === 'morning-brief' ? {} : {
        sourceAttribution: {
          title: truncate(candidate.source_title, 200),
          url: candidate.url,
          reason: truncate(reason, 500),
        },
      }),
    });

    const intent = initiativeIntent(candidate, createdAt); // Syzygy ADR-0008 stage 3: the proactive gate, where it would be written.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (candidate.source_id === 'commitment') {
        const fresh = this.database.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key = ?').get(scopeKey) as { snapshot_json: string } | undefined;
        if (!fresh || !dueCommitmentCandidate(scopeKey, JSON.parse(fresh.snapshot_json), createdAt).some(item => item.item_id === candidate.item_id)) {
          this.database.exec('ROLLBACK');
          return 'skipped';
        }
      }
      if (candidate.source_id === 'intent'
        && !intentInitiativeCandidateIsCurrent(this.database, scopeKey, candidate.item_id)) {
        this.database.exec('ROLLBACK');
        return 'skipped';
      }
      // Inside the transaction, after the day's slot (review): the limit refuses before the gate, and two writers cannot both pass.
      if (this.sentOnDay(scopeKey, dayKey)) { this.database.exec('ROLLBACK'); return 'skipped'; }
      const decision = this.gate?.decide(scopeKey, intent, createdAt, this.database);
      if (decision?.verdict === 'hold' && !(promiseOnTime && promisePassesHold(decision.code))) {
        this.database.exec('ROLLBACK'); this.gate!.hold(scopeKey, intent, decision, createdAt); return `held:${decision.code}`;
      }
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
           content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        initiativeId, scopeKey, threadId, candidate.item_id, candidate.source_title,
        candidate.url, content, expression, dayKey, createdAt,
      );
      if (!inserted.changes) { this.database.exec('ROLLBACK'); return 'skipped'; }
      this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(randomUUID(), scopeKey, threadId, `initiative:${initiativeId}`, content, createdAt, metadata);
      this.database.prepare(`
        UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?
      `).run(createdAt, scopeKey, threadId);
      this.database.prepare(`
        INSERT INTO activity_events
          (activity_id, scope_key, activity_type, title, detail, occurred_at, metadata_json)
        VALUES (?, ?, 'initiative', 'シャノンから話しかけた', ?, ?, ?)
      `).run(randomUUID(), scopeKey, truncate(candidate.title, 240), createdAt, JSON.stringify({
        initiativeId, sourceItemId: candidate.item_id, score: candidate.score,
        dailyMindDayKey: dailyFocus?.dayKey ?? null,
      }));
      if (this.gate) {
        // Noted with the message, in its transaction (review M3); if it cannot be, the message is not written.
        try { this.gate.deliveredWithin(scopeKey, intent, createdAt, this.database); } catch {
          this.database.exec('ROLLBACK');
          this.gate.hold(scopeKey, intent, { verdict: 'hold', code: 'gate_error', retryAt: null }, createdAt);
          return 'held:gate_error';
        }
      }
      this.database.exec('COMMIT');
      return 'sent';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private latestThread(scopeKey: string, createdAt: string): string {
    const existing = this.database.prepare(`
      SELECT thread_id FROM conversation_threads
      WHERE scope_key = ? AND archived_at IS NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(scopeKey) as unknown as { thread_id: string } | undefined;
    if (existing) return existing.thread_id;
    const threadId = randomUUID();
    this.database.prepare(`
      INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at)
      VALUES (?, ?, 'シャノンから', ?, ?)
    `).run(threadId, scopeKey, createdAt, createdAt);
    return threadId;
  }

  private candidates(scopeKey: string, at: string): CandidateRow[] {
    const cutoff = new Date(Date.parse(at) - CANDIDATE_MAX_AGE_MILLISECONDS).toISOString();
    return this.database.prepare(`
      SELECT wi.item_id, wi.source_id, ws.title AS source_title, wi.title, wi.url, wi.summary,
        wi.published_at, wi.discovered_at
      FROM world_items wi
      JOIN world_sources ws ON ws.source_id = wi.source_id
      WHERE wi.discovered_at >= ?
        AND (
          wi.published_at IS NULL
          OR (
            julianday(wi.published_at) IS NOT NULL
            AND julianday(wi.published_at) >= julianday(?)
            AND julianday(wi.published_at) <= julianday(?) + 1
          )
        )
        AND ws.kind <> 'weather'
        AND NOT EXISTS (
          SELECT 1 FROM initiative_messages im
          WHERE im.scope_key = ? AND im.source_item_id = wi.item_id
        )
      ORDER BY wi.discovered_at DESC LIMIT 80
    `).all(cutoff, cutoff, at, scopeKey) as unknown as CandidateRow[];
  }

  private recentSignals(scopeKey: string, at: string): RecentWorldSignal[] {
    return (this.database.prepare(`
      SELECT COALESCE(wi.source_id, '') AS source_id, im.source_title,
        COALESCE(wi.title, '') AS title, im.source_url, im.created_at
      FROM initiative_messages im
      LEFT JOIN world_items wi ON wi.item_id = im.source_item_id
      WHERE im.scope_key = ? AND im.created_at >= ?
      ORDER BY im.created_at DESC LIMIT 12
    `).all(scopeKey, recentSignalCutoff(at)) as unknown as Array<Record<string, unknown>>).map(row => ({
      sourceId: String(row.source_id),
      sourceTitle: String(row.source_title),
      title: String(row.title),
      url: String(row.source_url),
      createdAt: String(row.created_at),
    }));
  }

  private hasRecentUserMessage(scopeKey: string, at: string): boolean {
    const cutoff = new Date(Date.parse(at) - USER_COOLDOWN_MILLISECONDS).toISOString();
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM conversation_messages
      WHERE scope_key = ? AND role = 'user' AND observed_at >= ? LIMIT 1
    `).get(scopeKey, cutoff));
  }

  private sentOnDay(scopeKey: string, dayKey: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND day_key = ? LIMIT 1
    `).get(scopeKey, dayKey));
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }

  private secureFiles(): void { secureDatabaseFiles(this.path); }
}
