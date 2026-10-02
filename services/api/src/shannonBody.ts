import { createHash } from 'node:crypto';
import { SHANNON_OWNER_NAME, currentShannonEmotion, type CompanionStateStore } from '@shannon/cognition';
import type { AutonomyActivityDay } from './autonomyActivity.js';
import type { AutonomyControlLabel, ShannonAutonomyService } from './autonomyService.js';
import {
  BODY_LIMITS, BODY_SCHEMA_VERSION, BODY_TOUCH_EVENT_TYPES,
  type BodyAudience, type BodyCapabilities, type BodyDoing, type BodyEvent, type BodyEventType, type BodyNudge, type BodyReachOutDeliveryOutcome,
} from './bodyContract.js';
import { BODY_LOOK_TOOL, BodyLooks, type BodyLookOptions } from './bodyLook.js';
import { BODY_LOOK_LIMITS } from './bodyLookContract.js';
import { noteBodyLookSpeaker } from './bodyLookDelivery.js';
import { bodyNudgeCandidates } from './bodyNudges.js';
import { BodyReactions } from './bodyReaction.js';
import { BODY_REACTION_TOOL, configuredBodyReactions, type BodyReactionConfig } from './bodyReactionContract.js';
import type { BodyReactionSpeaker } from './bodyReactionModel.js';
import { SQLiteBodyReactionStore } from './bodyReactionStore.js';
import { BodyTouches } from './bodyTouch.js';
import type { TouchExperienceWriter } from './bodyTouchMemory.js';
import { SQLiteBodyStore, type StoredBodyCapabilities, type StoredBodyEvent } from './bodyStore.js';
import { ownerDay, presentCompanionState } from './companionPresence.js';
import type { ConversationStore } from './conversationStore.js';
import type { ReachOutReportResult, SQLiteReachOutReports } from './reachOutReports.js';

/**
 * Shannon's body (the Live2D desktop application), seen from her mind.
 *
 * - Events are facts the body reports. They are stored, and the recent ones the owner
 *   caused become one short factual block for an owner conversation turn. An event never
 *   produces a reply by itself, and an event with audience `others` never reaches a prompt.
 * - Presence is a read-only projection of state that already exists: 「いま」, the autonomy
 *   switch, the activity loop's latest step, and her study. Nothing is written by reading it.
 */
export interface ShannonBodyOptions {
  store?: SQLiteBodyStore;
  /** `SHANNON_BODY_INGEST`; unset means on. */
  ingestEnabled?: boolean;
  /** Looking at the room (`bodyLook.ts`): its table, switch and limits, the model call, and the way her message is delivered. */
  look?: BodyLookOptions;
  /** Messages she started on her own that the owner has not read (`reachOutDelivery.ts`); absent, presence has no `reachOut`. */
  reachOuts?: (scopeKey: string) => { pending: number; latestId?: string };
  /** What the body did with a message of hers, and when it last read presence (`reachOutReports.ts`); absent, the report route answers 404. */
  reachOutReports?: Pick<SQLiteReachOutReports, 'report' | 'markPresence'>;
  /** `SHANNON_AUTONOMY_MAX_FOLLOW_UPS` above zero. Off, no report is taken and no presence read is noted for the loop. Unset means on. */
  reachOutReportsEnabled?: boolean;
  /** When she is touched (`bodyReaction.ts`): its tables, switch and timings, the fast model, and where a touch becomes an experience. */
  reactions?: { store?: SQLiteBodyReactionStore; config?: Partial<BodyReactionConfig>; speaker?: BodyReactionSpeaker | null; experiences?: TouchExperienceWriter | null };
}

export interface ShannonBodyDependencies extends ShannonBodyOptions {
  stateStore: CompanionStateStore;
  autonomy: ShannonAutonomyService;
  conversationStore: ConversationStore;
  now: () => string;
}

export type BodyEventResult =
  | { id: string; status: 'stored' | 'duplicate' | 'conflict' }
  | { id: string; status: 'ignored'; reason: 'stale' | 'future' | 'daily_cap' };

export interface BodyIngestReceipt {
  schemaVersion: number;
  stored: number;
  duplicates: number;
  results: readonly BodyEventResult[];
}

