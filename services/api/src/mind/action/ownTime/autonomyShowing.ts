import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SHANNON_OWNER_NAME } from '@shannon/cognition';
import { commitmentAwaitingTodaySlot, dueCommitmentCandidate } from '../respond/commitmentInitiative.js';
import { localDateParts, pad } from '../respond/initiativeSelection.js';
import { QUIET_END_HOUR, QUIET_START_HOUR, USER_COOLDOWN_MILLISECONDS } from '../../../surfaces/outreach/store/initiativeStore.js';

/**
 * Telling the owner that a piece is ready to read, through the same initiative path
 * as everything else Shannon says unprompted.
 *
 * It uses the day's one initiative slot (the unique day key of `initiative_messages`),
 * so it never adds a second message to a day, and it keeps the same quiet hours and the
 * same cooldown after the owner's last message. A promise that is due, or becomes due
 * later today, keeps the slot. A version of a piece is announced at most once.
 * The message is the only thing the activity loop ever sends, and only to the owner.
 */
export type ShowingOutcome =
  | 'sent' | 'already-told' | 'quiet-hours' | 'recent-conversation' | 'today-is-enough' | 'reserved-for-commitment' | 'unavailable' | 'held';

export interface ShowablePiece {
  id: string;
  title: string;
  version: number;
  /** An earlier version was already shown. */
  revised: boolean;
}

export interface StudyShowing {
  /** Whether she may message the owner at this moment at all (quiet hours, cooldown, the day's slot). */
  mayMessageNow(scopeKey: string, at: string): ShowingOutcome | 'ok';
  tell(scopeKey: string, piece: ShowablePiece, at: string): ShowingOutcome;
  /** Whether the owner wrote or spoke since the given instant. A yes or no; no content leaves. */
  ownerActiveSince(scopeKey: string, since: string): boolean;
  /** When the owner first wrote or spoke after the given instant, in any Talk, or null. A timestamp; no content leaves. */
  ownerFirstActiveAfter?(scopeKey: string, after: string): string | null;
}

/** Sentence presented as Shannon speaking (です・ます, ボク, ライ氏). */
export function studyShowingMessage(piece: ShowablePiece): string {
  const title = piece.title.replace(/\s+/gu, ' ').trim().slice(0, 80);
  return piece.revised
    ? `${SHANNON_OWNER_NAME}、「${title}」を直しました。前の稿より、ボクは好きなものになったと思います。もう一度読んでもらえると嬉しいです。`
    : `${SHANNON_OWNER_NAME}、短い物語を書きました。「${title}」です。読んだら、どう思ったか聞かせてください。ボクは、けっこう気に入っています。`;
}

/**
 * The proactive gate as the showing desk is handed it (Syzygy ADR-0008 stage 3 review M1): `tell` is the point `share`, its subject
 * the piece. Declared here by its shape, so her own time imports nothing of attention; wiring hands the gate (`autonomyWorker.ts`).
 * The budget request (`autonomyAnnouncer.ts`) is a system notice, not a message she starts, and stays outside the gate.
 */
export interface ShowingGate {
  decide(scopeKey: string, intent: ShowingIntent, at: string, connection: DatabaseSync): { verdict: 'deliver' } | { verdict: 'hold'; code: string; retryAt: string | null };
  hold(scopeKey: string, intent: ShowingIntent, decision: { verdict: 'hold'; code: string; retryAt: string | null }, at: string): unknown;
  deliveredWithin(scopeKey: string, intent: ShowingIntent, at: string, connection: DatabaseSync): void;
}
export interface ShowingIntent { point: 'share'; reason: 'share'; subject: string; arisenAt: string; text: string }

export class DisabledStudyShowing implements StudyShowing {
  mayMessageNow(): ShowingOutcome { return 'unavailable'; }
  tell(): ShowingOutcome { return 'unavailable'; }
  ownerActiveSince(): boolean { return false; }
  ownerFirstActiveAfter(): string | null { return null; }
}

export class SQLiteStudyShowing implements StudyShowing {
  private readonly database: DatabaseSync;

