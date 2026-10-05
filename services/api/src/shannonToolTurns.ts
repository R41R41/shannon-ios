import type { TurnBackgroundService } from './backgroundUpdates.js';
import { saidKey, sameWords } from './bodyLookTurnWait.js';
import { TRACE_CALLS, type ToolTraceCall, type ToolTraceRecord } from './shannonToolTrace.js';

/** Where traces are kept: the SQLite store in production (`sqliteToolTraces.ts`), memory otherwise. */
export interface ToolTraceStore {
  saveToolTrace(scopeKey: string, record: ToolTraceRecord): void;
  /** The thread's traces of these turns, and (with `since`) every trace recorded since then. */
  toolTraces(scopeKey: string, threadId: string, query: { turnIds?: readonly string[]; since?: string }): readonly ToolTraceRecord[];
}

/**
 * After a voice turn that was offered her tools because the owner asked about her things, or one in which she used
 * them, the next voice turns of the same Talk are offered them too for this long (a follow-up such as 「もっとよく見て」
 * or 「はい、お願いします」 names nothing of hers).
 */
export const TOOL_FOLLOW_UP_MILLISECONDS = 10 * 60_000;
const MAXIMUM_PENDING = 32;

interface PendingTurn {
  key: string;
  said: string;
  at: number;
  recordedAt: string;
  asked: boolean;
  calls: ToolTraceCall[];
}

export class InMemoryToolTraces implements ToolTraceStore {
  private readonly records: Array<{ scopeKey: string; record: ToolTraceRecord }> = [];
  saveToolTrace(scopeKey: string, record: ToolTraceRecord): void {
    this.records.push({ scopeKey, record });
    this.records.splice(0, Math.max(0, this.records.length - 500));
  }
  toolTraces(scopeKey: string, threadId: string, query: { turnIds?: readonly string[]; since?: string }): readonly ToolTraceRecord[] {
    return this.records.filter(({ scopeKey: scope, record }) => scope === scopeKey && record.threadId === threadId
      && ((query.turnIds?.includes(record.turnId) ?? false) || (query.since !== undefined && record.recordedAt >= query.since))).map(entry => entry.record);
  }
}

/**
 * The tool calls of each conversation turn, from the moment the turn is offered tools until it is stored in the Talk.
 * A voice turn is stored by a request of its own after the reply (`POST /v1/voice/…/turns`); it is known here by its
 * Talk and the owner's words (the same tolerance as `bodyLookTurnWait.ts`), which are held in memory for ten minutes
 * at most and never written. The trace is then kept with the stored turn's id, only for a turn of the owner alone.
 */
export class ToolTurnLog {
  private pending: PendingTurn[] = [];

  constructor(private readonly store: ToolTraceStore, private readonly now: () => string) {}

  /** A turn was offered her tools. `asked`: a voice turn whose words were about her things. */
  open(scopeKey: string, threadId: string, words: string, asked: boolean): { called(call: ToolTraceCall): void } {
    const at = this.clock();
    this.pending = this.pending.filter(turn => at - turn.at < TOOL_FOLLOW_UP_MILLISECONDS).slice(-(MAXIMUM_PENDING - 1));
    const key = `${scopeKey}\u0000${threadId}`;
    const said = saidKey(words);
    // A retry of the same words in the same Talk is the same turn.
    let turn = this.pending.find(item => item.key === key && item.said === said);
    if (turn) { turn.at = at; turn.asked ||= asked; } else {
      turn = { key, said, at, recordedAt: this.now(), asked, calls: [] };
      this.pending.push(turn);
    }
    const open = turn;
    return { called: call => { if (open.calls.length < TRACE_CALLS) open.calls.push(call); } };
  }

  /** A turn was stored in the Talk: the trace of the same Talk and words goes with it, if the owner alone heard it. */
  turnStored(scopeKey: string, threadId: string, turnId: string, words: string, ownerAlone: boolean): void {
    const key = `${scopeKey}\u0000${threadId}`;
    const said = saidKey(words);
    let index = this.pending.length - 1;
    while (index >= 0 && !(this.pending[index]!.key === key && sameWords(this.pending[index]!.said, said))) index -= 1;
    if (index < 0) return;
    const [turn] = this.pending.splice(index, 1);
    if (!ownerAlone || (!turn!.asked && !turn!.calls.length)) return;
    try {
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

  /** The traces of these stored turns. */
  traces(scopeKey: string, threadId: string, turnIds: readonly string[]): readonly ToolTraceRecord[] {
    if (!turnIds.length) return [];
    try { return this.store.toolTraces(scopeKey, threadId, { turnIds }); } catch { return []; }
  }

  /** The background service of the API, which stores every turn: each stored turn takes its trace with it. */
  watching(background: TurnBackgroundService): TurnBackgroundService {
    return {
      mode: background.mode,
      recordTurn: turn => {
        const experience = background.recordTurn(turn);
        this.turnStored(turn.scopeKey, turn.threadId, experience.id, turn.userMessage, !turn.audience);
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