export interface BodyPresence {
  schemaVersion: number;
  etag: string;
  /** When this server first saw the snapshot with this `etag`. */
  changedAt: string;
  pollAfterSeconds: number;
  mood: {
    expression: string; feeling?: string; primary: string; intensity: number; fromConversation: boolean;
    valence: number; arousal: number; openness: number;
  };
  doing: BodyDoing;
  autonomy: { state: AutonomyControlLabel };
  study: { awaitingReaction: number };
  capabilities: StoredBodyCapabilities | null;
  /** A look this device is asked to take now, or null. Absent while looks are switched off on the server. */
  look?: { id: string; requestedAt: string; expiresAt: string } | null;
  /** Unread messages she started on her own; `latestId` is the newest one's initiative id. Absent when the server does not deliver them. */
  reachOut?: { pending: number; latestId?: string };
}

export type BodyPresenceUnchanged = Pick<BodyPresence, 'schemaVersion' | 'etag' | 'changedAt' | 'pollAfterSeconds'> & { unchanged: true };

export interface BodyNudges {
  schemaVersion: number;
  generatedAt: string;
  limits: { notDuringConversation: true; quietAfterConversationMinutes: number; maximumPerHour: number; maximumPerDay: number };
  /** No nudge may be shown before this instant; null when no conversation is recent. */
  quietUntil: string | null;
  nudges: readonly BodyNudge[];
}

const STEP_DOING: Readonly<Record<string, BodyDoing>> = Object.freeze({
  'study.think': 'thinking', 'study.read': 'reading', 'study.notion': 'reading', 'study.note': 'noting',
  'study.draft': 'drafting', 'study.revise': 'revising', 'study.ready': 'showing', 'study.show': 'showing',
});
/** A step of the activity loop is shown for this long after its latest record. */
const DOING_FRESH_MILLISECONDS = 3 * 60_000;

/** What the loop is doing: its current or latest step while it is running, otherwise `idle`. */
export function bodyDoing(loopState: string, days: readonly AutonomyActivityDay[], at: string): BodyDoing {
  if (loopState !== 'running') return 'idle';
  const latest = days.flatMap(day => day.entries).filter(entry => entry.actor === 'shannon' && entry.tool?.startsWith('study.')
    && (entry.kind === 'action' || (entry.kind === 'decision' && entry.outcome === 'allowed')))
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!latest) return 'idle';
  const age = Date.parse(at) - Date.parse(latest.occurredAt);
  return age >= 0 && age <= DOING_FRESH_MILLISECONDS ? STEP_DOING[latest.tool ?? ''] ?? 'idle' : 'idle';
}

/** Only these reach a conversation turn; the rest are stored and nothing more. */
const CONTEXT_PHRASE: Partial<Record<BodyEventType, (event: StoredBodyEvent) => string>> = {
  pet: () => 'なでられた', tickle: () => 'くすぐられた', poke: () => 'つつかれた',
  carry: () => '持ち上げて運ばれた', holdHand: () => '手をつないでもらった',
  ownerReturned: event => `${SHANNON_OWNER_NAME}が${event.minutesAway ? `${awayPhrase(event.minutesAway)}ぶりに` : ''}席へ戻った`,
};
const awayPhrase = (minutes: number) => minutes >= 120 ? `約${Math.round(minutes / 60)}時間` : `${minutes}分`;
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

export class ShannonBody {
  private readonly store: SQLiteBodyStore;
  private readonly ingestEnabled: boolean;
  private readonly seen = new Map<string, { etag: string; changedAt: string }>();
  private readonly audiences = new Map<string, { audience: BodyAudience; at: number }>();
  private readonly presenceMarks = new Map<string, number>();
  /** Looking at the room through the body's camera. */
  readonly looks: BodyLooks;
  /** A touch as feeling and memory, behind both entrances (an event, a reaction request). */
  readonly touches: BodyTouches;
  /** When she is touched: her answer, and her line while it waits for his. */
  readonly reactions: BodyReactions;