  constructor(path: string, private readonly timeZone = 'Asia/Tokyo', private readonly gate: ShowingGate | null = null) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }

  mayMessageNow(scopeKey: string, at: string): ShowingOutcome | 'ok' {
    // The conversation and initiative tables belong to other stores; without them there is nowhere to speak.
    for (const table of ['initiative_messages', 'conversation_messages', 'conversation_threads']) {
      if (!this.tableExists(table)) return 'unavailable';
    }
    const local = localDateParts(new Date(at), this.timeZone);
    if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) return 'quiet-hours';
    if (this.database.prepare(`
      SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND day_key = ? LIMIT 1
    `).get(scopeKey, this.dayKey(at))) return 'today-is-enough';
    if (this.ownerActiveSince(scopeKey, new Date(Date.parse(at) - USER_COOLDOWN_MILLISECONDS).toISOString())) return 'recent-conversation';
    return this.promiseNeedsSlot(scopeKey, at) ? 'reserved-for-commitment' : 'ok';
  }

  tell(scopeKey: string, piece: ShowablePiece, at: string): ShowingOutcome {
    const sourceItemId = `study:${piece.id}:v${piece.version}`;
    if (this.tableExists('initiative_messages') && this.database.prepare(`
      SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND source_item_id = ?
    `).get(scopeKey, sourceItemId)) return 'already-told';
    const allowed = this.mayMessageNow(scopeKey, at);
    if (allowed !== 'ok') return allowed;
    const content = studyShowingMessage(piece);
    const initiativeId = randomUUID();
    // Syzygy ADR-0008 stage 3 (review M1): the proactive gate, inside the transaction after the day's slot; what it is about is the piece.
    const intent: ShowingIntent = { point: 'share', reason: 'share', subject: `piece:${piece.id}`, arisenAt: at, text: piece.title };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // The unique day key is the one-message-per-day limit; a message another loop sent meanwhile wins.
      if (this.database.prepare('SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND day_key = ?').get(scopeKey, this.dayKey(at))) {
        this.database.exec('ROLLBACK');
        return 'today-is-enough';
      }
      const decision = this.gate?.decide(scopeKey, intent, at, this.database);
      if (decision?.verdict === 'hold') {
        this.database.exec('ROLLBACK');
        this.gate?.hold(scopeKey, intent, decision, at);
        return 'held';
      }
      const threadId = this.latestThread(scopeKey, at);
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO initiative_messages
          (initiative_id, scope_key, thread_id, source_item_id, source_title, source_url,
           content, expression, day_key, created_at)
        VALUES (?, ?, ?, ?, 'シャノンの書斎', '', ?, 'excited', ?, ?)
      `).run(initiativeId, scopeKey, threadId, sourceItemId, content, this.dayKey(at), at);
      if (!inserted.changes) {
        this.database.exec('ROLLBACK');
        return 'today-is-enough';
      }
      this.database.prepare(`
        INSERT INTO conversation_messages
          (message_id, scope_key, thread_id, turn_id, ordinal, role, content, observed_at, metadata_json)
        VALUES (?, ?, ?, ?, 1, 'assistant', ?, ?, ?)
      `).run(randomUUID(), scopeKey, threadId, `initiative:${initiativeId}`, content, at, JSON.stringify({
        initiativeId, sourceItemId, studyPiece: { id: piece.id, title: piece.title.slice(0, 80) },
      }));
      this.database.prepare(`
        UPDATE conversation_threads SET updated_at = ? WHERE scope_key = ? AND thread_id = ?
      `).run(at, scopeKey, threadId);
      if (this.gate) {
        try {
          this.gate.deliveredWithin(scopeKey, intent, at, this.database);
        } catch {
          // Fail closed: the message goes with a delivery the gate could not note.
          this.database.exec('ROLLBACK');
          this.gate.hold(scopeKey, intent, { verdict: 'hold', code: 'gate_error', retryAt: null }, at);
          return 'held';
        }
      }
      this.database.exec('COMMIT');
      return 'sent';
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  ownerActiveSince(scopeKey: string, since: string): boolean {
    if (!this.tableExists('conversation_messages')) return false;
    return Boolean(this.database.prepare(`
      SELECT 1 AS found FROM conversation_messages WHERE scope_key = ? AND role = 'user' AND observed_at >= ? LIMIT 1
    `).get(scopeKey, since));
  }

  ownerFirstActiveAfter(scopeKey: string, after: string): string | null {
    if (!this.tableExists('conversation_messages')) return null;
    const row = this.database.prepare(`
      SELECT MIN(observed_at) AS first_at FROM conversation_messages WHERE scope_key = ? AND role = 'user' AND observed_at > ?
    `).get(scopeKey, after) as unknown as { first_at: string | null } | undefined;
    return row?.first_at ?? null;
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  /** Only a yes or no leaves this function: nothing of the owner's promises reaches the activity loop. */
  private promiseNeedsSlot(scopeKey: string, at: string): boolean {
    if (!this.tableExists('companion_states')) return false;
    const row = this.database.prepare(`
      SELECT snapshot_json FROM companion_states WHERE scope_key = ?
    `).get(scopeKey) as unknown as { snapshot_json: string } | undefined;
    if (!row) return false;
    try {
      const snapshot: unknown = JSON.parse(row.snapshot_json);
      const delivered = (itemId: string) => Boolean(this.database.prepare(`
        SELECT 1 AS found FROM initiative_messages WHERE scope_key = ? AND source_item_id = ?
      `).get(scopeKey, itemId));
      return dueCommitmentCandidate(scopeKey, snapshot, at).some(candidate => !delivered(candidate.item_id))
        || commitmentAwaitingTodaySlot(scopeKey, snapshot, at, this.timeZone, delivered);
    } catch {
      // A state that cannot be read cannot be shown to need the slot; the initiative loop decides as before.
      return false;
    }
  }

  private dayKey(at: string): string {
    const local = localDateParts(new Date(at), this.timeZone);
    return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
  }

  private latestThread(scopeKey: string, at: string): string {
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
    `).run(threadId, scopeKey, at, at);
    return threadId;
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
  }
}
