import { UNKNOWN_GUEST_PRESENCE, type CompanionStateSnapshot, type MemoryAudience } from '@shannon/cognition';
import { checkedMindEvent, withoutText, type MindEvent, type MindSurface, type MindSwitches } from '@shannon/mind';
import { inboxDetail, inboxPerception, type MindPerceiver, type PerceivedDetail, type PerceivedItem } from '../perception/perceptionPorts.js';
import type { ConversationStore } from '../memory/memoryPorts.js';
import { workspaceBlocks } from './promptLayout.js';
import { WorkspaceTextReader } from './workspaceText.js';
import {
  applyOp, emptyScope, isGuestVoice, initialSalience, orderedHeld, currentNotices, scopeFromSnapshot, snapshotOf,
  type WorkspaceDetail, type WorkspaceItem, type WorkspaceOp, type WorkspaceScope,
} from './workspaceState.js';
import type { JournalRow, SQLiteWorkspaceJournal } from './store/workspaceJournalStore.js';
import type { SQLiteMindInbox } from './store/mindInboxStore.js';
import { isSqliteBusy } from '../../infra/sqlite/lockWaits.js';

/**
 * The mind's host in the API process (Syzygy ADR-0008 stage 3, owner answer 1: in-process behind `MindHost`, so that stage 4 can
 * move it to `mindWorker.ts`). Surfaces hand it events synchronously (`perceive`); a turn asks it for the workspace's blocks
 * (`render`). Nothing here waits: the journal is written in batches after the response (`turnEnded`, and the 2-second tick that
 * also tails `mind_inbox`), never on the response path.
 *
 * Faults: any exception falls back to the switched-off path (no item, no block) and writes a `mind_fault` trace; three faults
 * within 10 minutes open the circuit until the process restarts. A journal write that SQLite answered busy or locked (another
 * process held the write lock past the journal connection's short busy timeout) is not a fault: its batch is kept for the next
 * write and only counted (`busyCount`). A failed write of any kind never drops its batch (at most `pendingRows` are kept).
 */
export interface WorkspaceTurn {
  scopeKey: string;
  surface: 'text' | 'voice';
  present: MemoryAudience;
  at: string;
  /** The item this turn perceived, and its conversation (surface and thread or request id): not repeated. */
  currentItemId: string | null;
  current: { surface: MindSurface; sourceId: string } | null;
  snapshot: CompanionStateSnapshot;
  snapshotNow?:()=>CompanionStateSnapshot;
  store: ConversationStore | null;
}

/** What a surface and a turn are handed of the mind. Every method is synchronous and never throws. */
export interface MindTurnPorts extends MindPerceiver {
  foreground?<T>(scopeKey:string,work:()=>Promise<T>):Promise<T>;
  /** Stage 4: drain this turn's IPC events before rendering, bounded by the client. No model call. */
  sync?(): Promise<void>;
  /** The workspace's blocks to append after the turn's context, or '' (switched off, faulted, nothing to say). */
  render?(turn: WorkspaceTurn): string;
  /** The stored turn of an item, as a reference re-read at render (`experience:<id>`). */
  bind?(scopeKey: string, itemId: string, ref: string): void;
  /** The response is built: what the mind noted is written now, off the response path. */
  turnEnded?(): void;
  /** Whether untrusted text reaches a prompt inside data frames (`SHANNON_DATA_FRAMES`), for blocks a turn builds itself. */
  readonly dataFrames?: boolean;
}

export interface MindHost extends Required<Omit<MindTurnPorts,'foreground'|'sync'>> {
  /** Tails the inbox and writes the journal (every 2 seconds). */
  tick(): void;
  /** Writes what is pending and snapshots every scope (on SIGTERM). */
  close(): void;
  /** What attention holds and the notices of a scope, closed values only (tests, scenarios). */
  view(scopeKey: string, at: string): { held: Array<{ id: string; kind: string; surface: string; salience: number; ref: string | null }>; notices: string[]; summary: number };
  /** Whether the circuit is open (three faults within 10 minutes). */
  readonly faulted: boolean;
  /** Faults since the process started, and journal writes that met a busy database (not faults); for `/v1/ops`. */
  readonly faultCount: number;
  readonly busyCount: number;
  /** A projection for the API process. Words are transient; journal/snapshots still contain references only. */
  projection(scopeKey: string): { scope: WorkspaceScope; texts: Record<string,string> };
}

