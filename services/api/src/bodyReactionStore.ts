import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isShannonEmotionKind, type ShannonEmotionKind, type ShannonTouchKind } from '@shannon/cognition';
import type { BodyAudience, BodyTouchGesture, BodyTouchReflex, BodyTouchSide } from './bodyContract.js';
import { BODY_REACTION_LIMITS, type BodyReactionAnswer } from './bodyReactionContract.js';
import { BODY_TOUCH_MIXED, isBodySurface, isBodyTouchRegion, type BodySurface, type BodyTouchPart, type BodyTouchRegion } from './bodyTouchWords.js';
import { addColumnOnce } from './bodyStore.js';
import { BODY_TOUCH_STANCES, isBodyTouchStance, isReflexPart, type BodyTouchStance } from './bodyTouchReflex.js';
import { secureDatabaseFiles } from './sqliteStoreContext.js';

/**
 * What a touch leaves behind, in three additive tables:
 * - `body_touches`: one row per touch id, so a touch that arrives twice (a reaction request
 *   while it is going on, then the finished event with the same id) counts once.
 * - `body_touch_bursts`: touches of one kind that follow each other, as one memory. Its id
 *   is the id of the experience she recalls it by.
 * - `body_reactions`: the answer given for a reaction id, and her line while it waits for
 *   the owner's spoken answer. A line that is not answered never enters a conversation.
 * - `body_touch_outcomes` (Syzygy ADR-0005 stage 1b, the result table): for each touch she was asked about, how she
 *   took it (`stance`), the feeling she chose and whether she spoke, without her words. The part, side, gesture and
 *   reflex are on the touch's own row.
 * Closed vocabulary, numbers, identifiers and her own words only: nothing from a microphone.
 */
export interface TouchRecord {
  id: string;
  type: ShannonTouchKind;
  audience: BodyAudience;
  occurredAt: string;
  durationMs?: number;
  strength?: number;
  /** Which part was touched, and on which surface her body was; absent when the body did not say. */
  region?: BodyTouchRegion;
  surface?: BodySurface;
  /** Touch vocabulary 2, as the body sent it, kept on the touch's own row. `part` decides whether only the reflex moves her (stage 1b). */
  part?: BodyTouchPart;
  side?: BodyTouchSide;
  gesture?: BodyTouchGesture;
  reflex?: BodyTouchReflex;
}

/** The columns of touch vocabulary 2 on `body_touches` (added 2026-10-06). */
const TOUCH_DETAIL_COLUMNS = ['part', 'side', 'gesture', 'reflex'] as const;

export interface StoredTouchBurst {
  /** Also the id of the experience (`experience_events.event_id`). */
  id: string;
  type: ShannonTouchKind;
  startedAt: string;
  lastAt: string;
  count: number;
  totalDurationMs: number;
  /** True when any touch of it happened while someone other than the owner could see or cause it. */
  others: boolean;
  /** What she said during it, oldest first. */
  said: readonly string[];
  /** Of those, the lines said while other people could hear. */
  saidOpen: readonly string[];
  /** The part and the surface while every touch of the burst named the same one; otherwise absent. */
  region?: BodyTouchRegion;
  surface?: BodySurface;
  /** True when its touches named different parts (or some named none): told apart from a burst that never named one. */
  mixedRegion?: boolean;
  mixedSurface?: boolean;
  /** True when a touch of it named a part where her body flinches first (stage 1b): its wording then reads no favour. */
  reflex?: boolean;
}

export interface TouchReceipt {
  /** False when this id was already counted: only its duration and strength were brought up to date. */
  fresh: boolean;
  burst: StoredTouchBurst;
}

export type ReactionLinkState = 'none' | 'pending' | 'linked' | 'stored' | 'dropped';

/**
 * One row of the result table: what came of a touch she was asked about. `stance` and `feeling` are null when she gave
 * no judgement (the deadline passed, no model, a late request, a touch in the old shape that was not asked for one):
 * only the reflex then moved her, and nothing is filled in for her. Closed vocabulary only; never her words.
 */
export interface TouchOutcome {
  touchId: string;
  burstId: string;
  audience: BodyAudience;
  stance: BodyTouchStance | null;
  feeling: ShannonEmotionKind | null;
  said: boolean;
  decidedAt: string;
}

