import { createHash } from 'node:crypto';
import type { FcaTouchPort, FcaTouchResult } from '../../mind/action/reflex/fcaTouchPorts.js';
import { observeFcaTouch } from './fcaTouchIngress.js';
import { SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME, presentShannonFeeling, type CompanionStateStore } from '@shannon/cognition';
import type { ShannonAutonomyService } from '../../mind/action/ownTime/autonomyService.js';
import { BODY_LIMITS, BODY_SCHEMA_VERSION, BODY_TOUCH_EVENT_TYPES, BODY_TOUCH_VOCABULARY, isBodyGameEvent, isImpossibleTouch, type BodyAudience, type BodyCapabilities, type BodyEvent, type BodyEventType, type BodyReachOutDeliveryOutcome } from '../../contracts/bodyContract.js';
import { AppLooks, type AppLookOptions } from './appLook.js';
import { APP_LOOK_TOOL } from '../../mind/perception/appLookLines.js';
import { BODY_LOOK_TOOL, BodyLooks, type BodyLookOptions } from './bodyLook.js';
import { BODY_LOOK_LIMITS } from '../../contracts/bodyLookContract.js';
import { noteBodyLookSpeaker } from './store/bodyLookDelivery.js';
import { bodyNudgeCandidates } from './bodyNudges.js';
import { BodyReactions, type BodyReactionDependencies } from './bodyReaction.js';
import { BODY_REACTION_TOOL, configuredBodyReactions, type BodyReactionConfig } from '../../contracts/bodyReactionContract.js';
import type { BodyReactionSpeaker } from './bodyReactionModel.js';
import { SQLiteBodyReactionStore } from './store/bodyReactionStore.js';
import { BodyTouches, touchPredictionEnabled, type BodyTouchDependencies } from '../../mind/emotion/bodyTouch.js';
import { BODY_TOUCH_ONLY_FLAG, isFullBody, isTouchOnlyBody } from './bodyTouchOnly.js';
import { desktopBodyDeviceId, isDesktopBodyDeviceId } from '../../mind/inhibition/bodyIdentityPorts.js';
import { bodyPlace, bodySurfaceMark, factualTouchPhrase, touchPartPhrase, type BodySurface } from './bodyTouchWords.js';
import { isReflexPart } from './bodyTouchReflex.js';
import { ConversationLooks } from '../../mind/perception/conversationLooks.js';
import { OWNER_CALL_LIMITS, OwnerCalls, type OwnerCallDependencies, type OwnerCallSurface } from '../../mind/perception/perceptionPorts.js';
import type { TouchExperienceWriter } from '../../mind/memory/bodyTouchExperience.js';
import { gameDeathExperience, type GameExperienceWriter } from '../../mind/memory/memoryPorts.js';
import { SQLiteBodyStore, type StoredBodyCapabilities, type StoredBodyEvent } from './store/bodyStore.js';
import { presentCompanionState } from '../../mind/emotion/companionPresence.js';
import { ownerDay } from '@shannon/cognition';
import { emotionTiming } from '../../mind/emotion/emotionTiming.js';
import type { ConversationStore } from '../../mind/memory/memoryPorts.js';
import type { ReachOutReportResult, SQLiteReachOutReports } from '../../mind/attention/attentionPorts.js';
import { type BodyPresence, type BodyPresenceUnchanged, type BodyNudges, bodyDoing } from './bodyPresence.js';
import { innerNoteMood } from '../../mind/emotion/innerNotePorts.js';
export { type BodyPresence, type BodyPresenceUnchanged, type BodyNudges, bodyDoing } from './bodyPresence.js';

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
  fcaTouch?: () => FcaTouchPort | null;
  store?: SQLiteBodyStore;
  /** `SHANNON_BODY_INGEST`; unset means on. */
  ingestEnabled?: boolean;
  /** Looking at the room (`bodyLook.ts`): its table, switch and limits, the model call, and the way her message is delivered. */
  look?: BodyLookOptions;
  /** Looking through the camera of the app a turn came from (`appLook.ts`): its table and switch, the model call, and where her message is stored. */
  appLook?: AppLookOptions;
  /** Messages she started on her own that the owner has not read (`reachOutDelivery.ts`); absent, presence has no `reachOut`. */
  reachOuts?: (scopeKey: string, deviceId: string) => { pending: number; latestId?: string };
  /** What the body did with a message of hers, and when it last read presence (`reachOutReports.ts`); absent, the report route answers 404. */
  reachOutReports?: Pick<SQLiteReachOutReports, 'report' | 'markPresence'>;
  /** `SHANNON_AUTONOMY_MAX_FOLLOW_UPS` above zero. Off, no report is taken and no presence read is noted for the loop. Unset means on. */
  reachOutReportsEnabled?: boolean;
  /** When she is touched (`bodyReaction.ts`): its tables, switch and timings, the fast model, and where a touch becomes an experience. */
  reactions?: { store?: SQLiteBodyReactionStore; config?: Partial<BodyReactionConfig>; speaker?: BodyReactionSpeaker | null; experiences?: TouchExperienceWriter | null; prediction?: BodyTouchDependencies['prediction']; stage2?: BodyTouchDependencies['stage2']; ledger?: BodyTouchDependencies['ledger']; mind?: BodyReactionDependencies['mind'] }; // mind: Syzygy ADR-0008 stage 3.
  /**
   * Whether the owner is in a call on another device (`ownerCallElsewhere.ts`): `enabled` is `SHANNON_OWNER_CALL_ELSEWHERE`
   * (unset means on); `surface` says which app a device is (default: her body's registration only).
   */
  ownerCalls?: { enabled?: boolean; surface?: (scopeKey: string, deviceId: string) => OwnerCallSurface | undefined; answered?: OwnerCallDependencies['answered'] };
  /**
   * Her Minecraft body (`docs/minecraft-body-contract.md`): the one device whose game events are taken, in the owner's
   * scope only, and where they become experiences. Absent, every game event is ignored. That device reports nothing else.
   */
  game?: { deviceId: string; ownerScopeKey: string; experiences?: GameExperienceWriter | null } | null;
}