export interface MindHostOptions {
  switches: Pick<MindSwitches, 'attention' | 'workspace' | 'dataFrames'>;
  /** The journal and the snapshots; null while the workspace is off (attention is then held in memory only). */
  journal: SQLiteWorkspaceJournal | null;
  inbox: SQLiteMindInbox | null;
  now: () => string;
  /** Runs the journal's write after the response (`setImmediate` in the server; at once in tests). */
  schedule?: (task: () => void) => void;
  log?: (line: string) => void;
  /** The owner's zone: the summary queue is flushed at her night (04:00 there). */
  timeZone?: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const MIND_HOST_LIMITS = Object.freeze({
  snapshotEveryOps: 200, snapshotEveryMilliseconds: 10 * MINUTE, faultWindowMilliseconds: 10 * MINUTE, faultsToOpen: 3,
  keepMilliseconds: 7 * DAY, inboxFreshMilliseconds: 30 * MINUTE, noveltyMilliseconds: 30 * MINUTE, heldTexts: 400,
  /** Journal rows kept while writes fail; beyond it the oldest are dropped (restore then misses them, as after a crash). */
  pendingRows: 5_000,
});

export function createMindHost(options: MindHostOptions): MindHost {
  return new InProcessMindHost(options);
}

class InProcessMindHost implements MindHost {
  private readonly scopes = new Map<string, WorkspaceScope>();
  /** Words held in memory only, by item, for the life of the process (never journaled). */
  private readonly texts = new Map<string, string>();
  private readonly recent = new Map<string, Array<{ at: number; text: string }>>();
  private pending: Array<Omit<JournalRow, 'seq'>> = [];
  private readonly sinceSnapshot = new Map<string, { ops: number; at: number }>();
  private faults: number[] = [];
  private faultTotal = 0;
  private busyTotal = 0;
  private open = false;
  private inboxCursor = 0;
  private lastPrune = 0;
  private readonly dayFormat: Intl.DateTimeFormat;

  constructor(private readonly options: MindHostOptions) {
    this.dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone ?? 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
    this.guarded('restore', () => this.restore(), undefined);
  }

  get faulted(): boolean { return this.open; }
  get faultCount(): number { return this.faultTotal; }
  get busyCount(): number { return this.busyTotal; }
  get dataFrames(): boolean { return this.options.switches.dataFrames && !this.open; }
  projection(scopeKey: string) {
    const scope=this.scopes.get(scopeKey) ?? emptyScope();
    return {scope:structuredClone(scope),texts:Object.fromEntries([...scope.held,...scope.notices].flatMap(item=>this.texts.has(item.id)?[[item.id,this.texts.get(item.id)!]]:[]))};
  }

  perceive(scopeKey: string, event: MindEvent | null, detail?: PerceivedDetail | null): PerceivedItem | null {
    if (!event || !this.options.switches.attention) return null;
    return this.guarded('perceive', () => {
      this.tailInbox();
      return this.take(scopeKey, event, detail ?? null);
    }, null);
  }

  render(turn: WorkspaceTurn): string {
    if (!this.options.switches.workspace) return '';
    return this.guarded('render', () => {
      this.tailInbox();
      const scope = this.scopes.get(turn.scopeKey);
      if (!scope) return '';
      const reader = new WorkspaceTextReader(turn.snapshot, turn.store, turn.scopeKey, turn.present);
      return workspaceBlocks(scope, {
        surface: turn.surface, present: turn.present, at: turn.at, currentItemId: turn.currentItemId, current: turn.current,
        dataFrames: this.options.switches.dataFrames, text: (item: WorkspaceItem) => reader.read(item, this.texts.get(item.id) ?? null),
        noticeVisible: (item: WorkspaceItem) => reader.noticeVisible(item),
      });
    }, '');
  }

