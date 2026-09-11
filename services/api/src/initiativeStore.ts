import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { DailyMindFocus } from './dailyMind.js';

const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;
const USER_COOLDOWN_MILLISECONDS = 90 * 60_000;
const CANDIDATE_MAX_AGE_MILLISECONDS = 48 * 60 * 60_000;

export interface InitiativeMessage {
  id: string;
  threadId: string;
  content: string;
  expression: 'curious' | 'excited' | 'thinking';
  sourceTitle: string;
  sourceURL: string;
  createdAt: string;
  readAt?: string;
}

export interface InitiativeInbox {
  unreadMessages(scopeKey: string): readonly InitiativeMessage[];
  markAllRead(scopeKey: string, readAt?: string): number;
}

export type InitiativeLoopResult = Readonly<{
  considered: number;
  sent: number;
  stopped: 'quiet-hours' | 'no-owner' | 'today-is-enough' | 'recent-conversation' | 'nothing-worth-saying' | null;
}>;

export interface InitiativeEvaluationSummary {
  windowDays: number;
  runs: number;
  eligibleRuns: number;
  delivered: number;
  deliveryRate: number;
  candidatesConsidered: number;
  stopped: Readonly<Record<Exclude<InitiativeLoopResult['stopped'], null>, number>>;
}

export interface InitiativeEvaluationReader {
  initiativeEvaluation(windowDays?: number, at?: string): InitiativeEvaluationSummary;
}

interface CompanionStateShape {
  version?: number;
  interests?: unknown;
  temperament?: { initiative?: unknown };
  emotion?: { valence?: unknown; arousal?: unknown; openness?: unknown };
}

interface CandidateRow {
  item_id: string;
  source_title: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: string | null;
  discovered_at: string;
}

/**
 * The initiative loop is deliberately code-only. It decides whether Shannon
 * should speak, persists the result in the conversation, and never invokes an
 * LLM. This keeps browsing and spontaneous behavior outside the chat budget.
 */