export interface ShannonBodyDependencies extends ShannonBodyOptions {
  stateStore: CompanionStateStore;
  autonomy: ShannonAutonomyService;
  conversationStore: ConversationStore;
  now: () => string;
}

export type BodyEventResult =
  | { id: string; status: 'stored' | 'duplicate' | 'conflict' }
  | { id: string; status: 'ignored'; reason: 'stale' | 'future' | 'daily_cap' | 'touch_only' | 'not_game_body' | 'game_only' | 'not_a_touch' };

export interface BodyIngestReceipt {
  schemaVersion: number;
  stored: number;
  duplicates: number;
  results: readonly BodyEventResult[];
}

/** Only these reach a conversation turn; the rest are stored and nothing more. */
const CONTEXT_PHRASE: Partial<Record<BodyEventType, (event: StoredBodyEvent) => string>> = {
  pet: () => 'なでられた', tickle: () => 'くすぐられた', poke: () => 'つつかれた',
  carry: () => '持ち上げて運ばれた', holdHand: () => '手をつないでもらった',
  ownerReturned: event => `${SHANNON_OWNER_NAME}が${event.minutesAway ? `${awayPhrase(event.minutesAway)}ぶりに` : ''}席へ戻った`,
};
/** What a touch-only body may report besides a touch: the start and end of a call on that device (added 2026-10-05). */
const TOUCH_ONLY_ALSO: ReadonlySet<string> = new Set(['callStarted', 'callEnded']);
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
  /** Looking through the camera of the owner's app, in the turn that came from it. */
  readonly appLooks: AppLooks;
  /** What a conversation turn is told about looking, whichever camera it is (`conversationLooks.ts`). */
  readonly turnLooks: ConversationLooks;
  /** A touch as feeling and memory, behind both entrances (an event, a reaction request). */
  readonly touches: BodyTouches;
  /** When she is touched: her answer, and her line while it waits for his. */
  readonly reactions: BodyReactions;
  /** The owner in a call on another device: the presence field, and the refusal of a voice request from her body. */
  readonly ownerCalls: OwnerCalls;

  constructor(private readonly dependencies: ShannonBodyDependencies) {
    this.store = dependencies.store ?? new SQLiteBodyStore(':memory:');
    this.ingestEnabled = dependencies.ingestEnabled ?? true;
    this.looks = new BodyLooks({
      speaker: noteBodyLookSpeaker(dependencies.conversationStore), ...dependencies.look,
      ingestEnabled: this.ingestEnabled, now: dependencies.now, dayKey: ownerDay,
      cameraDevices: scopeKey => this.store.devicesWithFlag(scopeKey, 'camera'), bodyDevices: scopeKey => this.fullBodies(scopeKey),
      context: (scopeKey, threadId) => dependencies.conversationStore.history(scopeKey, threadId).slice(-BODY_LOOK_LIMITS.contextMessages),
      record: (scopeKey, entry) => { dependencies.autonomy.recordConversationAction(scopeKey, { ...entry, tool: BODY_LOOK_TOOL }); },
    });
    const context = (scopeKey: string, threadId: string) => dependencies.conversationStore.history(scopeKey, threadId).slice(-BODY_LOOK_LIMITS.contextMessages);
    this.appLooks = new AppLooks({
      speaker: noteBodyLookSpeaker(dependencies.conversationStore), viewer: dependencies.look?.viewer ?? null, ...dependencies.appLook,
      now: dependencies.now, context,
      record: (scopeKey, entry) => { dependencies.autonomy.recordConversationAction(scopeKey, { ...entry, tool: APP_LOOK_TOOL }); },
    });
    this.turnLooks = new ConversationLooks(this.looks, this.appLooks);
    const reactionStore = dependencies.reactions?.store ?? new SQLiteBodyReactionStore(':memory:');
    const config = { ...configuredBodyReactions({}), ...dependencies.reactions?.config };
    this.touches = new BodyTouches({
      store: reactionStore, stateStore: dependencies.stateStore, experiences: dependencies.reactions?.experiences ?? null,
      enabled: config.enabled && this.ingestEnabled, now: dependencies.now, ...(dependencies.reactions?.prediction !== undefined ? { prediction: dependencies.reactions.prediction } : {}), ledger: dependencies.reactions?.ledger ?? null,
      stage2: dependencies.reactions?.stage2 ?? touchPredictionEnabled(), // ADR-0006 stage 2: `SHANNON_PREDICTION`
    });
    this.reactions = new BodyReactions({
      store: reactionStore, touches: this.touches, stateStore: dependencies.stateStore, conversationStore: dependencies.conversationStore,
      speaker: dependencies.reactions?.speaker ?? null, config, ingestEnabled: this.ingestEnabled, now: dependencies.now,
      // Her Minecraft body is never a body that is touched (`docs/minecraft-body-contract.md`).
      isBody: (scopeKey, deviceId) => !this.isGameBody(deviceId) && this.store.capabilities(scopeKey, deviceId) !== null,
      surface: (scopeKey, deviceId) => this.store.surface(scopeKey, deviceId),
      contact: (scope, device, request, felt) => this.contact(scope, device, request.id, request.occurredAt, request.audience, request.touch, felt),
      reacted: (scope, device, id, result) => this.dependencies.fcaTouch?.()?.reacted(scope, device, id, result),
      record: (scopeKey, entry) => { dependencies.autonomy.recordConversationAction(scopeKey, { ...entry, tool: BODY_REACTION_TOOL }); }, ...(dependencies.reactions?.mind ? { mind: dependencies.reactions.mind } : {}),
    });
    const bodySurface = (scopeKey: string, deviceId: string): OwnerCallSurface | undefined => {
      const surface = this.store.surface(scopeKey, deviceId);
      return surface === 'iphone' ? 'ios' : surface === 'mac' ? 'mac' : undefined;
    };
    this.ownerCalls = new OwnerCalls({
      ...(dependencies.ownerCalls?.enabled !== undefined ? { enabled: dependencies.ownerCalls.enabled } : {}),
      // Her Minecraft body is never "the call elsewhere" nor a full body a 409 is for (it can report no call: `game_only`).
      events: (scopeKey, since, until) => this.store.callEvents(scopeKey, since, until).filter(event => !this.isGameBody(event.deviceId)),
      isFullBody: (scopeKey, deviceId) => this.isFullBodyDevice(scopeKey, deviceId),
      surface: dependencies.ownerCalls?.surface ?? bodySurface,
      ...(dependencies.ownerCalls?.answered ? { answered: dependencies.ownerCalls.answered } : {}),
    });
  }

  /** Stores a validated batch. Each event answers for itself; nothing here calls a model or writes a reply. */
  ingest(scopeKey: string, deviceId: string, events: readonly BodyEvent[]): BodyIngestReceipt | 'BODY_INGEST_DISABLED' {
    if (!this.ingestEnabled) return 'BODY_INGEST_DISABLED';
    const at = this.dependencies.now();
    const time = Date.parse(at);
    const dayKey = ownerDay(at);
    // A body that only feels touch has nothing else to report of the PC: its other events (away, returned, window…) are not taken.
    // Its own calls are facts about the phone, and tell another body that he is in a call there (`ownerCallElsewhere.ts`).
    const touchOnly = isTouchOnlyBody(this.store.capabilities(scopeKey, deviceId));
    // Game events come from her Minecraft body alone, and that body reports nothing else.
    const game = this.dependencies.game;
    // Its desktop-body identity (`desktopBodyIdentity.ts`) is the game body too, and may report no game event.
    const gameBody = this.isGameBody(deviceId);
    const gameAllowed = Boolean(game && game.deviceId === deviceId && game.ownerScopeKey === scopeKey);
    const results = this.store.transaction(() => {
      this.store.prune(scopeKey, new Date(time - BODY_LIMITS.retentionDays * 24 * 60 * 60_000).toISOString());
      let storedToday = this.store.countForDay(scopeKey, dayKey);
      return events.map((event): BodyEventResult => {
        // A repeated key answers the same way however late the retry arrives.
        if (touchOnly && !BODY_TOUCH_EVENT_TYPES.some(type => type === event.type) && !TOUCH_ONLY_ALSO.has(event.type)) return { id: event.id, status: 'ignored', reason: 'touch_only' };
        if (isBodyGameEvent(event.type) && !gameAllowed) return { id: event.id, status: 'ignored', reason: 'not_game_body' };
        if (!isBodyGameEvent(event.type) && gameBody) return { id: event.id, status: 'ignored', reason: 'game_only' };
        // Holding anything but the hand, or a hover anywhere but the head and the hair: this one item only, never the batch.
        if (isImpossibleTouch(event)) return { id: event.id, status: 'ignored', reason: 'not_a_touch' };
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
    this.feel(scopeKey, deviceId, events, results, this.store.surface(scopeKey, deviceId));
    if (gameAllowed) this.rememberGame(scopeKey, deviceId, events, results);
    return {
      schemaVersion: BODY_SCHEMA_VERSION, results,
      stored: results.filter(result => result.status === 'stored').length,
      duplicates: results.filter(result => result.status === 'duplicate').length,
    };
  }

  /**
   * Whether a touch event of the `[体に起きたこと]` block is told factually (体に触れられた) rather than in its usual words
   * (Syzygy ADR-0005 stage 1b): touch vocabulary 2 kept a part for its id (`body_touches`, the same id), and it is a part
   * where her body flinches first, or it is a hand resting anywhere but the hand. A touch without such a row (the old
   * shape) is told as it always was.
   */
  private factualTouch(scopeKey: string, event: StoredBodyEvent): boolean {
    if (event.type !== 'pet' && event.type !== 'holdHand') return false;
    try {
      const part = this.touches.detail(scopeKey, event.id)?.part;
      if (!part) return false;
      return isReflexPart(part) || (event.type === 'holdHand' && part !== 'hand');
    } catch { return false; }
  }

  /**
   * A stored touch reaches her feeling and her memory, whoever was around (owner decision 2026-10-02). An id a
   * reaction request already counted only brings that touch's duration up to date. After the store's own
   * transaction, so no two connections write at once; a failure loses the feeling of one touch, never the receipt.
   */
  private feel(scopeKey: string, deviceId: string, events: readonly BodyEvent[], results: readonly BodyEventResult[], surface: BodySurface | undefined): void {
    for (const [index, event] of events.entries()) {
      const type = BODY_TOUCH_EVENT_TYPES.find(value => value === event.type);
      if (!type || results[index]?.status !== 'stored') continue;
      try { const felt = this.touches.observe(scopeKey, { ...event, type, ...(surface ? { surface } : {}) });
        if (felt) this.contact(scopeKey, deviceId, event.id, event.occurredAt, event.audience, { ...event, type }, felt);
      } catch (error) {
        console.error('Shannon touch failed', error instanceof Error ? error.message : 'unknown');
      }
    }
  }
  private contact(scope: string, device: string, id: string, at: string, audience: 'owner' | 'others',
    touch: import('../../mind/action/reflex/fcaTouchPorts.js').FcaTouchInput['touch'], felt: import('../../mind/emotion/bodyTouch.js').FeltTouch) {
    const caps = this.store.capabilities(scope, device);
    if (caps?.flags.fcaTouchV1 !== true || this.isGameBody(device)) return;
    const stances = audience === 'owner' && (touch.part || touch.region) ? this.touches.stanceSources(scope, (touch.part ?? touch.region)!, felt.snapshot, at) : [];
    observeFcaTouch(this.dependencies.fcaTouch?.(), { scopeKey: scope, deviceId: device, touchId: id, observedAt: at, audience,
      touch: { type: touch.type, part: touch.part, region: touch.region, side: touch.side, gesture: touch.gesture, reflex: touch.reflex }, felt, gestures: caps.gestures,
      stances: stances.map(row => row.stance), stanceSourceIds: stances.map(row => row.burstId) });
  }
  touchReflexAllowed(scope: string, device: string, gesture?: string): boolean {
    const caps = this.store.capabilities(scope, device);
    return this.ingestEnabled && this.reactions.enabled && !this.isGameBody(device) && caps?.flags.fcaTouchV1 === true && (!gesture || caps.gestures.includes(gesture));
  }
  claimTouchReflex(scope: string, device: string, id: string) { return this.dependencies.fcaTouch?.()?.claim(scope, device, id) ?? Promise.resolve(null); }
  reportTouchReflex(scope: string, device: string, id: string, result: FcaTouchResult) { return this.dependencies.fcaTouch?.()?.report(scope, device, id, result) ?? Promise.resolve(false); }

  /**
   * A stored game event becomes an experience in the server's words (phase 1: dying). After the store's own
   * transaction, as a touch; a failure loses the memory of one event, never the receipt. No feeling moves yet.
   */
  private rememberGame(scopeKey: string, deviceId: string, events: readonly BodyEvent[], results: readonly BodyEventResult[]): void {
    const writer = this.dependencies.game?.experiences;
    if (!writer) return;
    for (const [index, event] of events.entries()) {
      if (event.type !== 'game.died' || !event.cause || results[index]?.status !== 'stored') continue;
      try { writer.write(scopeKey, gameDeathExperience(scopeKey, deviceId, { ...event, cause: event.cause })); } catch (error) {
        console.error('Shannon game memory failed', error instanceof Error ? error.message : 'unknown');
      }
    }
  }

  /** True while the body last told the server that someone other than the owner can see or hear it. Throws when it cannot be read. */
  othersPresent(scopeKey: string, at: string): boolean {
    // Her Minecraft body adds nothing here: its game events are left out (`bodyStore.ts`), it may report no other event
    // (`game_only`), its presence reads note no audience, and it can register no capabilities to stand in as a body.
    return this.store.othersPresent(scopeKey, at, BODY_LIMITS.audienceFreshMilliseconds, BODY_LIMITS.audienceEventWindowMilliseconds);
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
      // Where the body of an event was, as its device registered.
      const surfaces = new Map<string, BodySurface | undefined>();
      const surfaceOf = (event: StoredBodyEvent) => {
        if (!surfaces.has(event.deviceId)) surfaces.set(event.deviceId, this.store.surface(scopeKey, event.deviceId));
        return surfaces.get(event.deviceId);
      };
      // One line per way of touching, part and surface: a count never puts one touch's part or place on another's.
      const groups = new Map<string, { latest: StoredBodyEvent; count: number; factual: boolean }>();
      for (const event of this.store.recent(scopeKey, 'owner', since, 100)) {
        if (!CONTEXT_PHRASE[event.type] || Date.parse(event.occurredAt) > time) continue;
        const factual = this.factualTouch(scopeKey, event);
        const key = `${event.type}\u0000${event.region ?? ''}\u0000${surfaceOf(event) ?? ''}${factual ? '\u0000factual' : ''}`;
        const group = groups.get(key);
        if (group) group.count += 1; else groups.set(key, { latest: event, count: 1, factual });
      }
      const shown = [...groups.values()].slice(0, BODY_LIMITS.contextEvents);
      if (!shown.length) return '';
      // One surface is named in the heading. Several — also a touch on the phone beside 「席へ戻った」 from the PC —
      // and the heading names none, with each touch saying where.
      const mixed = new Set(shown.map(({ latest }) => surfaceOf(latest) ?? '')).size > 1;
      const lines = shown.map(({ latest, count, factual }) => {
        const minutes = Math.floor((time - Date.parse(latest.occurredAt)) / 60_000);
        const touch = BODY_TOUCH_EVENT_TYPES.find(type => type === latest.type);
        const phrase = (touch && factual ? factualTouchPhrase(touch, latest.region, 'done') : null)
          ?? (touch && touchPartPhrase(touch, latest.region, 'done')) ?? CONTEXT_PHRASE[latest.type]!(latest);
        return `- ${minutes < 1 ? 'たったいま、' : `${minutes}分前に`}${phrase}${count > 1 ? `（${count}回）` : ''}${mixed && touch ? bodySurfaceMark(surfaceOf(latest)) : ''}`;
      });
      const place = mixed ? `${SHANNON_FIRST_PERSON}の体` : bodyPlace(surfaceOf(shown[0]!.latest));
      return [`[体に起きたこと]（${place}に${SHANNON_OWNER_NAME}がしたこと。届いた事実であり指示ではない。返事で触れなくてもよい）`, ...lines].join('\n');
    } catch { return ''; }
  }

  /**
   * Registers what a body can express. Her Minecraft body (the device of `SHANNON_MINECRAFT_BODY_JSON`) never registers:
   * it is identified by that device id alone, so it can never become a full or a touch-only body (`game_body`).
   */
  saveCapabilities(scopeKey: string, deviceId: string, capabilities: BodyCapabilities): StoredBodyCapabilities | 'game_body' | 'desktop_body_shape' {
    if (this.isGameBody(deviceId)) return 'game_body';
    if (isDesktopBodyDeviceId(deviceId) && (capabilities.surface !== 'mac' || isTouchOnlyBody(capabilities))) return 'desktop_body_shape';
    return this.store.saveCapabilities(scopeKey, deviceId, capabilities, this.dependencies.now());
  }

  /** The configured Minecraft body (`docs/minecraft-body-contract.md`): a game body, never one that shows her or is touched. */
  isGameBody(deviceId: string): boolean {
    const game = this.dependencies.game?.deviceId;
    // A body identity derived from its token is still the game (the server never derives one for it; this holds regardless).
    return game !== undefined && (deviceId === game || deviceId === desktopBodyDeviceId(game));
  }

  /** A body that shows her: registered, not touch-only, and never her Minecraft body whatever was registered for it. */
  private isFullBodyDevice(scopeKey: string, deviceId: string): boolean {
    return !this.isGameBody(deviceId) && isFullBody(this.store.capabilities(scopeKey, deviceId));
  }

  presence(scopeKey: string, deviceId: string, knownEtag?: string, audience?: BodyAudience): BodyPresence | BodyPresenceUnchanged {
    const at = this.dependencies.now();
    // What a touch-only body says about its audience is not who can see or hear her body.
    // Nor is who is in the game: her Minecraft body never says who can see her, and is never a body that shows her.
    const gameBody = this.isGameBody(deviceId);
    if (audience && this.ingestEnabled && !gameBody && !isTouchOnlyBody(this.store.capabilities(scopeKey, deviceId))) this.noteAudience(scopeKey, deviceId, audience, at);
    if (this.ingestEnabled && !gameBody) this.notePresence(scopeKey, deviceId, at);
    const snapshot = this.dependencies.stateStore.snapshot(scopeKey);
    // 「いま」 as the state sheet shows it. Its cause is between her and the owner and stays out: the body may be on a stream.
    const mood = presentCompanionState(snapshot, at).presence.mood;
    const current = presentShannonFeeling(snapshot, at, emotionTiming());
    const overview = this.dependencies.autonomy.overview(scopeKey);
    // This read is what tells her the window is visible; an open look for this device rides on the snapshot.
    const looking = this.looks.presence(scopeKey, deviceId, at);
    const content = {
      mood: innerNoteMood(this.reactions.innerNote, scopeKey, at, { // Syzygy ADR-0012: while her inner note is active, the face it shows.
        expression: mood.expression, ...(mood.feeling ? { feeling: mood.feeling } : {}),
        primary: mood.fromConversation ? current.primary : 'neutral',
        intensity: mood.fromConversation ? round(current.intensity, 1) : 0,
        fromConversation: mood.fromConversation,
        valence: round(snapshot.emotion.valence, 2), arousal: round(snapshot.emotion.arousal, 2), openness: round(snapshot.emotion.openness, 2),
      }),
      doing: bodyDoing(overview.loop.state, this.dependencies.autonomy.activityDays(scopeKey, 2), at),
      autonomy: { state: overview.control.state },
      study: { awaitingReaction: this.awaitingReaction(scopeKey) },
      capabilities: this.store.capabilities(scopeKey, deviceId),
      ...(looking.look !== undefined ? { look: looking.look } : {}),
      ...this.reachOut(scopeKey, deviceId),
      ...(this.ownerCalls.enabled ? { ownerCallElsewhere: this.ownerCalls.elsewhere(scopeKey, deviceId, at) } : {}),
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
      pollAfterSeconds: Math.min(looking.fastPoll ? BODY_LOOK_LIMITS.fastPollSeconds : BODY_LIMITS.presencePollSeconds,
        content.ownerCallElsewhere?.active ? OWNER_CALL_LIMITS.pollSeconds : Number.POSITIVE_INFINITY),
      // A fact of this server, not of the snapshot: outside the etag, and on an unchanged answer too.
      touchVocabulary: BODY_TOUCH_VOCABULARY,
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
    if (!this.isFullBodyDevice(scopeKey, deviceId)) return 'not_a_body';
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
      if (!this.isFullBodyDevice(scopeKey, deviceId)) return;
      reports.markPresence(scopeKey, deviceId, at);
    } catch { /* presence is still answered */ }
  }

  /** Bodies that show her: every registration except one that only feels touch (`bodyTouchOnly.ts`). */
  private fullBodies(scopeKey: string): readonly string[] {
    const touchOnly = new Set(this.store.devicesWithFlag(scopeKey, BODY_TOUCH_ONLY_FLAG));
    return this.store.devices(scopeKey).filter(deviceId => !touchOnly.has(deviceId) && !this.isGameBody(deviceId));
  }

  private reachOut(scopeKey: string, deviceId: string): { reachOut?: { pending: number; latestId?: string } } {
    try { return this.dependencies.reachOuts ? { reachOut: this.dependencies.reachOuts(scopeKey, deviceId) } : {}; } catch { return {}; }
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
