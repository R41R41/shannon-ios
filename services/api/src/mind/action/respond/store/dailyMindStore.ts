/** Today's focus she keeps, in SQLite (Syzygy ADR-0008 stage 3, S2: the SQLite part of `dailyMind.ts` and the rules it chooses with, moved unchanged into the respond action's store folder). */
import type { DailyMindFocus, DailyMindModel, DailyMindModelResult, DailyMindReader } from '../dailyMind.js';
import { DatabaseSync } from 'node:sqlite';
import type { WorldItem } from '../../../../integrations/world/store/worldStore.js';
import { groundedWorldOpening, isWorldFocusVisible, topicMatchesSource, worldVisibleInterests } from '../../../../integrations/world/worldInterestRelevance.js';
import { restoreCompanionState } from '@shannon/cognition';
import { isRepeatedWorldSignal, recentSignalCutoff, type RecentWorldSignal, sourceDiversityAdjustment } from '../../../../integrations/world/worldSignalQuality.js';
import { chmodSync, existsSync } from 'node:fs';

const DAILY_MIND_CANDIDATE_MAX_AGE_MILLISECONDS = 48 * 60 * 60_000;

export class SQLiteDailyMindStore implements DailyMindReader {
  private readonly database: DatabaseSync;

  constructor(private readonly path: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS daily_mind (
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        topic TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_item_id TEXT,
        source_title TEXT,
        source_url TEXT,
        opening_line TEXT,
        generation_mode TEXT NOT NULL CHECK (generation_mode IN ('local','model')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, day_key)
      );
      CREATE INDEX IF NOT EXISTS daily_mind_expiry ON daily_mind (expires_at);
    `);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.database.prepare('PRAGMA table_info(daily_mind)').all();
      if (!columns.some(column => column.name === 'grounding_version')) {
        this.database.exec('ALTER TABLE daily_mind ADD COLUMN grounding_version INTEGER NOT NULL DEFAULT 0');
      }
      this.database.exec('COMMIT');
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
    this.secureFiles();
  }

  async ensureForKnownScopes(
    candidates: readonly WorldItem[],
    model: DailyMindModel,
    at = this.now(),
    timeZone = 'Asia/Tokyo',
  ): Promise<ReadonlyMap<string, DailyMindFocus>> {
    const result = new Map<string, DailyMindFocus>();
    if (!this.tableExists('companion_states')) return result;
    const scopes = this.database.prepare(`
      SELECT scope_key, snapshot_json FROM companion_states ORDER BY scope_key
    `).all() as unknown as Array<{ scope_key: string; snapshot_json: string }>;

    for (const row of scopes) {
      const existing = this.currentFocus(row.scope_key, at, timeZone);
      if (existing) {
        result.set(row.scope_key, existing);
        continue;
      }
      const interests = parsedInterests(row.snapshot_json, row.scope_key, at);
      const candidate = selectCandidate(candidates, this.recentSignals(row.scope_key, at), interests, at);
      let generated: DailyMindModelResult | null = null;
      try {
        generated = await model.generate({ scopeKey: row.scope_key, recentInterests: interests, candidate });
      } catch {
        // Daily focus must remain available even when the optional model lane fails.
      }
      const local = localDay(at, timeZone);
      const matchedInterest = interests.find(interest => candidate && topicMatchesSource(interest, candidate.title, candidate.summary));
      const groundedTopic = candidate && topicMatchesSource(generated?.topic, candidate.title, candidate.summary)
        ? bounded(generated?.topic, 120) : null;
      const topic = groundedTopic ?? bounded(matchedInterest, 120) ?? bounded(candidate?.title, 120)
        ?? bounded(interests[0], 120) ?? '今日は静かに周りを見る';
      // Model prose is not evidence of a connection to a prior conversation.
      const reason = fallbackReason(matchedInterest ?? (candidate ? undefined : interests[0]), candidate);
      const openingLine = candidate && bounded(generated?.openingLine, 280)
        ? groundedWorldOpening(generated?.openingLine, candidate.title, matchedInterest ?? null) : null;
      const expiresAt = nextLocalDayBoundary(at, timeZone);
      this.database.prepare(`
        INSERT OR IGNORE INTO daily_mind
          (scope_key, day_key, topic, reason, source_item_id, source_title, source_url,
           opening_line, generation_mode, created_at, expires_at, grounding_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        row.scope_key, local.dayKey, topic, reason,
        candidate?.id ?? null, candidate?.sourceTitle ?? null, candidate?.url ?? null,
        openingLine ?? null, generated ? 'model' : 'local', at, expiresAt,
      );
      const inserted = this.currentFocus(row.scope_key, at, timeZone);
      if (inserted) result.set(row.scope_key, inserted);
    }