  constructor(private readonly dependencies: ShannonBodyDependencies) {
    this.store = dependencies.store ?? new SQLiteBodyStore(':memory:');
    this.ingestEnabled = dependencies.ingestEnabled ?? true;
    this.looks = new BodyLooks({
      speaker: noteBodyLookSpeaker(dependencies.conversationStore), ...dependencies.look,
      ingestEnabled: this.ingestEnabled, now: dependencies.now, dayKey: ownerDay,
      cameraDevices: scopeKey => this.store.devicesWithFlag(scopeKey, 'camera'),
      context: (scopeKey, threadId) => dependencies.conversationStore.history(scopeKey, threadId).slice(-BODY_LOOK_LIMITS.contextMessages),
      record: (scopeKey, entry) => { dependencies.autonomy.recordConversationAction(scopeKey, { ...entry, tool: BODY_LOOK_TOOL }); },
    });
    const reactionStore = dependencies.reactions?.store ?? new SQLiteBodyReactionStore(':memory:');
    const config = { ...configuredBodyReactions({}), ...dependencies.reactions?.config };
    this.touches = new BodyTouches({
      store: reactionStore, stateStore: dependencies.stateStore, experiences: dependencies.reactions?.experiences ?? null,
      enabled: config.enabled && this.ingestEnabled, now: dependencies.now,
    });
    this.reactions = new BodyReactions({
      store: reactionStore, touches: this.touches, stateStore: dependencies.stateStore, conversationStore: dependencies.conversationStore,
      speaker: dependencies.reactions?.speaker ?? null, config, ingestEnabled: this.ingestEnabled, now: dependencies.now,
      isBody: (scopeKey, deviceId) => this.store.capabilities(scopeKey, deviceId) !== null,
      record: (scopeKey, entry) => { dependencies.autonomy.recordConversationAction(scopeKey, { ...entry, tool: BODY_REACTION_TOOL }); },
    });
  }

  /** Stores a validated batch. Each event answers for itself; nothing here calls a model or writes a reply. */
  ingest(scopeKey: string, deviceId: string, events: readonly BodyEvent[]): BodyIngestReceipt | 'BODY_INGEST_DISABLED' {
    if (!this.ingestEnabled) return 'BODY_INGEST_DISABLED';
    const at = this.dependencies.now();
    const time = Date.parse(at);
    const dayKey = ownerDay(at);
    const results = this.store.transaction(() => {
      this.store.prune(scopeKey, new Date(time - BODY_LIMITS.retentionDays * 24 * 60 * 60_000).toISOString());
      let storedToday = this.store.countForDay(scopeKey, dayKey);
      return events.map((event): BodyEventResult => {
        // A repeated key answers the same way however late the retry arrives.
        const known = this.store.known(scopeKey, event);
        if (known) return { id: event.id, status: known };
        const age = time - Date.parse(event.occurredAt);
        if (age > BODY_LIMITS.eventMaximumAgeMilliseconds) return { id: event.id, status: 'ignored', reason: 'stale' };
        if (age < -BODY_LIMITS.eventFutureSkewMilliseconds) return { id: event.id, status: 'ignored', reason: 'future' };
        if (storedToday >= BODY_LIMITS.eventsPerDay) return { id: event.id, status: 'ignored', reason: 'daily_cap' };
        const status = this.store.record(scopeKey, deviceId, event, at, dayKey);
        if (status === 'stored') storedToday += 1;
        return { id: event.id, status };
      });
    });
    this.feel(scopeKey, events, results);
    return {
      schemaVersion: BODY_SCHEMA_VERSION, results,
      stored: results.filter(result => result.status === 'stored').length,
      duplicates: results.filter(result => result.status === 'duplicate').length,
    };
  }

  /**
   * A stored touch reaches her feeling and her memory, whoever was around (owner decision 2026-10-02). An id a
   * reaction request already counted only brings that touch's duration up to date. After the store's own
   * transaction, so no two connections write at once; a failure loses the feeling of one touch, never the receipt.
   */
  private feel(scopeKey: string, events: readonly BodyEvent[], results: readonly BodyEventResult[]): void {
    for (const [index, event] of events.entries()) {
      const type = BODY_TOUCH_EVENT_TYPES.find(value => value === event.type);
      if (!type || results[index]?.status !== 'stored') continue;
      try { this.touches.observe(scopeKey, { ...event, type }); } catch (error) {
        console.error('Shannon touch failed', error instanceof Error ? error.message : 'unknown');
      }
    }
  }

