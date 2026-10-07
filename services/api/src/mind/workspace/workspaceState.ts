import { UNKNOWN_GUEST_PRESENCE, type MemoryAudience } from '@shannon/cognition';
import {
  SALIENCE_V1, admit, currentSalience, novelty, persistenceOf, salience, withoutText,
  type AttentionItem, type MindEvent, type MindEventKind, type MindPresence, type MindSpeakerKind, type MindSurface, type MindTrust,
} from '@shannon/mind';

/**
 * The workspace of one scope (Syzygy ADR-0008 stage 3, step F3, `docs/mind-workspace-contract.md`): what attention holds, the
 * summary queue of what it let go, and the notices, as plain data. Every change is one operation that the journal records
 * without text (`WorkspaceOp`), so the same operations over a snapshot give the same workspace (restore = snapshot + replay).
 *
 * Attention orders; it never silences (`voiceSilence` stays the only silencer): nothing here decides whether she speaks.
 */
export interface WorkspaceDetail { code: string | null; tool: string | null; reason: string | null }

export interface WorkspaceItem {
  id: string;
  /** Arrival order in the scope (append-only). */
  seq: number;
  kind: MindEventKind;
  surface: MindSurface;
  body: string | null;
  audience: MemoryAudience;
  presence: MindPresence;
  speaker: MindSpeakerKind;
  trust: MindTrust;
  source: string;
  sourceId: string;
  /** A reference re-read through the withholding and the disclosure gate when rendered (`experience:<id>`), or null. */
  ref: string | null;
  at: string;
  /** s₀ (`SALIENCE_V1`). */
  initial: number;
  detail: WorkspaceDetail | null;
}

export interface WorkspaceScope {
  seq: number;
  /** What attention holds (at most K = 12), in arrival order; `orderedHeld` orders them. */
  held: WorkspaceItem[];
  /** The `[ほか]` queue: what attention let go since the last sleep, counted by surface. */
  summary: { count: number; surfaces: Partial<Record<MindSurface, number>>; day: string | null };
  /** Notices (a touch, a task's end, a promise's time, a rule that stopped her), in arrival order, appended only. */
  notices: WorkspaceItem[];
  /** The highest inbox row this scope perceived. */
  inboxSeq: number;
}

/** A change, as the journal keeps it: closed values, ids and numbers; the event without its text. */
export type WorkspaceOp =
  | { op: 'perceive'; event: MindEvent; initial: number; detail: WorkspaceDetail | null; at: string }
  | { op: 'bind'; itemId: string; ref: string; at: string }
  | { op: 'flush'; day: string; at: string };

export const WORKSPACE_LIMITS = Object.freeze({
  /** Notices kept per scope (the newest), and how long each kind stays a notice. */
  notices: 24,
  noticeMinutes: Object.freeze({ touch: 10, task_outcome: 60, promise_due: 60, notice: 60 } as Partial<Record<MindEventKind, number>>),
  /** Below this an item has faded and leaves attention without being summarized. */
  faded: 0.05,
});

/** The kinds that are notices (`【知らせ:…】`) rather than lines of `[いまの場]`. */
export const NOTICE_KINDS: ReadonlySet<MindEventKind> = new Set(['touch', 'task_outcome', 'promise_due', 'notice']);
/** The kinds that are someone's words. */
export const SPEECH_KINDS: ReadonlySet<MindEventKind> = new Set(['utterance', 'game', 'platform_message']);

export function emptyScope(): WorkspaceScope {
  return { seq: 0, held: [], summary: { count: 0, surfaces: {}, day: null }, notices: [], inboxSeq: 0 };
}

const attentionItem = (item: WorkspaceItem): AttentionItem => ({ id: item.id, initial: item.initial, at: item.at, persistence: persistenceOf(item.kind) });

/** s₀ of an event: its closed inputs, with novelty from what was said in the last 30 minutes (texts held in memory only). */
export function initialSalience(event: MindEvent, recentTexts: readonly string[]): number {
  const text = event.content && 'text' in event.content ? event.content.text : null;
  const inputs = text && SPEECH_KINDS.has(event.kind) ? { ...event.salienceInputs, novelty: novelty(text, recentTexts) } : event.salienceInputs;
  return salience(inputs);
}

function itemOf(event: MindEvent, seq: number, initial: number, detail: WorkspaceDetail | null): WorkspaceItem {
  const stored = withoutText(event);
  return {
    id: event.id, seq, kind: event.kind, surface: event.surface, body: event.body, audience: event.audience, presence: event.presence,
    speaker: event.speaker.kind, trust: event.provenance.trust, source: event.provenance.source, sourceId: event.provenance.sourceId,
    ref: stored.content && 'ref' in stored.content ? stored.content.ref : null, at: event.time, initial, detail,
  };
}

export type ApplyResult = { itemId: string; verdict: 'admitted' | 'below_entry' | 'evicted' | 'duplicate' };