    this.database.prepare(`DELETE FROM daily_mind WHERE expires_at < ?`).run(
      new Date(Date.parse(at) - 14 * 86_400_000).toISOString(),
    );
    this.secureFiles();
    return result;
  }

  currentFocus(scopeKey: string, at = this.now(), timeZone = 'Asia/Tokyo'): DailyMindFocus | null {
    const dayKey = localDay(at, timeZone).dayKey;
    const row = this.database.prepare(`
      SELECT scope_key, day_key, topic, reason, source_item_id, source_title, source_url,
        opening_line, created_at, expires_at, grounding_version
      FROM daily_mind WHERE scope_key = ? AND day_key = ? AND expires_at > ? LIMIT 1
    `).get(scopeKey, dayKey, at) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    const storedState = this.tableExists('companion_states') ? this.database.prepare(
      'SELECT snapshot_json FROM companion_states WHERE scope_key = ?',
    ).get(scopeKey) as { snapshot_json: string } | undefined : undefined;
    const snapshot = restoreCompanionState(scopeKey, parseJson(storedState?.snapshot_json ?? '{}'), at);
    if (row.grounding_version !== 1 || !isWorldFocusVisible(snapshot, [row.topic, row.reason, row.opening_line].join('\n'))) {
      // Keep the day occupied: a rejected cached focus must not cause repeated
      // billable regeneration or escape through the initiative fallback lane.
      return Object.freeze({ scopeKey, dayKey, topic: '今日は静かに周りを見る',
        reason: '出典と記憶の設定を確認できない話題は、会話に持ち込まない。',
        createdAt: String(row.created_at), expiresAt: String(row.expires_at) });
    }
    return Object.freeze({
      scopeKey: String(row.scope_key),
      dayKey: String(row.day_key),
      topic: String(row.topic),
      reason: String(row.reason),
      ...(row.source_item_id ? { sourceItemId: String(row.source_item_id) } : {}),
      ...(row.source_title ? { sourceTitle: String(row.source_title) } : {}),
      ...(row.source_url ? { sourceURL: String(row.source_url) } : {}),
      ...(row.opening_line ? { openingLine: String(row.opening_line) } : {}),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    });
  }

  promptFor(scopeKey: string, at = this.now(), timeZone = 'Asia/Tokyo'): string {
    const focus = this.currentFocus(scopeKey, at, timeZone);
    if (!focus) return '';
    return [
      '[Today\'s Shannon focus]',
      `- topic: ${focus.topic}`,
      `- why it caught your attention: ${focus.reason}`,
      '- This is your current attention, not a fact about the user. Let it color curiosity without forcing the topic.',
    ].join('\n');
  }

  close(): void {
    this.secureFiles();
    this.database.close();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }

  private recentSignals(scopeKey: string, at: string): RecentWorldSignal[] {
    if (!this.tableExists('initiative_messages') || !this.tableExists('world_items')) return [];
    return (this.database.prepare(`
      SELECT COALESCE(wi.source_id, '') AS source_id, im.source_title,
        COALESCE(wi.title, '') AS title, im.source_url, im.created_at
      FROM initiative_messages im
      LEFT JOIN world_items wi ON wi.item_id = im.source_item_id
      WHERE im.scope_key = ? AND im.created_at >= ?
      ORDER BY im.created_at DESC LIMIT 12
    `).all(scopeKey, recentSignalCutoff(at)) as unknown as Array<Record<string, unknown>>).map(row => ({
      sourceId: String(row.source_id), sourceTitle: String(row.source_title), title: String(row.title),
      url: String(row.source_url), createdAt: String(row.created_at),
    }));
  }

  private secureFiles(): void {
    if (this.path === ':memory:') return;
    for (const candidate of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
  }
}

function parsedInterests(snapshotJson: string, scopeKey: string, at: string): string[] {
  try {
    return worldVisibleInterests(restoreCompanionState(scopeKey, JSON.parse(snapshotJson), at)).slice(0, 6);
  } catch { return []; }
}

function selectCandidate(
  candidates: readonly WorldItem[],
  recentSignals: readonly RecentWorldSignal[],
  interests: readonly string[],
  at: string,
): WorldItem | null {
  const cutoff = Date.parse(at) - DAILY_MIND_CANDIDATE_MAX_AGE_MILLISECONDS;
  const maximumPublishedAt = Date.parse(at) + 24 * 60 * 60_000;
  const ranked = candidates.filter(candidate => {
    const discoveredAt = Date.parse(candidate.discoveredAt);
    const publishedAt = candidate.publishedAt ? Date.parse(candidate.publishedAt) : discoveredAt;
    return Number.isFinite(discoveredAt) && discoveredAt >= cutoff
      && Number.isFinite(publishedAt) && publishedAt >= cutoff && publishedAt <= maximumPublishedAt;
  }).filter(candidate => !isRepeatedWorldSignal(candidate, recentSignals)).slice(0, 40).map((candidate, index) => {
    const matches = interests.filter(interest => topicMatchesSource(interest, candidate.title, candidate.summary)).length;
    // Source order is only a stable tie-breaker; it must not outweigh a recent-source rotation.
    return { candidate, matches, score: matches * 10 - index / 100 + sourceDiversityAdjustment(candidate, recentSignals) };
  }).filter(row => !interests.length || row.matches > 0).sort((left, right) => right.score - left.score);
  return ranked[0]?.candidate ?? null;
}

function fallbackReason(interest: string | undefined, candidate: WorldItem | null): string {
  if (interest && candidate) return `最近気になっている「${interest}」と、${candidate.sourceTitle}で見つけた話が重なったから。`;
  if (interest) return `現在の関心に「${interest}」が残っているから。`;
  if (candidate) return `${candidate.sourceTitle}で見つけて、もう少し考えてみたくなったから。`;
  return '急いで話題を作らず、今日の出来事を静かに見ていたいから。';
}

function localDay(at: string, timeZone: string): { dayKey: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '00';
  return { dayKey: `${value('year')}-${value('month')}-${value('day')}` };
}

function nextLocalDayBoundary(at: string, timeZone: string): string {
  const start = new Date(at);
  for (let minute = 1; minute <= 26 * 60; minute += 1) {
    const candidate = new Date(start.getTime() + minute * 60_000);
    if (localDay(candidate.toISOString(), timeZone).dayKey !== localDay(at, timeZone).dayKey) return candidate.toISOString();
  }
  return new Date(start.getTime() + 24 * 60 * 60_000).toISOString();
}

export function bounded(value: string | undefined, maximum: number): string | null {
  const cleaned = value?.replace(/\s+/gu, ' ').trim();
  return cleaned ? cleaned.slice(0, maximum) : null;
}

export function parseJson(value: string): unknown { try { return value ? JSON.parse(value) : {}; } catch { return {}; } }