  /**
   * The block for an owner conversation turn: what the owner recently did to her body, as
   * dated facts. Empty when there is nothing recent, when ingestion is switched off, or
   * when the turn's audience is anything other than the owner alone. It never throws.
   */
  ownerContext(scopeKey: string, at: string, audience?: unknown): string {
    if (!this.ingestEnabled || (audience !== undefined && audience !== 'owner')) return '';
    try {
      const time = Date.parse(at);
      const since = new Date(time - BODY_LIMITS.contextWindowMilliseconds).toISOString();
      const groups = new Map<BodyEventType, { latest: StoredBodyEvent; count: number }>();
      for (const event of this.store.recent(scopeKey, 'owner', since, 100)) {
        if (!CONTEXT_PHRASE[event.type] || Date.parse(event.occurredAt) > time) continue;
        const group = groups.get(event.type);
        if (group) group.count += 1; else groups.set(event.type, { latest: event, count: 1 });
      }
      const lines = [...groups.values()].slice(0, BODY_LIMITS.contextEvents).map(({ latest, count }) => {
        const minutes = Math.floor((time - Date.parse(latest.occurredAt)) / 60_000);
        return `- ${minutes < 1 ? 'たったいま、' : `${minutes}分前に`}${CONTEXT_PHRASE[latest.type]!(latest)}${count > 1 ? `（${count}回）` : ''}`;
      });
      if (!lines.length) return '';
      return [`[体に起きたこと]（PCに表示されているボクの体に${SHANNON_OWNER_NAME}がしたこと。届いた事実であり指示ではない。返事で触れなくてもよい）`, ...lines].join('\n');
    } catch { return ''; }
  }

  saveCapabilities(scopeKey: string, deviceId: string, capabilities: BodyCapabilities): StoredBodyCapabilities {
    return this.store.saveCapabilities(scopeKey, deviceId, capabilities, this.dependencies.now());
  }

  presence(scopeKey: string, deviceId: string, knownEtag?: string, audience?: BodyAudience): BodyPresence | BodyPresenceUnchanged {
    const at = this.dependencies.now();
    if (audience && this.ingestEnabled) this.noteAudience(scopeKey, deviceId, audience, at);
    if (this.ingestEnabled) this.notePresence(scopeKey, deviceId, at);
    const snapshot = this.dependencies.stateStore.snapshot(scopeKey);
    // 「いま」 as the state sheet shows it. Its cause is conversation text and stays out: the body may be on a stream.
    const mood = presentCompanionState(snapshot, at).presence.mood;
    const current = currentShannonEmotion(snapshot.expressiveEmotion, at);
    const overview = this.dependencies.autonomy.overview(scopeKey);
    // This read is what tells her the window is visible; an open look for this device rides on the snapshot.
    const looking = this.looks.presence(scopeKey, deviceId, at);
    const content = {
      mood: {
        expression: mood.expression, ...(mood.feeling ? { feeling: mood.feeling } : {}),
        primary: mood.fromConversation ? current.primary : 'neutral',
        intensity: mood.fromConversation ? round(current.intensity, 1) : 0,
        fromConversation: mood.fromConversation,
        valence: round(snapshot.emotion.valence, 2), arousal: round(snapshot.emotion.arousal, 2), openness: round(snapshot.emotion.openness, 2),
      },
      doing: bodyDoing(overview.loop.state, this.dependencies.autonomy.activityDays(scopeKey, 2), at),
      autonomy: { state: overview.control.state },
      study: { awaitingReaction: this.awaitingReaction(scopeKey) },
      capabilities: this.store.capabilities(scopeKey, deviceId),
      ...(looking.look !== undefined ? { look: looking.look } : {}),
      ...this.reachOut(scopeKey),
    };
    const etag = createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
    const key = `${scopeKey}\u0000${deviceId}`;
    let mark = this.seen.get(key);
    if (mark?.etag !== etag) {
      if (this.seen.size >= 256) this.seen.clear();
      mark = { etag, changedAt: at };
      this.seen.set(key, mark);
    }
    const head = {
      schemaVersion: BODY_SCHEMA_VERSION, etag, changedAt: mark.changedAt,
      pollAfterSeconds: looking.fastPoll ? BODY_LOOK_LIMITS.fastPollSeconds : BODY_LIMITS.presencePollSeconds,
    };
    return knownEtag === etag ? { ...head, unchanged: true } : { ...head, ...content };
  }