export interface StoredReaction {
  id: string;
  deviceId: string;
  contentHash: string;
  /** `working` until the answer is decided. */
  status: 'working' | 'said' | 'quiet';
  answer: BodyReactionAnswer | null;
  line: string | null;
  threadId: string | null;
  audience: BodyAudience;
  createdAt: string;
  saidAt: string | null;
  linkState: ReactionLinkState;
}

/** Her pending line as a voice turn receives it. */
export interface ReactionLine {
  id: string;
  text: string;
  threadId: string | null;
  audience: BodyAudience;
  saidAt: string;
  messageId: string;
}

interface BurstRow {
  burst_id: string; touch_type: string; started_at: string; last_at: string; touch_count: number; total_duration_ms: number; others: number; said_json: string;
  region: string | null; surface: string | null; reflex: number | null;
}
interface ReactionRow {
  reaction_id: string; device_id: string; content_hash: string; status: string; answer_json: string | null; line_text: string | null; message_id: string | null;
  thread_id: string | null; audience: string; created_at: string; said_at: string | null; listen_until: string | null; link_state: string; linked_until: string | null;
}

/** A line she said and whether other people could hear it. */
type SaidLine = [text: string, others: 0 | 1];
const saidLines = (json: string): SaidLine[] => (JSON.parse(json) as unknown[])
  .flatMap((item): SaidLine[] => Array.isArray(item) && typeof item[0] === 'string' ? [[item[0], item[1] === 1 ? 1 : 0]] : []);

const burstOf = (row: BurstRow): StoredTouchBurst => {
  const lines = saidLines(row.said_json);
  return {
    id: row.burst_id, type: row.touch_type as ShannonTouchKind, startedAt: row.started_at, lastAt: row.last_at,
    count: Number(row.touch_count), totalDurationMs: Number(row.total_duration_ms), others: Number(row.others) === 1,
    said: lines.map(line => line[0]), saidOpen: lines.filter(line => line[1] === 1).map(line => line[0]),
    ...(isBodyTouchRegion(row.region) ? { region: row.region } : {}), ...(isBodySurface(row.surface) ? { surface: row.surface } : {}),
    ...(row.region === BODY_TOUCH_MIXED ? { mixedRegion: true } : {}), ...(row.surface === BODY_TOUCH_MIXED ? { mixedSurface: true } : {}),
    ...(Number(row.reflex) === 1 ? { reflex: true } : {}),
  };
};