export class SQLiteInitiativeStore implements InitiativeInbox {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
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
        stopped TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS initiative_loop_runs_occurred
        ON initiative_loop_runs (occurred_at DESC);
    `);
    this.secureFiles();
  }

  runOnce(
    at = this.now(),
    timeZone = 'Asia/Tokyo',
    dailyFocuses: ReadonlyMap<string, DailyMindFocus> = new Map(),
  ): InitiativeLoopResult {
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
    let lastStop: InitiativeLoopResult['stopped'] = null;
    for (const scope of scopes) {
      const dayKey = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
      if (this.sentOnDay(scope.scope_key, dayKey)) {
        lastStop = 'today-is-enough';
        continue;
      }
      if (this.hasRecentUserMessage(scope.scope_key, at)) {
        lastStop = 'recent-conversation';
        continue;
      }
      const state = parseState(scope.snapshot_json);
      const interest = firstInterest(state.interests);
      const dailyFocus = dailyFocuses.get(scope.scope_key) ?? null;
      if (dailyFocus && !dailyFocus.openingLine) {
        lastStop = 'nothing-worth-saying';
        continue;
      }
      const candidates = this.candidates(scope.scope_key, at);
      considered += candidates.length;
      const preferred = dailyFocus?.sourceItemId
        ? candidates.find(candidate => candidate.item_id === dailyFocus.sourceItemId)
        : undefined;
      if (dailyFocus?.sourceItemId && !preferred) {
        // A weather or otherwise excluded focus must never donate its wording or
        // explanation to an unrelated eligible source.
        lastStop = 'nothing-worth-saying';
        continue;
      }
      const selected = preferred
        ? { ...preferred, score: candidateScore(preferred, dailyFocus?.topic ?? interest, finite(state.temperament?.initiative, 0.25), at) }
        : selectCandidate(candidates, dailyFocus?.topic ?? interest, finite(state.temperament?.initiative, 0.25), at);
      if (!selected) {
        lastStop = 'nothing-worth-saying';
        continue;
      }
      this.persistMessage(scope.scope_key, state, selected, interest, dailyFocus, dayKey, at);
      sent += 1;
      lastStop = null;
    }
    this.secureFiles();
    return this.finish({ considered, sent, stopped: sent > 0 ? null : lastStop }, at);
  }

  initiativeEvaluation(windowDays = 30, at = this.now()): InitiativeEvaluationSummary {
    const days = Math.max(1, Math.min(90, Math.trunc(windowDays)));
    const cutoff = new Date(Date.parse(at) - days * 24 * 60 * 60_000).toISOString();
    const rows = this.database.prepare(`
      SELECT considered, sent, stopped FROM initiative_loop_runs
      WHERE occurred_at >= ? ORDER BY occurred_at DESC
    `).all(cutoff) as unknown as Array<{ considered: number; sent: number; stopped: string | null }>;
    const stopped = {
      'quiet-hours': 0, 'no-owner': 0, 'today-is-enough': 0,
      'recent-conversation': 0, 'nothing-worth-saying': 0,
    } satisfies Record<Exclude<InitiativeLoopResult['stopped'], null>, number>;
    for (const row of rows) if (row.stopped && row.stopped in stopped) stopped[row.stopped as keyof typeof stopped] += 1;
    const eligible = rows.filter(row => row.stopped !== 'quiet-hours' && row.stopped !== 'no-owner');
    const delivered = rows.reduce((sum, row) => sum + Number(row.sent), 0);
    return Object.freeze({
      windowDays: days,
      runs: rows.length,
      eligibleRuns: eligible.length,
      delivered,
      deliveryRate: eligible.length ? Math.round((delivered / eligible.length) * 10_000) / 10_000 : 0,
      candidatesConsidered: rows.reduce((sum, row) => sum + Number(row.considered), 0),
      stopped: Object.freeze(stopped),
    });
  }

  unreadMessages(scopeKey: string): readonly InitiativeMessage[] {
    const rows = this.database.prepare(`
      SELECT initiative_id, thread_id, content, expression, source_title, source_url, created_at, read_at
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
    })));
  }

  markAllRead(scopeKey: string, readAt = this.now()): number {
    return Number(this.database.prepare(`
      UPDATE initiative_messages SET read_at = ? WHERE scope_key = ? AND read_at IS NULL
    `).run(readAt, scopeKey).changes);
  }

  close(): void {
    this.secureFiles();
    this.database.close();
  }

  private finish(result: InitiativeLoopResult, at: string): InitiativeLoopResult {
    this.database.prepare(`
      INSERT INTO initiative_loop_runs (run_id, considered, sent, stopped, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), result.considered, result.sent, result.stopped, at);
    this.database.prepare(`DELETE FROM initiative_loop_runs WHERE occurred_at < ?`)
      .run(new Date(Date.parse(at) - 90 * 24 * 60 * 60_000).toISOString());
    this.secureFiles();
    return Object.freeze({ ...result });
  }

  private persistMessage(
    scopeKey: string,
    state: CompanionStateShape,
    candidate: CandidateRow & { score: number },
    interest: string | null,
    dailyFocus: DailyMindFocus | null,
    dayKey: string,
    createdAt: string,
  ): void {
    const initiativeId = randomUUID();
    const threadId = this.latestThread(scopeKey, createdAt);
    const expression: InitiativeMessage['expression'] = candidate.score >= 0.85 ? 'excited' : interest ? 'curious' : 'thinking';
    const reason = dailyFocus?.reason
      ?? (interest ? `今日の関心「${truncate(interest, 120)}」と近いから。` : 'シャノン自身が気になったから。');
    const content = dailyFocus?.openingLine
      ? `${dailyFocus.openingLine}\n\n${truncate(candidate.title, 180)}\n${candidate.url}`
      : interest
      ? `今日の関心の「${interest}」に近くて、これが少し気になった。\n\n${truncate(candidate.title, 180)}\n${candidate.url}`
      : `これ、少し気になった。\n\n${truncate(candidate.title, 180)}\n${candidate.url}`;
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
      dailyMindDayKey: dailyFocus?.dayKey ?? null,
      sourceAttribution: {
        title: truncate(candidate.source_title, 200),
        url: candidate.url,
        reason: truncate(reason, 500),
      },
    });

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
           content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        initiativeId, scopeKey, threadId, candidate.item_id, candidate.source_title,
        candidate.url, content, expression, dayKey, createdAt,
      );
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
      this.database.exec('COMMIT');
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
      SELECT wi.item_id, ws.title AS source_title, wi.title, wi.url, wi.summary,
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

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }
}

function selectCandidate(
  candidates: readonly CandidateRow[],
  interest: string | null,
  initiative: number,
  at: string,
): (CandidateRow & { score: number }) | null {
  const ranked = candidates.map(candidate => ({
    ...candidate,
    score: candidateScore(candidate, interest, initiative, at),
  })).sort((left, right) => right.score - left.score || right.discovered_at.localeCompare(left.discovered_at));
  return (ranked[0]?.score ?? 0) >= 0.56 ? ranked[0]! : null;
}

function candidateScore(candidate: CandidateRow, interest: string | null, initiative: number, at: string): number {
  const age = Math.max(0, Date.parse(at) - Date.parse(candidate.discovered_at));
  const freshness = Math.max(0, 1 - age / CANDIDATE_MAX_AGE_MILLISECONDS);
  const searchable = normalize(`${candidate.title} ${candidate.summary ?? ''}`);
  const tokens = interestTokens(interest);
  const matches = tokens.filter(token => searchable.includes(token)).length;
  const interestScore = tokens.length ? Math.min(1, matches / Math.min(tokens.length, 3)) : 0;
  const sourceScore = /arxiv|pubmed|hacker news|zenn|github/iu.test(candidate.source_title) ? 0.12 : 0.05;
  return round(0.34 + freshness * 0.12 + sourceScore + Math.min(1, Math.max(0, initiative)) * 0.08 + interestScore * 0.46);
}

function firstInterest(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const first = value.find(item => typeof item === 'string' && item.trim());
  return typeof first === 'string' ? first.trim().slice(0, 80) : null;
}

function interestTokens(value: string | null): string[] {
  if (!value) return [];
  const normalized = normalize(value);
  const split = normalized.split(/[\s、,・/]+/u).filter(token => token.length >= 2);
  return [...new Set([normalized, ...split])].slice(0, 8);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

function parseState(value: string): CompanionStateShape {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CompanionStateShape : {};
  } catch {
    return {};
  }
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function truncate(value: string, maximum: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