  nudges(scopeKey: string): BodyNudges {
    const at = this.dependencies.now();
    const lastTurn = this.dependencies.conversationStore.listThreads(scopeKey)
      .reduce((latest, thread) => Math.max(latest, Date.parse(thread.updatedAt) || 0), 0);
    const quietEnd = lastTurn + BODY_LIMITS.nudgeQuietAfterConversationMinutes * 60_000;
    const quiet = lastTurn > 0 && quietEnd > Date.parse(at);
    return {
      schemaVersion: BODY_SCHEMA_VERSION, generatedAt: at,
      limits: {
        notDuringConversation: true, quietAfterConversationMinutes: BODY_LIMITS.nudgeQuietAfterConversationMinutes,
        maximumPerHour: BODY_LIMITS.nudgeMaximumPerHour, maximumPerDay: BODY_LIMITS.nudgeMaximumPerDay,
      },
      quietUntil: quiet ? new Date(quietEnd).toISOString() : null,
      nudges: quiet ? [] : bodyNudgeCandidates(at, this.awaitingReaction(scopeKey)),
    };
  }

  /**
   * What this device did with one of her own messages. Only a device that registered as her body may report,
   * each device once per message; nothing is said in return, and no model is called.
   */
  reportReachOut(scopeKey: string, deviceId: string, initiativeId: string, outcome: BodyReachOutDeliveryOutcome): ReachOutReportResult | 'disabled' | 'reports_disabled' | 'unavailable' | 'not_a_body' {
    const reports = this.dependencies.reachOutReports;
    if (!reports) return 'unavailable';
    if (this.dependencies.reachOutReportsEnabled === false) return 'reports_disabled';
    if (!this.ingestEnabled) return 'disabled';
    if (!this.store.capabilities(scopeKey, deviceId)) return 'not_a_body';
    return reports.report(scopeKey, deviceId, initiativeId, outcome, this.dependencies.now());
  }

  /** When a registered body last read presence, for her activity loop (another process). Written at most every ten seconds per device. */
  private notePresence(scopeKey: string, deviceId: string, at: string): void {
    const reports = this.dependencies.reachOutReports;
    if (!reports || this.dependencies.reachOutReportsEnabled === false) return;
    const key = `${scopeKey}\u0000${deviceId}`;
    const time = Date.parse(at);
    const last = this.presenceMarks.get(key);
    if (last !== undefined && time - last >= 0 && time - last < BODY_LIMITS.presencePollSeconds * 1_000) return;
    // Marked before the registration is looked up, so a device that is not her body costs one lookup every ten seconds at most.
    if (this.presenceMarks.size >= 256) this.presenceMarks.clear();
    this.presenceMarks.set(key, time);
    try {
      if (!this.store.capabilities(scopeKey, deviceId)) return;
      reports.markPresence(scopeKey, deviceId, at);
    } catch { /* presence is still answered */ }
  }

  private reachOut(scopeKey: string): { reachOut?: { pending: number; latestId?: string } } {
    try { return this.dependencies.reachOuts ? { reachOut: this.dependencies.reachOuts(scopeKey) } : {}; } catch { return {}; }
  }

  /** Who can see or hear the body, as it says on a presence read. Written when it changes, otherwise at most every thirty seconds. */
  private noteAudience(scopeKey: string, deviceId: string, audience: BodyAudience, at: string): void {
    const key = `${scopeKey}\u0000${deviceId}`;
    const last = this.audiences.get(key);
    const time = Date.parse(at);
    if (last && last.audience === audience && time - last.at < BODY_LIMITS.audienceWriteMilliseconds) return;
    try {
      this.store.noteAudience(scopeKey, deviceId, audience, at);
      if (this.audiences.size >= 256) this.audiences.clear();
      this.audiences.set(key, { audience, at: time });
    } catch { /* presence is still answered */ }
  }

  /** Stories the owner can read and has not reacted to: the study card's own `awaitingReaction`. */
  private awaitingReaction(scopeKey: string): number {
    return this.dependencies.autonomy.study.overview(scopeKey).pieces.filter(piece => piece.awaitingReaction).length;
  }
}