export class SQLiteBodyReactionStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS body_touches (
        scope_key TEXT NOT NULL,
        touch_id TEXT NOT NULL,
        touch_type TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('owner', 'others')),
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
        strength REAL CHECK (strength IS NULL OR (strength >= 0 AND strength <= 1)),
        burst_id TEXT NOT NULL,
        PRIMARY KEY (scope_key, touch_id)
      );
      CREATE INDEX IF NOT EXISTS body_touches_scope_received ON body_touches (scope_key, received_at);
      CREATE TABLE IF NOT EXISTS body_touch_bursts (
        scope_key TEXT NOT NULL,
        burst_id TEXT NOT NULL,
        touch_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        touch_count INTEGER NOT NULL CHECK (touch_count >= 1),
        total_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_duration_ms >= 0),
        others INTEGER NOT NULL DEFAULT 0 CHECK (others IN (0, 1)),
        said_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (scope_key, burst_id)
      );
      CREATE INDEX IF NOT EXISTS body_touch_bursts_scope_last ON body_touch_bursts (scope_key, last_at DESC);
      CREATE TABLE IF NOT EXISTS body_reactions (
        scope_key TEXT NOT NULL,
        reaction_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('working', 'said', 'quiet')),
        answer_json TEXT,
        line_text TEXT,
        message_id TEXT,
        thread_id TEXT,
        audience TEXT NOT NULL CHECK (audience IN ('owner', 'others')),
        created_at TEXT NOT NULL,
        said_at TEXT,
        listen_until TEXT,
        link_state TEXT NOT NULL DEFAULT 'none' CHECK (link_state IN ('none', 'pending', 'linked', 'stored', 'dropped')),
        linked_until TEXT,
        PRIMARY KEY (scope_key, reaction_id)
      );
      CREATE INDEX IF NOT EXISTS body_reactions_scope_created ON body_reactions (scope_key, created_at);
      CREATE TABLE IF NOT EXISTS body_touch_outcomes (
        scope_key TEXT NOT NULL,
        touch_id TEXT NOT NULL,
        burst_id TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('owner', 'others')),
        stance TEXT CHECK (stance IS NULL OR stance IN (${BODY_TOUCH_STANCES.map(stance => `'${stance}'`).join(', ')})),
        feeling TEXT,
        said INTEGER NOT NULL DEFAULT 0 CHECK (said IN (0, 1)),
        decided_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, touch_id)
      );
      CREATE INDEX IF NOT EXISTS body_touch_outcomes_scope_decided ON body_touch_outcomes (scope_key, decided_at);
    `);
    // Added 2026-10-03: the touched part and the surface, on a touch and on its burst.
    for (const table of ['body_touches', 'body_touch_bursts']) {
      for (const column of ['region', 'surface']) addColumnOnce(this.database, table, column, 'TEXT');
    }
    // Added 2026-10-06 (touch vocabulary 2): the finer part, the side, the gesture and the body's reflex, on a touch only.
    for (const column of TOUCH_DETAIL_COLUMNS) addColumnOnce(this.database, 'body_touches', column, 'TEXT');
    // Added 2026-10-06 (stage 1b): 1 once a touch of the burst named a part where her body flinches first; empty otherwise.
    addColumnOnce(this.database, 'body_touch_bursts', 'reflex', 'INTEGER');
    secureDatabaseFiles(path);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Counts a touch once. A new id joins the burst of its kind that is still going on (and that
   * `usable` accepts: a memory the owner had her forget is not continued), or starts one. A known
   * id only raises the stored duration, and the burst's total by the difference.
   */
  recordTouch(scopeKey: string, touch: TouchRecord, receivedAt: string, usable: (burstId: string) => boolean = () => true): TouchReceipt {
    return this.transaction(() => {
      const known = this.database.prepare('SELECT duration_ms, burst_id FROM body_touches WHERE scope_key = ? AND touch_id = ?')
        .get(scopeKey, touch.id) as unknown as { duration_ms: number; burst_id: string } | undefined;
      const duration = touch.durationMs ?? 0;
      const knownBurst = known ? this.burst(scopeKey, known.burst_id) : null;
      // A touch whose burst is gone (pruned) is counted anew.
      if (known && !knownBurst) this.database.prepare('DELETE FROM body_touches WHERE scope_key = ? AND touch_id = ?').run(scopeKey, touch.id);
      if (known && knownBurst) {
        const longer = Math.max(0, duration - Number(known.duration_ms));
        if (longer > 0 || touch.strength !== undefined) {
          this.database.prepare(`
            UPDATE body_touches SET duration_ms = MAX(duration_ms, ?), strength = COALESCE(?, strength) WHERE scope_key = ? AND touch_id = ?
          `).run(duration, touch.strength ?? null, scopeKey, touch.id);
        }
        // The finished touch may say what its first message did not (the reflex, most often): a column still empty takes it.
        const detail = TOUCH_DETAIL_COLUMNS.filter(column => touch[column] !== undefined);
        if (detail.length) {
          this.database.prepare(`UPDATE body_touches SET ${detail.map(column => `${column} = COALESCE(${column}, ?)`).join(', ')} WHERE scope_key = ? AND touch_id = ?`)
            .run(...detail.map(column => touch[column]!), scopeKey, touch.id);
        }
        if (longer > 0 || touch.audience === 'others') {
          this.database.prepare('UPDATE body_touch_bursts SET total_duration_ms = total_duration_ms + ?, others = MAX(others, ?) WHERE scope_key = ? AND burst_id = ?')
            .run(longer, touch.audience === 'others' ? 1 : 0, scopeKey, known.burst_id);
        }
        // A part the first message did not name, filled in now, still keeps the burst's wording free of favour.
        if (isReflexPart(touch.part)) this.database.prepare('UPDATE body_touch_bursts SET reflex = 1 WHERE scope_key = ? AND burst_id = ?').run(scopeKey, known.burst_id);
        return { fresh: false, burst: this.burst(scopeKey, known.burst_id)! };
      }
      const time = Date.parse(touch.occurredAt);
      const open = (this.database.prepare(`
        SELECT * FROM body_touch_bursts WHERE scope_key = ? AND touch_type = ? AND last_at >= ? AND started_at >= ? AND started_at <= ?
        ORDER BY last_at DESC LIMIT 4
      `).all(scopeKey, touch.type, new Date(time - BODY_REACTION_LIMITS.burstGapMilliseconds).toISOString(),
        new Date(time - BODY_REACTION_LIMITS.burstSpanMilliseconds).toISOString(), touch.occurredAt) as unknown as BurstRow[])
        .find(row => usable(row.burst_id));
      const burstId = open?.burst_id ?? randomUUID();
      const reflex = isReflexPart(touch.part);
      if (open) {
        this.database.prepare(`
          UPDATE body_touch_bursts SET touch_count = touch_count + 1, total_duration_ms = total_duration_ms + ?,
            last_at = MAX(last_at, ?), others = MAX(others, ?),
            region = CASE WHEN region IS ? THEN region ELSE ? END, surface = CASE WHEN surface IS ? THEN surface ELSE ? END,
            reflex = CASE WHEN ? = 1 THEN 1 ELSE reflex END
          WHERE scope_key = ? AND burst_id = ?
        `).run(duration, touch.occurredAt, touch.audience === 'others' ? 1 : 0,
          touch.region ?? null, BODY_TOUCH_MIXED, touch.surface ?? null, BODY_TOUCH_MIXED, reflex ? 1 : 0, scopeKey, burstId);
      } else {
        this.database.prepare(`
          INSERT INTO body_touch_bursts (scope_key, burst_id, touch_type, started_at, last_at, touch_count, total_duration_ms, others, region, surface, reflex)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(scopeKey, burstId, touch.type, touch.occurredAt, touch.occurredAt, duration, touch.audience === 'others' ? 1 : 0,
          touch.region ?? null, touch.surface ?? null, reflex ? 1 : null);
      }
      this.database.prepare(`
        INSERT INTO body_touches (scope_key, touch_id, touch_type, audience, occurred_at, received_at, duration_ms, strength, burst_id, region, surface,
          part, side, gesture, reflex)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(scopeKey, touch.id, touch.type, touch.audience, touch.occurredAt, receivedAt, duration, touch.strength ?? null, burstId,
        touch.region ?? null, touch.surface ?? null, touch.part ?? null, touch.side ?? null, touch.gesture ?? null, touch.reflex ?? null);
      return { fresh: true, burst: this.burst(scopeKey, burstId)! };
    });
  }

  burst(scopeKey: string, burstId: string): StoredTouchBurst | null {
    const row = this.database.prepare('SELECT * FROM body_touch_bursts WHERE scope_key = ? AND burst_id = ?').get(scopeKey, burstId) as unknown as BurstRow | undefined;
    return row ? burstOf(row) : null;
  }

  /** What touch vocabulary 2 stored for a touch id: only the fields that were sent; null for an id never counted. */
  touchDetail(scopeKey: string, touchId: string): Pick<TouchRecord, typeof TOUCH_DETAIL_COLUMNS[number]> | null {
    const row = this.database.prepare(`SELECT ${TOUCH_DETAIL_COLUMNS.join(', ')} FROM body_touches WHERE scope_key = ? AND touch_id = ?`)
      .get(scopeKey, touchId) as unknown as Record<typeof TOUCH_DETAIL_COLUMNS[number], string | null> | undefined;
    if (!row) return null;
    return Object.fromEntries(TOUCH_DETAIL_COLUMNS.flatMap(column => row[column] !== null ? [[column, row[column]]] : [])) as Pick<TouchRecord, typeof TOUCH_DETAIL_COLUMNS[number]>;
  }

  /** The burst a touch id was counted in. */
  burstOfTouch(scopeKey: string, touchId: string): StoredTouchBurst | null {
    const row = this.database.prepare('SELECT burst_id FROM body_touches WHERE scope_key = ? AND touch_id = ?').get(scopeKey, touchId) as unknown as { burst_id: string } | undefined;
    return row ? this.burst(scopeKey, row.burst_id) : null;
  }

  /** Bursts that were still going on at or after `since`, newest first. */
  recentBursts(scopeKey: string, since: string, until: string, limit: number): readonly StoredTouchBurst[] {
    const rows = this.database.prepare(`
      SELECT * FROM body_touch_bursts WHERE scope_key = ? AND last_at >= ? AND started_at <= ? ORDER BY last_at DESC LIMIT ?
    `).all(scopeKey, since, until, Math.max(1, Math.min(50, Math.trunc(limit)))) as unknown as BurstRow[];
    return rows.map(burstOf);
  }

  /** Adds a line she said to the memory of the burst, keeping the newest few. */
  addSaid(scopeKey: string, burstId: string, text: string, others: boolean): StoredTouchBurst | null {
    return this.transaction(() => {
      const row = this.database.prepare('SELECT said_json FROM body_touch_bursts WHERE scope_key = ? AND burst_id = ?').get(scopeKey, burstId) as unknown as { said_json: string } | undefined;
      if (!row) return null;
      const said: SaidLine[] = [...saidLines(row.said_json), [text, others ? 1 : 0] as SaidLine].slice(-BODY_REACTION_LIMITS.memorySaidLines);
      this.database.prepare('UPDATE body_touch_bursts SET said_json = ? WHERE scope_key = ? AND burst_id = ?').run(JSON.stringify(said), scopeKey, burstId);
      return this.burst(scopeKey, burstId);
    });
  }

  /** Keeps what came of a touch she was asked about, once: the first outcome of a touch id stands. */
  recordOutcome(scopeKey: string, outcome: TouchOutcome): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO body_touch_outcomes (scope_key, touch_id, burst_id, audience, stance, feeling, said, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scopeKey, outcome.touchId, outcome.burstId, outcome.audience, outcome.stance, outcome.feeling, outcome.said ? 1 : 0, outcome.decidedAt);
  }

  /** The outcome kept for a touch id, or null. */
  outcome(scopeKey: string, touchId: string): TouchOutcome | null {
    const row = this.database.prepare('SELECT * FROM body_touch_outcomes WHERE scope_key = ? AND touch_id = ?').get(scopeKey, touchId) as unknown as {
      touch_id: string; burst_id: string; audience: string; stance: string | null; feeling: string | null; said: number; decided_at: string;
    } | undefined;
    if (!row) return null;
    return {
      touchId: row.touch_id, burstId: row.burst_id, audience: row.audience as BodyAudience,
      stance: isBodyTouchStance(row.stance) ? row.stance : null, feeling: row.feeling !== null && isShannonEmotionKind(row.feeling) ? row.feeling : null,
      said: Number(row.said) === 1, decidedAt: row.decided_at,
    };
  }

  /** Starts a reaction once. `existing` is what an earlier request with this id left. */
  begin(scopeKey: string, reactionId: string, deviceId: string, contentHash: string, audience: BodyAudience, at: string): { started: true } | { started: false; existing: StoredReaction } {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO body_reactions (scope_key, reaction_id, device_id, content_hash, status, audience, created_at) VALUES (?, ?, ?, ?, 'working', ?, ?)
    `).run(scopeKey, reactionId, deviceId, contentHash, audience, at);
    return Number(inserted.changes) > 0 ? { started: true } : { started: false, existing: this.reaction(scopeKey, reactionId)! };
  }

  reaction(scopeKey: string, reactionId: string): StoredReaction | null {
    const row = this.database.prepare('SELECT * FROM body_reactions WHERE scope_key = ? AND reaction_id = ?').get(scopeKey, reactionId) as unknown as ReactionRow | undefined;
    if (!row) return null;
    return {
      id: row.reaction_id, deviceId: row.device_id, contentHash: row.content_hash, status: row.status as StoredReaction['status'],
      answer: row.answer_json ? JSON.parse(row.answer_json) as BodyReactionAnswer : null, line: row.line_text, threadId: row.thread_id,
      audience: row.audience as BodyAudience, createdAt: row.created_at, saidAt: row.said_at, linkState: row.link_state as ReactionLinkState,
    };
  }

  /**
   * Decides a reaction once: only a row still `working` takes the answer. With a line, the line
   * waits (`pending`) until `listenUntil` for a voice turn that names this reaction.
   */
  finish(scopeKey: string, answer: BodyReactionAnswer, at: string, listenUntil: string | null): boolean {
    const line = answer.message;
    const result = this.database.prepare(`
      UPDATE body_reactions SET status = ?, answer_json = ?, line_text = ?, message_id = ?, thread_id = ?, said_at = ?, listen_until = ?, link_state = ?
      WHERE scope_key = ? AND reaction_id = ? AND status = 'working'
    `).run(answer.status, JSON.stringify(answer), line?.text ?? null, line?.id ?? null, line?.threadId ?? null, line ? at : null,
      line ? listenUntil : null, line ? 'pending' : 'none', scopeKey, answer.id);
    return Number(result.changes) > 0;
  }

  /**
   * A voice turn names the reaction before the model answers: her line is returned as context and
   * kept for the stored turn. Null when the line is unknown, was never said, or its window passed.
   */
  link(scopeKey: string, reactionId: string, at: string): ReactionLine | null {
    return this.transaction(() => {
      this.expire(scopeKey, at);
      this.database.prepare(`
        UPDATE body_reactions SET link_state = 'linked', linked_until = ? WHERE scope_key = ? AND reaction_id = ? AND link_state = 'pending'
      `).run(new Date(Date.parse(at) + BODY_REACTION_LIMITS.linkedMilliseconds).toISOString(), scopeKey, reactionId);
      return this.line(scopeKey, reactionId, ['linked']);
    });
  }

  /** The stored turn takes the line, once: a second turn with the same id gets nothing. */
  claim(scopeKey: string, reactionId: string, at: string): ReactionLine | null {
    return this.transaction(() => {
      this.expire(scopeKey, at);
      const line = this.line(scopeKey, reactionId, ['pending', 'linked']);
      if (!line) return null;
      const taken = this.database.prepare(`
        UPDATE body_reactions SET link_state = 'stored' WHERE scope_key = ? AND reaction_id = ? AND link_state IN ('pending', 'linked')
      `).run(scopeKey, reactionId);
      return Number(taken.changes) > 0 ? line : null;
    });
  }

  /** Lines whose window passed without a voice turn are dropped from pending; old answers and touches are removed. */
  expire(scopeKey: string, at: string): void {
    this.database.prepare(`
      UPDATE body_reactions SET link_state = 'dropped'
      WHERE scope_key = ? AND ((link_state = 'pending' AND listen_until < ?) OR (link_state = 'linked' AND linked_until < ?))
    `).run(scopeKey, at, at);
  }

  prune(scopeKey: string, at: string): void {
    const time = Date.parse(at);
    this.expire(scopeKey, at);
    this.database.prepare('DELETE FROM body_reactions WHERE scope_key = ? AND created_at < ?')
      .run(scopeKey, new Date(time - BODY_REACTION_LIMITS.answerRetentionMilliseconds).toISOString());
    const old = new Date(time - BODY_REACTION_LIMITS.touchRetentionDays * 24 * 60 * 60_000).toISOString();
    // A burst goes with its last touch, and a touch never outlives its burst.
    this.database.prepare('DELETE FROM body_touch_bursts WHERE scope_key = ? AND last_at < ?').run(scopeKey, old);
    this.database.prepare(`
      DELETE FROM body_touches WHERE scope_key = ? AND (received_at < ? OR burst_id NOT IN (SELECT burst_id FROM body_touch_bursts WHERE scope_key = ?))
    `).run(scopeKey, old, scopeKey);
    // An outcome is kept as long as its touch, never longer (the retention of the record it came from, ADR-0006 answer 7).
    this.database.prepare(`
      DELETE FROM body_touch_outcomes WHERE scope_key = ? AND (decided_at < ? OR touch_id NOT IN (SELECT touch_id FROM body_touches WHERE scope_key = ?))
    `).run(scopeKey, old, scopeKey);
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }

  private line(scopeKey: string, reactionId: string, states: readonly ReactionLinkState[]): ReactionLine | null {
    const row = this.database.prepare('SELECT * FROM body_reactions WHERE scope_key = ? AND reaction_id = ?').get(scopeKey, reactionId) as unknown as ReactionRow | undefined;
    if (!row || !row.line_text || !row.said_at || !row.message_id || !states.includes(row.link_state as ReactionLinkState)) return null;
    return { id: row.reaction_id, text: row.line_text, threadId: row.thread_id, audience: row.audience as BodyAudience, saidAt: row.said_at, messageId: row.message_id };
  }
}