/**
 * Applies one operation. Pure apart from mutating `scope`: the same operations in the same order give the same scope, which is
 * what restore relies on. Faded items leave first; an admission past K = 12 sends the lowest to the summary queue.
 */
export function applyOp(scope: WorkspaceScope, op: WorkspaceOp): ApplyResult | null {
  if (op.op === 'bind') {
    for (const entry of [...scope.held, ...scope.notices]) if (entry.id === op.itemId) entry.ref = op.ref;
    return null;
  }
  if (op.op === 'flush') {
    scope.summary = { count: 0, surfaces: {}, day: op.day };
    return null;
  }
  const { event } = op;
  if (scope.held.some(item => item.id === event.id) || scope.notices.some(item => item.id === event.id)) return { itemId: event.id, verdict: 'duplicate' };
  scope.seq += 1;
  const item = itemOf(event, scope.seq, op.initial, op.detail);
  if (event.id.startsWith('inbox:')) scope.inboxSeq = Math.max(scope.inboxSeq, Number(event.id.slice('inbox:'.length)) || 0);
  if (NOTICE_KINDS.has(item.kind)) {
    scope.notices.push(item);
    if (scope.notices.length > WORKSPACE_LIMITS.notices) scope.notices.splice(0, scope.notices.length - WORKSPACE_LIMITS.notices);
  }
  // Faded items leave attention; they were seen, and are not summarized.
  scope.held = scope.held.filter(entry => currentSalience(attentionItem(entry), op.at) >= WORKSPACE_LIMITS.faded);
  if (item.initial < SALIENCE_V1.entry) return { itemId: item.id, verdict: 'below_entry' };
  const admission = admit(scope.held.map(attentionItem), attentionItem(item), op.at);
  const evicted = new Set(admission.evicted.map(entry => entry.id));
  for (const gone of [...scope.held, item].filter(entry => evicted.has(entry.id))) {
    scope.summary.count += 1;
    scope.summary.surfaces[gone.surface] = (scope.summary.surfaces[gone.surface] ?? 0) + 1;
  }
  scope.held = [...scope.held, item].filter(entry => !evicted.has(entry.id));
  return { itemId: item.id, verdict: admission.admitted ? 'admitted' : 'evicted' };
}

/** What attention holds at `at`, highest current salience first (ties: newer, then id). */
export function orderedHeld(scope: WorkspaceScope, at: string): Array<{ item: WorkspaceItem; salience: number }> {
  return scope.held
    .map(item => ({ item, salience: currentSalience(attentionItem(item), at) }))
    .filter(entry => entry.salience >= WORKSPACE_LIMITS.faded)
    .sort((left, right) => right.salience - left.salience || right.item.at.localeCompare(left.item.at) || left.item.id.localeCompare(right.item.id));
}

/** The notices still current at `at`, in arrival order. */
export function currentNotices(scope: WorkspaceScope, at: string): WorkspaceItem[] {
  const now = Date.parse(at);
  return scope.notices.filter(item => {
    const age = now - Date.parse(item.at);
    const minutes = WORKSPACE_LIMITS.noticeMinutes[item.kind] ?? 30;
    // A promise is a notice from 30 minutes before its time.
    return age >= -30 * 60_000 && age <= minutes * 60_000;
  });
}

/**
 * Whether a voice item is someone else's turn with people in its audience (stage 3 review): it is kept, journaled and snapshotted
 * with the audience of an unknown guest, so no guest's person id is ever written (`mindHost.journaled` uses the same rule).
 */
export function isGuestVoice(item: { surface: string; speaker: string; audience: MemoryAudience }): boolean {
  return item.surface === 'voice' && item.speaker !== 'owner' && item.audience.kind !== 'owner';
}

const persisted = (item: WorkspaceItem): WorkspaceItem => (isGuestVoice(item) ? { ...item, audience: UNKNOWN_GUEST_PRESENCE } : item);

/** A snapshot of the scope as JSON (closed values only; the items carry no text, and a guest's turn no person id). */
export function snapshotOf(scope: WorkspaceScope): string {
  return JSON.stringify({ ...scope, held: scope.held.map(persisted), notices: scope.notices.map(persisted) });
}

export function scopeFromSnapshot(json: string): WorkspaceScope {
  const parsed = JSON.parse(json) as WorkspaceScope;
  return {
    seq: Number(parsed.seq) || 0, held: Array.isArray(parsed.held) ? parsed.held : [], notices: Array.isArray(parsed.notices) ? parsed.notices : [],
    summary: parsed.summary && typeof parsed.summary === 'object' ? { count: Number(parsed.summary.count) || 0, surfaces: { ...parsed.summary.surfaces }, day: parsed.summary.day ?? null } : { count: 0, surfaces: {}, day: null },
    inboxSeq: Number(parsed.inboxSeq) || 0,
  };
}