  bind(scopeKey: string, itemId: string, ref: string): void {
    if (!this.options.switches.attention) return;
    this.guarded('bind', () => {
      if (!/^experience:[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u.test(ref)) return;
      const scope = this.scopes.get(scopeKey);
      if (!scope) return;
      this.apply(scopeKey, scope, { op: 'bind', itemId, ref, at: this.options.now() });
    }, undefined);
  }

  turnEnded(): void {
    if (!this.options.journal || this.open) return;
    const schedule = this.options.schedule ?? (task => { setImmediate(task); });
    schedule(() => this.guarded('journal', () => this.flush(), undefined, true));
  }

  tick(): void {
    if (this.open) return;
    this.guarded('tick', () => { this.tailInbox(); this.flush(); }, undefined, true);
  }

  close(): void {
    if (this.open || !this.options.journal) return;
    this.guarded('close', () => { this.flush(); this.snapshotAll(true); }, undefined);
  }

  view(scopeKey: string, at: string) {
    const scope = this.scopes.get(scopeKey) ?? emptyScope();
    return {
      held: orderedHeld(scope, at).map(entry => ({ id: entry.item.id, kind: entry.item.kind, surface: entry.item.surface, salience: entry.salience, ref: entry.item.ref })),
      notices: currentNotices(scope, at).map(item => item.id), summary: scope.summary.count,
    };
  }

  // ---- internals ----

  private scope(scopeKey: string): WorkspaceScope {
    let scope = this.scopes.get(scopeKey);
    if (!scope) { scope = emptyScope(); this.scopes.set(scopeKey, scope); }
    return scope;
  }

  private take(scopeKey: string, event: MindEvent, detail: PerceivedDetail | null): PerceivedItem | null {
    const checked = checkedMindEvent(event, { copyAudience: true });
    if (typeof checked === 'string') return null;
    const scope = this.scope(scopeKey);
    this.flushAtNight(scopeKey, scope, checked.time);
    const text = checked.content && 'text' in checked.content ? checked.content.text : null;
    const at = Date.parse(checked.time);
    const recent = (this.recent.get(scopeKey) ?? []).filter(entry => at - entry.at <= MIND_HOST_LIMITS.noveltyMilliseconds && at >= entry.at);
    const initial = initialSalience(checked, recent.map(entry => entry.text));
    const closedDetail: WorkspaceDetail | null = detail ? { code: detail.code ?? null, tool: detail.tool ?? null, reason: detail.reason ?? null } : null;
    const result = this.apply(scopeKey, scope, { op: 'perceive', event: checked, initial, detail: closedDetail, at: checked.time });
    if (!result || result.verdict === 'duplicate') return result ? { itemId: result.itemId, salience: initial, verdict: 'duplicate' } : null;
    if (text) {
      this.recent.set(scopeKey, [...recent, { at, text }].slice(-50));
      this.texts.set(checked.id, text);
      if (this.texts.size > MIND_HOST_LIMITS.heldTexts) this.texts.delete(this.texts.keys().next().value!);
    }
    return { itemId: result.itemId, salience: initial, verdict: result.verdict };
  }

  /** Applies one operation and notes it for the journal (closed values; the event without its text). */
  private apply(scopeKey: string, scope: WorkspaceScope, op: WorkspaceOp) {
    const result = applyOp(scope, op);
    if (this.options.journal && !(op.op === 'perceive' && result?.verdict === 'duplicate')) {
      this.pending.push(op.op === 'perceive'
        ? { scopeKey, at: op.at, op: 'perceive', itemId: op.event.id, data: { event: journaled(op.event), initial: op.initial, detail: op.detail } }
        : op.op === 'bind' ? { scopeKey, at: op.at, op: 'bind', itemId: op.itemId, data: { ref: op.ref } }
          : { scopeKey, at: op.at, op: 'flush', itemId: null, data: { day: op.day } });
    }
    return result;
  }

  /** The owner-local day of her night (a day runs from 04:00 to 04:00). */
  private dayOf(at: string): string {
    return this.dayFormat.format(new Date(Date.parse(at) - 4 * 3_600_000));
  }

  /** The summary queue is flushed at her night: the first event of a new day empties it. */
  private flushAtNight(scopeKey: string, scope: WorkspaceScope, at: string): void {
    const day = this.dayOf(at);
    if (scope.summary.day !== day) this.apply(scopeKey, scope, { op: 'flush', day, at });
  }

  private tailInbox(): void {
    const inbox = this.options.inbox;
    if (!inbox) return;
    const now = this.options.now();
    const rows = inbox.after(this.inboxCursor, new Date(Date.parse(now) - MIND_HOST_LIMITS.inboxFreshMilliseconds).toISOString());
    for (const row of rows) {
      this.inboxCursor = Math.max(this.inboxCursor, row.seq);
      const draft = { kind: row.kind, code: row.code, audience: row.audience, source: row.source, sourceId: row.sourceId, tool: row.tool, reason: row.reason, deltaMinutes: row.deltaMinutes, ref: row.ref };
      const event = inboxPerception({ draft, at: row.at, seq: row.seq });
      if (event) this.take(row.scopeKey, event, inboxDetail(draft));
    }
  }

  private flush(): void {
    const journal = this.options.journal;
    if (!journal) return;
    const now = Date.parse(this.options.now());
    if (this.pending.length) {
      const batch = this.pending;
      this.pending = [];
      try {
        journal.append(batch);
      } catch (error) {
        // Kept for the next write, before anything noted since (append rolls the whole batch back).
        this.pending = [...batch, ...this.pending].slice(-MIND_HOST_LIMITS.pendingRows);
        throw error;
      }
      for (const row of batch) {
        const entry = this.sinceSnapshot.get(row.scopeKey) ?? { ops: 0, at: now };
        this.sinceSnapshot.set(row.scopeKey, { ops: entry.ops + 1, at: entry.at });
      }
    }
    this.snapshotAll(false);
    if (now - this.lastPrune >= 3_600_000) {
      this.lastPrune = now;
      const before = new Date(now - MIND_HOST_LIMITS.keepMilliseconds).toISOString();
      journal.prune(before);
      this.options.inbox?.prune(before);
    }
  }

  /** Snapshots every scope that is due: 200 operations, or 10 minutes with any; all of them on close. */
  private snapshotAll(force: boolean): void {
    const journal = this.options.journal;
    if (!journal) return;
    const now = Date.parse(this.options.now());
    const last = journal.lastSeq();
    for (const [scopeKey, entry] of this.sinceSnapshot) {
      if (!entry.ops) continue;
      if (!force && entry.ops < MIND_HOST_LIMITS.snapshotEveryOps && now - entry.at < MIND_HOST_LIMITS.snapshotEveryMilliseconds) continue;
      const scope = this.scopes.get(scopeKey);
      if (!scope) continue;
      journal.writeSnapshot({ scopeKey, journalSeq: last, takenAt: new Date(now).toISOString(), state: snapshotOf(scope) });
      this.sinceSnapshot.set(scopeKey, { ops: 0, at: now });
    }
  }

  /** Restore = each scope's snapshot, then the journal after it (at most 7 days). */
  private restore(): void {
    const journal = this.options.journal;
    if (!journal) return;
    const since = new Date(Date.parse(this.options.now()) - MIND_HOST_LIMITS.keepMilliseconds).toISOString();
    for (const scopeKey of journal.scopes().filter(key => !key.startsWith('_'))) {
      const snapshot = journal.snapshot(scopeKey);
      const scope = snapshot ? scopeFromSnapshot(snapshot.state) : emptyScope();
      for (const row of journal.after(scopeKey, snapshot?.journalSeq ?? 0, since)) {
        const op = operationOf(row);
        if (op) applyOp(scope, op);
      }
      this.scopes.set(scopeKey, scope);
      this.inboxCursor = Math.max(this.inboxCursor, scope.inboxSeq);
    }
  }

  /** Runs `task`; a throw is a fault, except a busy database in a background journal write (`background`), which is only counted. */
  private guarded<T>(stage: string, task: () => T, fallback: T, background = false): T {
    if (this.open) return fallback;
    try {
      return task();
    } catch (error) {
      if (background && isSqliteBusy(error)) {
        this.busyTotal += 1;
        try { this.options.log?.(`mind_busy stage=${stage} pending=${this.pending.length}`); } catch { /* the log is optional */ }
        return fallback;
      }
      this.fault(stage, error);
      return fallback;
    }
  }

  /** One fault: a `mind_fault` trace (content-free) and, at the third within 10 minutes, the circuit opens until restart. */
  private fault(stage: string, error: unknown): void {
    const now = Date.parse(this.options.now()) || Date.now();
    this.faults = [...this.faults.filter(at => now - at < MIND_HOST_LIMITS.faultWindowMilliseconds), now];
    this.faultTotal += 1;
    const name = error instanceof Error ? error.name : 'unknown';
    if (this.faults.length >= MIND_HOST_LIMITS.faultsToOpen) this.open = true;
    try { this.options.log?.(`mind_fault stage=${stage} error=${name}${this.open ? ' circuit=open' : ''}`); } catch { /* the log is optional */ }
    try {
      this.options.journal?.append([{ scopeKey: '_mind', at: new Date(now).toISOString(), op: 'mind_fault', itemId: null, data: { stage, error: name, open: this.open } }]);
    } catch { /* the trace is best effort */ }
  }
}

/**
 * An event as the journal keeps it: without its text, and (stage 3 review, HIGH) a voice turn of anyone but the owner without the
 * people it was with: its audience is journaled as an unknown guest, so no guest's person id is ever written, whether the call was
 * remembered, discarded or a client's that predates people memory (nothing to scrub on a discard). In memory it keeps its audience.
 */
function journaled(event: MindEvent): MindEvent {
  const plain = withoutText(event);
  return isGuestVoice({ surface: event.surface, speaker: event.speaker.kind, audience: event.audience })
    ? { ...plain, audience: UNKNOWN_GUEST_PRESENCE, people: [] } : plain;
}

/** A journal row read back as an operation; null for a trace or anything unreadable. */
export function operationOf(row: JournalRow): WorkspaceOp | null {
  if (row.op === 'bind' && row.itemId && typeof row.data.ref === 'string') return { op: 'bind', itemId: row.itemId, ref: row.data.ref, at: row.at };
  if (row.op === 'flush' && typeof row.data.day === 'string') return { op: 'flush', day: row.data.day, at: row.at };
  if (row.op !== 'perceive') return null;
  const event = checkedMindEvent(row.data.event);
  if (typeof event === 'string' || typeof row.data.initial !== 'number') return null;
  const detail = row.data.detail as WorkspaceDetail | null;
  return { op: 'perceive', event, initial: row.data.initial, detail: detail && typeof detail === 'object' ? { code: detail.code ?? null, tool: detail.tool ?? null, reason: detail.reason ?? null } : null, at: row.at };
}
