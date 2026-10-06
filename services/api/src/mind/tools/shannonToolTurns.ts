import { randomUUID } from 'node:crypto';
import type { TurnBackgroundService } from '../sleep/backgroundUpdates.js';
import { saidKey, sameWords } from '../../surfaces/body/bodyLookTurnWait.js';
import { TRACE_CALLS, UNLINKED_TURN, saidDigest, type ToolTraceCall, type ToolTraceRecord } from './shannonToolTrace.js';

/** Where traces are kept: the SQLite store in production (`sqliteToolTraces.ts`), memory otherwise. */
export interface ToolTraceStore {
  /** Writes the trace of one turn, replacing an earlier one of the same turn id. */
  saveToolTrace(scopeKey: string, record: ToolTraceRecord): void;
  /** The traces of these turns, and (with `since`) every trace recorded since then; `threadId` null: every Talk of the scope. */
  toolTraces(scopeKey: string, threadId: string | null, query: { turnIds?: readonly string[]; since?: string }): readonly ToolTraceRecord[];
  deleteToolTraces(scopeKey: string, turnIds: readonly string[]): void;
  /** The scopes that have traces, for the sweep (`shannonToolTraceSweep.ts`). */
  toolTraceScopes(): readonly string[];
  /** Drops every trace recorded before `before`, in every scope. */
  pruneToolTraces(before: string): void;
}

/**
 * After a voice turn that was offered her tools because the owner asked about her things, or one in which she used
 * them, the next voice turns of the same Talk are offered them too for this long (a follow-up such as 「もっとよく見て」
 * or 「はい、お願いします」 names nothing of hers).
 */
export const TOOL_FOLLOW_UP_MILLISECONDS = 10 * 60_000;
/** A trace is kept this long; it is replayed only while its turn is in the replayed window anyway. */
export const TOOL_TRACE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;
const MAXIMUM_PENDING = 32;
/** A delegation sent again with the same words and no utterance id is the same turn only this soon, and only for words this long. */
const RETRY_MILLISECONDS = 60_000;
const RETRY_MINIMUM_CHARACTERS = 6;

interface PendingTurn {
  scopeKey: string;
  threadId: string;
  key: string;
  said: string;
  utteranceId?: string;
  at: number;
  recordedAt: string;
  asked: boolean;
  calls: ToolTraceCall[];
  /** The id of its Talk-linked row while the turn is not stored (`UNLINKED_TURN`). */
  provisionalId: string;
  persisted: boolean;
}

export class InMemoryToolTraces implements ToolTraceStore {
  private records: Array<{ scopeKey: string; record: ToolTraceRecord }> = [];
  saveToolTrace(scopeKey: string, record: ToolTraceRecord): void {
    this.records = [...this.records.filter(entry => !(entry.scopeKey === scopeKey && entry.record.turnId === record.turnId)), { scopeKey, record }].slice(-500);
  }
  toolTraces(scopeKey: string, threadId: string | null, query: { turnIds?: readonly string[]; since?: string }): readonly ToolTraceRecord[] {
    return this.records.filter(({ scopeKey: scope, record }) => scope === scopeKey && (threadId === null || record.threadId === threadId)
      && ((query.turnIds?.includes(record.turnId) ?? false) || (query.since !== undefined && record.recordedAt >= query.since))).map(entry => entry.record);
  }
  deleteToolTraces(scopeKey: string, turnIds: readonly string[]): void {
    this.records = this.records.filter(entry => !(entry.scopeKey === scopeKey && turnIds.includes(entry.record.turnId)));
  }
  toolTraceScopes(): readonly string[] { return [...new Set(this.records.map(entry => entry.scopeKey))]; }
  pruneToolTraces(before: string): void { this.records = this.records.filter(entry => entry.record.recordedAt >= before); }
}

/**
 * The tool calls of each conversation turn, from the moment the turn is offered tools until it is stored in the Talk.
 * A voice turn is stored by a request of its own after the reply (`POST /v1/voice/…/turns`). It is known here by the
 * client's utterance id when both requests carry one, otherwise by its Talk and the owner's words (the tolerance of
 * `bodyLookTurnWait.ts`); the words are held in memory for ten minutes at most and never written.
 *
 * From its first call a turn's trace is also written linked to the Talk only (an `UNLINKED_TURN` id), so that the calls
 * that really ran are known even when her reply was cut off and the turn is never stored. When the turn is stored with
 * the owner alone, the trace moves to the stored turn's id; stored with anyone else present, it is dropped.
 */
export class ToolTurnLog {
  private pending: PendingTurn[] = [];

  constructor(private readonly store: ToolTraceStore, private readonly now: () => string) {}

  /** A turn was offered her tools. `asked`: a voice turn whose words were about her things. */
  open(scopeKey: string, threadId: string, words: string, asked: boolean, utteranceId?: string): { called(call: ToolTraceCall): void } {
    const at = this.clock();
    this.pending = this.pending.filter(turn => at - turn.at < TOOL_FOLLOW_UP_MILLISECONDS).slice(-(MAXIMUM_PENDING - 1));
    const key = `${scopeKey}\u0000${threadId}`;
    const said = saidKey(words);
    // A retry of the same delegation is the same turn: by its utterance id, or without ids by the same longer words soon after.
    // A short confirmation said again (「はい」) is a new turn.
    let turn = this.pending.find(item => item.key === key && (utteranceId && item.utteranceId ? item.utteranceId === utteranceId
      : !utteranceId && !item.utteranceId && item.said === said && Array.from(said).length >= RETRY_MINIMUM_CHARACTERS && at - item.at < RETRY_MILLISECONDS));
    if (turn) { turn.at = at; turn.asked ||= asked; } else {
      turn = { scopeKey, threadId, key, said, ...(utteranceId ? { utteranceId } : {}), at, recordedAt: this.now(), asked, calls: [],
        provisionalId: `${UNLINKED_TURN}${randomUUID()}`, persisted: false };
      this.pending.push(turn);
    }
    const open = turn;
    return { called: call => {
      if (open.calls.length >= TRACE_CALLS) return;
      open.calls.push(call);
      try {
        this.store.saveToolTrace(open.scopeKey, { turnId: open.provisionalId, threadId: open.threadId, recordedAt: open.recordedAt, asked: open.asked, calls: [...open.calls], saidDigest: saidDigest(open.said) });
        open.persisted = true;
      } catch { /* the call stands; only the memory of it is lost */ }
    } };
  }

  /** A turn was stored in the Talk: the trace of the same utterance (or Talk and words) goes with it, if the owner alone heard it. */
  turnStored(scopeKey: string, threadId: string, turnId: string, words: string, ownerAlone: boolean, utteranceId?: string): void {
    const key = `${scopeKey}\u0000${threadId}`;
    const said = saidKey(words);
    let index = this.pending.length - 1;
    const same = (turn: PendingTurn) => turn.key === key && (turn.utteranceId && utteranceId ? turn.utteranceId === utteranceId : sameWords(turn.said, said));
    while (index >= 0 && !same(this.pending[index]!)) index -= 1;
    if (index < 0) return;
    const [turn] = this.pending.splice(index, 1);
    try {
      if (turn!.persisted) this.store.deleteToolTraces(scopeKey, [turn!.provisionalId]);
      if (!ownerAlone || (!turn!.asked && !turn!.calls.length)) return;
      this.store.saveToolTrace(scopeKey, { turnId, threadId, recordedAt: turn!.recordedAt, asked: turn!.asked, calls: [...turn!.calls] });
    } catch { /* the turn is stored either way; she only forgets what her tools did */ }
  }

  /** Whether this Talk had, in the last ten minutes, a voice turn that asked about her things or a turn that used her tools. */
  recent(scopeKey: string, threadId: string): boolean {
    const at = this.clock();
    const key = `${scopeKey}\u0000${threadId}`;
    if (this.pending.some(turn => turn.key === key && at - turn.at < TOOL_FOLLOW_UP_MILLISECONDS && (turn.asked || turn.calls.length > 0))) return true;
    try {
      const since = new Date(at - TOOL_FOLLOW_UP_MILLISECONDS).toISOString();
      return this.store.toolTraces(scopeKey, threadId, { since }).some(record => record.asked || record.calls.length > 0);
    } catch { return false; }
  }

  /** The traces of these stored turns, and the Talk's traces of turns not stored, recorded since `since`. */
  traces(scopeKey: string, threadId: string, turnIds: readonly string[], since?: string): readonly ToolTraceRecord[] {
    if (!turnIds.length && since === undefined) return [];
    const records = this.store.toolTraces(scopeKey, threadId, { turnIds, ...(since !== undefined ? { since } : {}) });
    // A turn not (yet) in the Talk: her reply was cut off, or the client has not stored it. What ran there is told too.
    return records.filter(record => turnIds.includes(record.turnId) || record.turnId.startsWith(UNLINKED_TURN));
  }

  /** The background service of the API, which stores every turn: each stored turn takes its trace with it. */
  watching(background: TurnBackgroundService): TurnBackgroundService {
    return {
      mode: background.mode,
      recordTurn: turn => {
        const experience = background.recordTurn(turn);
        this.turnStored(turn.scopeKey, turn.threadId, experience.id, turn.userMessage, !turn.audience, turn.utteranceId);
        return experience;
      },
      schedule: (turn, recordedExperienceId) => background.schedule(turn, recordedExperienceId),
      waitForIdle: scopeKey => background.waitForIdle(scopeKey),
    };
  }

  private clock(): number {
    const at = Date.parse(this.now());
    return Number.isFinite(at) ? at : Date.now();
  }
}
