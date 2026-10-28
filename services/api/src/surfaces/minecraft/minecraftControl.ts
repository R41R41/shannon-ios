import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { WorkingEventLog, type ActionLease, type WorkingEvent } from '@shannon/mind';
import type { MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt, MinecraftControlReply, MinecraftLiveRoom, MinecraftLiveSpeech,
  MinecraftLiveSpeechReceipt, MinecraftQueueEnvelope, MinecraftQueueProgress } from '../../contracts/minecraftControlContract.js';
import { deathBetween, unitFromOutcome, type DeathCounter, type OperationState } from '../../contracts/continueContract.js';
import type { UsesSnapshot } from './minecraftLlmcPromises.js';
import { MinecraftControlStore, type OperationRow } from './store/minecraftControlStore.js';
import { validControlPoll } from './minecraftControlValidation.js';
import { headBoot as thisHeadBoot } from './minecraftHeadBoot.js';
import { cleanupOperations, fetchEventPages, type CleanupOutcome, type RecoveryPort } from './minecraftControlRecovery.js';
import { noteBodyCommand } from '../../infra/decisionRecords/decisionRecordNotes.js';

interface Frame { poll: MinecraftControlPoll; received: number }
export type ArrivalKind = 'login' | 'death' | 'reconnect' | 'dimension';
const dimensionOf = (observation: BodyObservation) => {
  const world = (observation.state as { world?: { dimension?: unknown } } | undefined)?.world;
  const value = observation.facts.dimension ?? world?.dimension;
  return typeof value === 'string' ? value.replace(/^minecraft:/u, '') : null;
};
/** The observation's death counter (`state.life`'s `deathEpoch` and `deathSeq`), or an empty one when it has none (`deathBetween` then reads no death). */
const deathCounterOf = (observation: BodyObservation): { deathEpoch?: unknown; deathSeq?: unknown } =>
  (observation.state as { life?: { deathEpoch?: unknown; deathSeq?: unknown } } | undefined)?.life ?? {};
/**
 * Whether a frame is an arrival after `old` (null: the first), and of what kind; null when the body is where it was. Continue contract 5: a death is a rise of `deathSeq` within
 * one `deathEpoch` (`death`, from `deathBetween`), never the life number alone nor a change of epoch (the file made again: the pack is whole); the body coming up alive again after
 * it is the same death, and a dimension it comes up in is the death's, not a portal's.
 */
export function arrivalOf(old: BodyObservation | undefined, now: BodyObservation, newConnection: boolean, death: boolean): ArrivalKind | null {
  if (!old) return 'login';
  if (death) return 'death';
  if (newConnection || (!old.connected && now.connected)) return 'reconnect';
  if (old.facts.alive === false) return null;
  const [before, after] = [dimensionOf(old), dimensionOf(now)];
  return before !== null && after !== null && before !== after ? 'dimension' : null;
}
/** After a capture of this connection came back without a picture, short visual control is not offered for this long. */
export const MINECRAFT_CAPTURE_RETRY_MILLISECONDS = 10 * 60_000;
/** A body's first frames after a login, a new connection or a respawn: its facts (health, threats) are not settled yet. */
export const MINECRAFT_SPAWN_GRACE_MILLISECONDS = 10_000;
/** A wait step that took this much longer than asked means the API's thread was blocked (a stall), not that time passed for the body. */
export const MINECRAFT_STALL_MILLISECONDS = 250;
/** How long a newer connection must be silent before a connection it replaced is taken again (`retiredConnection`). */
export const MINECRAFT_RETIRED_CONNECTION_MS = 5_000;
/** The receipts a body sends in one poll at most (`controlLoop.ts`): a fuller list may leave one out. */
const RECEIPTS_PER_POLL = 16;
/** One command being waited for: when the wait gave it up, so the next poll cancels it (`command`). */
interface Waiting { expired: boolean }
/** Commands of the task queue one reply hands over at most (the body takes them in order; one runs and two wait). */
const QUEUE_COMMANDS_PER_REPLY = 3;
/** What a command is made from (`command`, `enqueue`). */
export interface ControlCommandInput { id: string; context: BodyTaskContext; lease: ActionLease; kind: MinecraftControlCommand['kind'];
  skill?: string; arguments?: Readonly<Record<string, unknown>>; operation?: MinecraftControlCommand['operation']; stop?: MinecraftControlCommand['stop'];
  milliseconds?: number; queue?: MinecraftQueueEnvelope;
  /** Continue contract 3: the definitions of the promises the act says it uses, as they are when it is sent; kept with the command. */
  uses?: readonly UsesSnapshot[];
  /** Run 45's resume: the command this one sends again (kept with the command, so a result can say it is that one's second try). */
  resumeOf?: string }
/** What a receipt did to a command's result state, told to the listeners (the queue reads its items' results from the store, not from the order they came in). */
export interface SettledEvent { id: string; command: MinecraftControlCommand; receipt: MinecraftControlReceipt; from: OperationState | null; to: OperationState }
/** A command released without a receipt of its own (the cleanup or the new connection proved it), or held for the operator. */
export interface ReleasedEvent { row: OperationRow; by: 'cleanup' | 'reconnect' }
const ioTurn = () => new Promise<void>(resolve => setImmediate(resolve));
/** A paired body supplies observations and executes exact commands; the shared FCA owns all long-term decisions. */
/** A release that names a hold to end (`context.incident.resume` or `cancel`, run 44). */
function namesHold(context: { incident?: { resume?: unknown; cancel?: unknown } } | undefined): boolean {
  return typeof context?.incident?.resume === 'string' && context.incident.resume.length > 0
    || typeof context?.incident?.cancel === 'string' && context.incident.cancel.length > 0;
}

export class MinecraftControl {
  readonly frames = new Map<string, Frame>();
  private readonly images = new Map<string, { dataUrl: string; expires: number }>();
  private readonly captureMisses = new Map<string, { connectionId: string; at: number }>();
  /** Per body, the connections a newer one replaced (the last 16). */
  private readonly retired = new Map<string, string[]>();
  /**
   * A poll from a connection a newer one replaced, while the newer one is alive: refused. A body process kept from run to run may
   * keep an earlier loop polling (practice ground, 2026-10-20); taking each connection's frame in turn swapped the catalog under a
   * step (FCA_BODY_CATALOG_CHANGED). A new connection retires the one before it. A retired one is taken again only while the newer one
   * has been silent for `MINECRAFT_RETIRED_CONNECTION_MS`, and then as a stand-in: it stays retired and retires nobody, so the newer
   * one's next poll is taken again (an API stall of a few seconds must not hand the body to a leftover loop for good).
   */
  private retiredConnection(bodyId: string, old: { poll: { connectionId: string }; received: number } | undefined, connectionId: string): boolean {
    if (!old || old.poll.connectionId === connectionId) return false;
    const retired = this.retired.get(bodyId) ?? [];
    if (retired.includes(connectionId)) {
      const refused = this.options.now() - old.received < MINECRAFT_RETIRED_CONNECTION_MS;
      if (refused) this.tellRetired(bodyId, connectionId);
      return refused;
    }
    this.retired.set(bodyId, [...retired.filter(id => id !== old.poll.connectionId), old.poll.connectionId].slice(-16));
    return false;
  }
  private readonly retiredTold = new Map<string, number>();
  /** One line a connection at most every 30 s: the route answers a refused poll with a bare 400. */
  private tellRetired(bodyId: string, connectionId: string): void {
    const at = this.options.now();
    if (at - (this.retiredTold.get(connectionId) ?? -Infinity) < 30_000) return;
    this.retiredTold.set(connectionId, at);
    if (this.retiredTold.size > 64) this.retiredTold.delete(this.retiredTold.keys().next().value as string);
    console.info(`Shannon Minecraft body poll refused body=${bodyId} connection=${connectionId.slice(0, 12)} reason=retired`);
  }
  /** When each body last arrived: a new connection, connected again, or alive again (`settling`). */
  private readonly arrivals = new Map<string, number>();
  private readonly arrivalKinds = new Map<string, ArrivalKind>();
  /** The head's memory of each body's death counter (continue contract 5): a death is only a rise of `deathSeq` within one `deathEpoch`. */
  private readonly deaths = new Map<string, DeathCounter>();
  /** Told when a body on the same connection is seen alive and then dead (its facts' `alive` turns false). Listeners never throw. */
  readonly deathListeners = new Set<(bodyId: string) => void>();
  /** Told each frame, and each batch of the body's events as they are taken (MinecraftLive, session dc-live). Never throw into a poll. */
  readonly frameListeners = new Set<(bodyId: string, observation: BodyObservation, arrival: { newConnection: boolean }) => void>();
  readonly eventListeners = new Set<(bodyId: string, events: readonly WorkingEvent[]) => void>();
  /** Told when a receipt moves a command's result state (a first receipt, an unknown one, a correction), after the store has it and before it is acknowledged. */
  readonly settledListeners = new Set<(event: SettledEvent) => void>();
  /** Told when a command is released without a receipt of its own, and when a cleanup leaves one held (continue contract 1). Listeners never throw. */
  readonly releasedListeners = new Set<(event: ReleasedEvent) => void>();
  readonly heldListeners = new Set<(event: { row: OperationRow; why: string }) => void>();
  /** Told once for each connection of a body when this start of the head first answers it (the body registers the head's boot from that reply). */
  readonly headBootListeners = new Set<(event: { bodyId: string; connectionId: string; headBoot: string }) => void>();
  private readonly headBootTold = new Map<string, string>();
  /** Her lines for the room (LiveSpeechOutbox, session dc-live): the reply carries the one due, a poll brings the body's answers. */
  speech: { take(): MinecraftLiveSpeech[]; receive(receipts: readonly MinecraftLiveSpeechReceipt[], room: MinecraftLiveRoom | null): void } | null = null;
  /** The commands this process waits for, and when each was last handed to the body (`command`). */
  private readonly waiting = new Map<string, Waiting>();
  private readonly deliveries = new Map<string, number>();
  /** When a poll last listed a command waiting in the body's queue: its time to run counts from then, not while it waits (`receiptOf`). */
  private readonly queuedAt = new Map<string, number>();
  /**
   * What each body told while it worked (session mb-arch, stage 1): needs in reach, each command's progress, stalls. Kept here, in
   * memory, per body; the task's arbiter reads it (working). Taking them costs nothing when no one reads them.
   */
  private readonly workingLogs = new Map<string, WorkingEventLog>();
  constructor(readonly store: MinecraftControlStore, readonly configuration: MinecraftBodyConfiguration,
    private readonly options: { now(): number; leaseValid(lease: ActionLease, taskId: string): boolean; ownerAlone(): boolean; leaseKnown?(lease: ActionLease, taskId: string): boolean; pollMilliseconds?: number; cancelWaitMilliseconds?: number;
      /**
       * Run 44, resume 1: whether the lease is one the task's step ever held (any state). A release naming a hold (`context.incident.resume` or
       * `cancel`) is sent with the held act's lease, whose step the hold stopped: it ends the hold and releases, and moves nothing else.
       */
      leaseAttempted?(lease: ActionLease, taskId: string): boolean;
      /** How long a frame stays current (3 s); tests shorten it. */
      frameMilliseconds?: number;
      /** This start of the head (continue contract 2); the process's own by default. */
      headBoot?: string }) {}
  /** This start of the head. */
  headBoot(): string { return this.options.headBoot ?? thisHeadBoot(); }
  /**
   * The command that makes a new command which moves the body wait (continue contract 1): one whose result is unknown and whose release is not proved, one of an earlier
   * start of the head still open, a hold the operator has not ended. Null: a motor command may be sent. Observation commands are never held back.
   */
  motorBlocked(taskId: string): OperationRow | null { return this.store.motorBlock(taskId, this.headBoot()); }
  private recoveryPort(): RecoveryPort {
    return { store: this.store, command: (input, signal) => this.command(input, signal), now: () => this.options.now(),
      released: row => { for (const listener of this.releasedListeners) try { listener({ row, by: 'cleanup' }); } catch { /* learning never fails a cleanup */ } },
      held: (row, why) => { for (const listener of this.heldListeners) try { listener({ row, why }); } catch { /* learning never fails a cleanup */ } } };
  }
  /** A stop at once for commands whose result is unknown (or that an earlier start of the head left open): see `cleanupOperations`. */
  cleanup(input: { taskId: string; context: BodyTaskContext; lease: ActionLease; ids?: readonly string[]; limitMs?: number; signal?: AbortSignal }): Promise<CleanupOutcome> {
    const ids = input.ids ?? this.store.uncleaned(input.taskId, this.headBoot()).map(row => row.id);
    return cleanupOperations(this.recoveryPort(), { ...input, ids });
  }
  /**
   * The operator's resume or cancel of a task: every command a cleanup left held moves on the hold axis only (the result axis is left as it is: an unknown result is not
   * made known, and nothing is sent again). Returns the commands it changed.
   */
  resolveHolds(taskId: string, how: 'resume' | 'cancel'): string[] {
    const changed: string[] = [];
    for (const row of this.store.heldOfTask(taskId)) {
      if (this.store.holdEvent(row.id, { kind: how === 'resume' ? 'operator_resume' : 'operator_cancel' }) !== row.hold) changed.push(row.id);
    }
    return changed;
  }
  /** The pages of a command's events its receipt did not carry: see `fetchEventPages`. */
  fetchEvents(input: { command: string; context: BodyTaskContext; lease: ActionLease; fromSeq: number; total: number; max?: number; signal?: AbortSignal }) {
    return fetchEventPages(this.recoveryPort(), input);
  }
  private allowed(command: Pick<MinecraftControlCommand, 'kind' | 'lease' | 'context'>): boolean {
    if (command.kind === 'release' && namesHold(command.context) && this.options.leaseAttempted?.(command.lease, command.context.taskId)) return true;
    if (command.kind === 'stop' || command.kind === 'release') return this.options.leaseKnown?.(command.lease, command.context.taskId) ?? this.options.leaseValid(command.lease, command.context.taskId);
    return this.options.ownerAlone() && this.options.leaseValid(command.lease, command.context.taskId);
  }
  bodyId(serverId: string): string { return `minecraft:${serverId}`; }
  frame(bodyId: string): Frame | null {
    const frame = this.frames.get(bodyId);
    return frame && frame.poll.observation.connected && this.options.now() - frame.received <= (this.options.frameMilliseconds ?? 3000) ? frame : null;
  }
  /** Whether the body arrived (logged in, reconnected, respawned) within `milliseconds`: its world and facts are still settling. */
  settling(bodyId: string, milliseconds = MINECRAFT_SPAWN_GRACE_MILLISECONDS): boolean {
    const at = this.arrivals.get(bodyId);
    return at === undefined || this.options.now() - at < milliseconds;
  }
  /** When this body last arrived (login, new connection, respawn), or null (`fastJudgment.ts`: a death changes it). */
  arrivedAt(bodyId: string): number | null { return this.arrivals.get(bodyId) ?? null; }
  /**
   * How it last arrived (mb-r24, Minecraft run 24: a body that came back 12 s after the server cut it in the Nether was taken for a
   * respawn, and the fast judgment dug a shelter over magma): `death` (alive again after being dead), `login` (the first frame),
   * `reconnect` (connected again or on a new connection, alive all the time), `dimension` (a portal's other side).
   */
  arrivalKind(bodyId: string): ArrivalKind | null { return this.arrivalKinds.get(bodyId) ?? null; }
  /** The events this body told while it worked, or null before its first poll that carried any. */
  working(bodyId: string): WorkingEventLog | null { return this.workingLogs.get(bodyId) ?? null; }
  available(): string[] { return [...this.frames.keys()].filter(id => this.frame(id)); }
  observe(bodyId: string): BodyObservation | null { return this.frame(bodyId)?.poll.observation ?? null; }
  /** The body's newest connected frame at most maxAgeMs old (a conversation may read a frame older than the 3 s a command needs), or null. */
  latest(bodyId: string, maxAgeMs: number): { observation: BodyObservation; ageMs: number } | null {
    const frame = this.frames.get(bodyId);
    const ageMs = frame ? this.options.now() - frame.received : Infinity;
    return frame && frame.poll.observation.connected && ageMs <= maxAgeMs ? { observation: frame.poll.observation, ageMs } : null;
  }
  /**
   * The body's picture for a decision (not for a command): its current frame, or an older connected one at most `maxAgeMs` old, with how
   * old it is and whether it is of the current kind (`current`: a command could be sent on it). mc-chat-stale-frame (2026-10-26): source
   * walks blocked the API's one thread for 8 s, no poll could be read, and the next decision's live said the body was not connected
   * though it had polled 200 ms before the stall. A decision reads the body as it was a few seconds ago, and is told how long ago.
   */
  seen(bodyId: string, maxAgeMs: number): { observation: BodyObservation; ageMs: number; current: boolean } | null {
    const found = this.latest(bodyId, maxAgeMs);
    return found ? { ...found, current: this.frame(bodyId) !== null } : null;
  }
  /**
   * Whether this body cannot give a first-person picture now, so a session that requires one would only end
   * `observation_unavailable` (Minebot lane 2026-10-14: a task's whole first step went to such a session, decisions 0).
   * The body says so (`rendererConfigured: false`), or a capture of its current connection came back without a picture and
   * it has not reported `imageAvailable: true` since; after `MINECRAFT_CAPTURE_RETRY_MILLISECONDS` one is tried again.
   */
  imagesUnavailable(bodyId: string): boolean {
    const frame = this.frame(bodyId);
    if (!frame) return true;
    const facts = frame.poll.observation.facts;
    if (facts.rendererConfigured === false) return true;
    if (facts.imageAvailable === true) return false;
    const miss = this.captureMisses.get(bodyId);
    return !!miss && miss.connectionId === frame.poll.connectionId && this.options.now() - miss.at < MINECRAFT_CAPTURE_RETRY_MILLISECONDS;
  }
  image(ref: string): string | null {
    const image = this.images.get(ref); if (!image || image.expires < this.options.now()) { this.images.delete(ref); return null; } return image.dataUrl;
  }
  poll(principal: { scopeKey: string; deviceId: string }, input: unknown): MinecraftControlReply {
    const config = this.configuration;
    if (principal.scopeKey !== config.ownerScopeKey || principal.deviceId !== config.deviceId) throw new Error('FCA_BODY_DEVICE_DENIED');
    if (!validControlPoll(input, this.options.now()) || !config.servers.has(input.serverId) || input.observation.bodyId !== this.bodyId(input.serverId)) throw new Error('FCA_BODY_POLL_INVALID');
    const bodyId = input.observation.bodyId, old = this.frames.get(bodyId);
    if (old?.poll.connectionId === input.connectionId && input.observation.sequence <= old.poll.observation.sequence) throw new Error('FCA_BODY_STALE_FRAME');
    if (!input.skills && (!old || old.poll.connectionId !== input.connectionId)) throw new Error('FCA_BODY_CATALOG_REQUIRED');
    if (this.retiredConnection(bodyId, old, input.connectionId)) throw new Error('FCA_BODY_RETIRED_CONNECTION');
    // References sent by the body never allow arbitrary URLs or a previous connection's pixels to enter inference.
    const observation = { ...input.observation, receivedAt: new Date(this.options.now()).toISOString() };
    delete observation.image;
    const previousImage = old?.poll.connectionId === input.connectionId ? old.poll.observation.image : undefined;
    if (previousImage && this.image(previousImage.ref)) observation.image = previousImage;
    this.frames.set(bodyId, { poll: { ...input, observation, skills: input.skills ?? old!.poll.skills }, received: this.options.now() });
    this.noteArrival(bodyId, old?.poll, input);
    if (old?.poll.connectionId === input.connectionId && old.poll.observation.facts.alive !== false && input.observation.facts.alive === false) {
      for (const listener of this.deathListeners) try { listener(bodyId); } catch { /* learning never fails a poll */ }
    }
    const newConnection = !old || old.poll.connectionId !== input.connectionId;
    for (const listener of this.frameListeners) try { listener(bodyId, observation, { newConnection }); } catch { /* the live view never fails a poll */ }
    const eventsThrough = this.takeEvents(bodyId, input);
    const acknowledged: string[] = [];
    for (const receipt of input.receipts) {
      const command = this.store.command(receipt.id);
      if (!command || command.context.bodyId !== bodyId || command.connectionId !== input.connectionId) continue;
      if (command.kind === 'reflex' && (!receipt.action || receipt.action.schemaVersion !== 1 || receipt.action.outcome !== receipt.outcome
        || receipt.action.inputsReleased !== receipt.inputsReleased || !receipt.action.evidenceId)) continue;
      if (command.stop && (!receipt.stop || receipt.stop.inputsReleased !== receipt.inputsReleased
        || !['stopped', 'unknown'].includes(receipt.stop.state) || receipt.stop.state === 'stopped' && !receipt.inputsReleased)) continue;
      if (receipt.action && (receipt.action.operationId !== command.operation?.operationId || receipt.action.bodyId !== bodyId
        || receipt.action.sessionId !== command.context.sessionId || receipt.action.generation !== command.context.generation)) continue;
      if (receipt.stop && (receipt.stop.requestId !== command.stop?.requestId || receipt.stop.bodyId !== bodyId
        || receipt.stop.sessionId !== command.context.sessionId || receipt.stop.generation !== command.context.generation)) continue;
      if (receipt.image && command.kind !== 'capture') continue;
      const change = this.store.settleWith(receipt);
      if (!change.acked) continue;
      if (change.to && change.to !== change.from) for (const listener of this.settledListeners) try { listener({ id: receipt.id, command, receipt, from: change.from, to: change.to }); } catch { /* learning never fails a poll */ }
      this.deliveries.delete(receipt.id);
      acknowledged.push(receipt.id);
      let pictured = false;
      if (receipt.image && receipt.outcome === 'completed' && this.options.now() - Date.parse(receipt.image.capturedAt) >= 0 && this.options.now() - Date.parse(receipt.image.capturedAt) <= 2500) {
        const ref = `frame:${createHash('sha256').update(receipt.id).digest('hex')}`;
        const expires = this.options.now() + 3000;
        this.images.set(ref, { dataUrl: receipt.image.dataUrl, expires });
        observation.image = { ref, capturedAt: receipt.image.capturedAt, expiresAt: new Date(expires).toISOString() };
        pictured = true;
      }
      if (command.kind === 'capture' && receipt.outcome !== 'cancelled') {
        if (pictured) this.captureMisses.delete(bodyId);
        else this.captureMisses.set(bodyId, { connectionId: input.connectionId, at: this.options.now() });
      }
    }
    for (const [ref, image] of this.images) if (image.expires < this.options.now()) this.images.delete(ref);
    // A command handed in an earlier reply is confirmed by this poll (the body lists it as active or sends its receipt), or it never
    // reached the body: the body polls one request at a time, so a poll handled after the delivering reply was sent either after
    // the body took that reply or after it gave up on it. With a full receipt list one may be left out, so nothing is concluded.
    const reported = this.reportedIds(input);
    for (const row of this.store.pending(bodyId)) {
      if (row.command.connectionId !== input.connectionId || !row.delivered || row.confirmed) continue;
      if (reported.has(row.command.id)) this.store.confirm(row.command.id);
      else if (input.receipts.length < RECEIPTS_PER_POLL) this.store.undelivered(row.command.id);
    }
    if (old && old.poll.connectionId !== input.connectionId) this.proveReleasedAfterReconnect(bodyId, input);
    const commands: MinecraftControlCommand[] = [], cancel: string[] = [];
    for (const row of this.store.pending(bodyId)) {
      const c = row.command;
      const expired = this.expired(c);
      if (c.connectionId !== input.connectionId || expired || !this.allowed(c)) this.store.cancel(c.id);
      const cancelled = row.cancelled || this.store.receipt(c.id)?.outcome === 'cancelled' || expired || !this.allowed(c);
      if (cancelled) { if (row.delivered && c.connectionId === input.connectionId) cancel.push(c.id); continue; }
      if (!row.delivered && this.mayDeliver(commands, c) && c.connectionId === input.connectionId && this.store.deliver(c.id)) {
        commands.push(c);
        this.deliveries.set(c.id, this.options.now());
      }
    }
    const speech = this.speech ? this.liveSpeech(this.speech, input) : [];
    if (this.headBootTold.get(bodyId) !== input.connectionId) {
      this.headBootTold.set(bodyId, input.connectionId);
      // TODO(records): decisionRecorder — the `head_boot` row (`headBootRow` in `minecraftOperationRows.ts`) for the first reply of this start on this connection.
      for (const listener of this.headBootListeners) try { listener({ bodyId, connectionId: input.connectionId, headBoot: this.headBoot() }); } catch { /* learning never fails a poll */ }
    }
    return { schemaVersion: 1, mode: 'common-fca', headBoot: this.headBoot(), commands, cancel, acknowledged, ...(eventsThrough !== undefined ? { eventsThrough } : {}),
      ...(speech.length ? { speech } : {}) };
  }
  /**
   * The first poll of a new connection that shows the body running nothing and not held proves what the old connection's commands left is released (continue
   * contract 1: a body that restarted has no inputs held). Each such command ends `released` and its result stays unknown; a real receipt that comes later is read
   * as the correction it is (the new connection does not accept it: the receipt of an old connection is never acknowledged, so none comes).
   */
  private proveReleasedAfterReconnect(bodyId: string, input: MinecraftControlPoll): void {
    const facts = input.observation.facts;
    if (input.activeOperationIds.length > 0 || facts.held === true || facts.incidentHeld === true) return;
    for (const id of this.store.openBeforeConnection(bodyId, input.connectionId)) {
      if (!this.store.release(id, 'reconnect', new Date(this.options.now()).toISOString(), `reconnect:${input.connectionId}`)) continue;
      const row = this.store.row(id);
      if (row) for (const listener of this.releasedListeners) try { listener({ row, by: 'reconnect' }); } catch { /* learning never fails a poll */ }
    }
  }
  /** One command a reply hands over: the first of any kind, then up to `QUEUE_COMMANDS_PER_REPLY` in all while every one of them is a queue item. */
  private mayDeliver(handing: readonly MinecraftControlCommand[], next: MinecraftControlCommand): boolean {
    return handing.length === 0 || (handing.length < QUEUE_COMMANDS_PER_REPLY && next.queue !== undefined && handing.every(item => item.queue !== undefined));
  }
  /**
   * The ids a poll reports (running, receipts, and the queue's waiting ones); the waiting ones that this process waits for have their clocks start
   * again from now (`receiptOf`).
   */
  private reportedIds(input: MinecraftControlPoll): Set<string> {
    for (const id of input.queuedOperationIds ?? []) if (this.waiting.has(id)) this.queuedAt.set(id, this.options.now());
    return new Set([...input.activeOperationIds, ...input.receipts.map(receipt => receipt.id), ...(input.queuedOperationIds ?? [])]);
  }
  /** The ids of the commands the newest current frame lists as waiting in the body's queue (in order). */
  queued(bodyId: string): readonly string[] { return this.frame(bodyId)?.poll.queuedOperationIds ?? []; }
  /** How far the body's running queue item is, from the newest current frame, or null. */
  progress(bodyId: string): MinecraftQueueProgress | null { return this.frame(bodyId)?.poll.queue ?? null; }
  /** Takes these commands off: a queued one the body has not got is settled `cancelled` at once; one it has is listed in the next reply's `cancel`. */
  cancelQueued(ids: readonly string[]): void { for (const id of ids) this.store.cancel(id); }
  /** A poll that is an arrival (a login, a new connection, connected again, alive again, another dimension) keeps when and how. */
  private noteArrival(bodyId: string, old: MinecraftControlPoll | undefined, input: MinecraftControlPoll): void {
    const counted = deathBetween(this.deaths.get(bodyId) ?? null, deathCounterOf(input.observation));
    if (counted.counter) this.deaths.set(bodyId, counted.counter);
    const arrival = arrivalOf(old?.observation, input.observation, old ? old.connectionId !== input.connectionId : false, counted.death);
    if (!arrival) {
      // Alive again after the death that was told: the body's first frames settle from now (`settling`), the arrival stays the death.
      if (old?.observation.facts.alive === false && input.observation.facts.alive !== false && this.arrivalKinds.get(bodyId) === 'death') this.arrivals.set(bodyId, this.options.now());
      return;
    }
    this.arrivals.set(bodyId, this.options.now());
    this.arrivalKinds.set(bodyId, arrival);
  }
  /** The body's answers and room into the outbox, and the line due: never fails a poll. */
  private liveSpeech(port: NonNullable<MinecraftControl['speech']>, input: MinecraftControlPoll): MinecraftLiveSpeech[] {
    try {
      port.receive(input.speechReceipts ?? [], input.liveRoom ?? null);
      return port.take();
    } catch { return []; }
  }
  /** A poll's events into the body's log; the highest number taken, or undefined when the poll carried none. Never fails the poll. */
  private takeEvents(bodyId: string, input: MinecraftControlPoll): number | undefined {
    try {
      const log = this.workingLogs.get(bodyId) ?? (input.events ? new WorkingEventLog() : undefined);
      if (!log) return undefined;
      this.workingLogs.set(bodyId, log);
      log.connect(input.connectionId);
      const before = log.cursor(), through = input.events ? log.take(input.connectionId, input.events).through : undefined;
      const fresh = log.since(before).events;
      if (fresh.length) for (const listener of this.eventListeners) try { listener(bodyId, fresh); } catch { /* the live view never fails a poll */ }
      return through;
    } catch { return undefined; }
  }
  /** A command this process waits for expires when its wait says so (time counted from delivery, without stalls); another by its deadline. */
  private expired(command: MinecraftControlCommand): boolean {
    const waiting = this.waiting.get(command.id);
    return waiting ? waiting.expired : Date.parse(command.deadlineAt) <= this.options.now();
  }
  /**
   * A queue item (`mc.act` in the task queue): the command is inserted and this returns at once; `receipt` settles as `command`'s does (the same
   * errors) once the body answers, however long the item waits in the body's queue. It never leaves an unhandled rejection: whoever awaits it gets the error.
   */
  enqueue(input: ControlCommandInput & { queue: MinecraftQueueEnvelope }, signal?: AbortSignal): { id: string; receipt: Promise<MinecraftControlReceipt> } {
    // A queue item's unknown result is a state (`settled_unknown`) the queue handles, not an error that ends the step.
    const receipt = this.command(input, signal, true);
    receipt.catch(() => undefined);
    return { id: input.id, receipt };
  }
  async command(input: ControlCommandInput, signal?: AbortSignal, lenient = false): Promise<MinecraftControlReceipt> {
    // After a stall the body's queued polls are handled in the next I/O turn: a frame is judged gone only after it.
    if (!this.frame(input.context.bodyId)) await ioTurn();
    const frame = this.frame(input.context.bodyId); if (!frame) throw new Error('FCA_BODY_UNAVAILABLE');
    if (!this.allowed(input)) throw new Error('FCA_BODY_LEASE_INVALID');
    signal?.throwIfAborted();
    // Continue contract 1: nothing that moves the body is sent while a result is unknown and the release is not proved (a reflex, a stop, a release and a read are not held back).
    if (input.kind === 'skill' && !this.observationOnly(input) && this.motorBlocked(input.context.taskId)) throw new Error('FCA_BODY_MOTOR_BLOCKED');
    const command: MinecraftControlCommand = { schemaVersion: 1, id: input.id, serverId: frame.poll.serverId, connectionId: frame.poll.connectionId,
      kind: input.kind, context: input.context, lease: input.lease, deadlineAt: new Date(this.options.now() + (input.milliseconds ?? 30_000)).toISOString(),
      ...(input.skill ? { skill: input.skill } : {}), ...(input.arguments ? { arguments: input.arguments } : {}),
      ...(input.operation ? { operation: input.operation } : {}), ...(input.stop ? { stop: input.stop } : {}), ...(input.queue ? { queue: input.queue } : {}) };
    // Existing IDs only return original receipts; never issue a replacement after uncertain delivery.
    const existing = this.store.command(command.id);
    if (existing) {
      const { deadlineAt: _a, ...original } = existing, { deadlineAt: _b, ...retry } = command;
      if (JSON.stringify(original) !== JSON.stringify(retry)) throw new Error('FCA_BODY_OPERATION_CONFLICT');
      const receipt = this.store.receipt(command.id);
      if (receipt && receipt.outcome !== 'unknown' && receipt.inputsReleased) return receipt;
      if (lenient) return receipt ? this.withUnit(receipt) : this.unknownReceipt(command);
      throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
    }
    const waiting: Waiting = { expired: false };
    this.waiting.set(command.id, waiting);
    try {
      this.store.insert(command, new Date(this.options.now()).toISOString(), () => {
        signal?.throwIfAborted();
        return this.allowed(command) && this.frame(command.context.bodyId)?.poll.connectionId === command.connectionId;
      }, { headBoot: this.headBoot(), ...(input.uses?.length ? { uses: input.uses } : {}), ...(input.resumeOf ? { resumeOf: input.resumeOf } : {}) });
      noteBodyCommand(command);
      return await this.receiptOf(command, input, waiting, signal, lenient);
    } finally { this.waiting.delete(command.id); this.deliveries.delete(command.id); this.queuedAt.delete(command.id); }
  }
  /**
   * Waits for the body's receipt. Minecraft run 6 (2026-10-14): the API's thread was blocked for 10 s while a stop was being handed
   * over; the stop's 5 s ran out on the wall clock, the frame looked stale only because the body's polls could not be read, and
   * the stop was declared unknown. Now the time counts from the (last) delivery and a stall is not counted; after a stall the frame is
   * judged only once the next I/O turn has read the body's polls; and before an outcome is declared unknown the body is asked again:
   * one fresh poll, which still lists the command when it is running (one more wait) or does not (unknown).
   */
  private async receiptOf(command: MinecraftControlCommand, input: { context: BodyTaskContext; lease: ActionLease; kind: MinecraftControlCommand['kind']; milliseconds?: number },
    waiting: Waiting, signal?: AbortSignal, lenient = false): Promise<MinecraftControlReceipt> {
    const step = this.options.pollMilliseconds ?? 25, budget = input.milliseconds ?? 30_000, inserted = this.options.now();
    const cancelWait = this.options.cancelWaitMilliseconds ?? 5000, bodyId = input.context.bodyId;
    let cancellingAt: number | null = null, lag = 0, last = this.options.now(), asked: number | null = null, extended = false;
    for (;;) {
      const result = this.store.receipt(command.id);
      if (result) {
        if (result.outcome === 'unknown' || !result.inputsReleased) {
          if (lenient) return this.withUnit(result);
          throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
        }
        return result;
      }
      const now = this.options.now(), behind = now - last - step;
      last = now;
      if (behind > Math.max(step, 10)) lag += behind; // Timer jitter is not a stall; a late step is time the body did not see.
      // A stall: the body's polls wait in the socket. Read them (one I/O turn) before judging the frame or the time.
      if (behind >= MINECRAFT_STALL_MILLISECONDS) {
        await ioTurn();
        last = this.options.now();
        continue;
      }
      if (signal?.aborted || !this.frame(bodyId) || now >= Math.max(this.deliveries.get(command.id) ?? inserted, this.queuedAt.get(command.id) ?? 0) + budget + lag || !this.allowed(input)) {
        waiting.expired = true;
        this.store.cancel(command.id);
        cancellingAt ??= now;
      }
      if (cancellingAt !== null && now - cancellingAt >= cancelWait) {
        // Before an unknown: ask the body once more (its next poll). Still running there: one more wait; otherwise unknown.
        const latest = this.frames.get(bodyId);
        if (asked === null && latest?.poll.connectionId === command.connectionId) asked = now;
        else if (asked !== null && latest && latest.received > asked && latest.poll.activeOperationIds.includes(command.id) && !extended) {
          extended = true;
          cancellingAt = now;
          asked = null;
        } else if (asked === null || (latest && latest.received > asked) || now - asked >= cancelWait) {
          if (!lenient) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
          // A queue item: the result is unknown, and a receipt that comes later corrects it (the store reads it against this state).
          this.store.markUnknown(command.id);
          return this.unknownReceipt(command);
        }
      }
      await delay(step);
    }
  }
  /** A receipt as the queue reads it: with its `unit` (the old words read as one when the body sent none). */
  private withUnit(receipt: MinecraftControlReceipt): MinecraftControlReceipt {
    return receipt.unit ? receipt : { ...receipt, unit: unitFromOutcome(receipt.outcome, receipt.inputsReleased) };
  }
  /** The receipt a queue item gets when its wait ran out: unknown, inputs not confirmed released. Not stored (the store has the state). */
  private unknownReceipt(command: MinecraftControlCommand): MinecraftControlReceipt {
    return { id: command.id, connectionId: command.connectionId, outcome: 'unknown', inputsReleased: false, observedAt: new Date(this.options.now()).toISOString(),
      unit: { goal: 'unknown', end: 'unknown', released: false } };
  }
  /** A command that only looks (a skill the body lists as read-only, the internal `events`): never held back by an unknown result. */
  private observationOnly(input: ControlCommandInput): boolean {
    if (input.skill === undefined) return false;
    if (input.skill === 'events' || input.skill === 'probe' || input.skill === 'view') return true;
    const frame = this.frames.get(input.context.bodyId);
    return frame?.poll.skills?.find(skill => skill.name === input.skill)?.readOnly === true;
  }
  /**
   * Cancels the task's pending body commands, except a stop or a release: those only let go of the body's inputs, and a cancel must
   * see them through. Minecraft run 10 (2026-10-14, task 74a32315): the cancel's own reflex release was cancelled here a moment after
   * it was sent, came back `cancelled` without a stop acknowledgement, and the step was left unknown; its body lease stayed held until
   * the unknown exit three minutes later, and every logout in between was refused with `lease_conflict`.
   */
  cancelTask(taskId: string): void {
    for (const body of this.frames.keys()) for (const row of this.store.pending(body)) {
      if (row.command.context.taskId === taskId && row.command.kind !== 'stop' && row.command.kind !== 'release') this.store.cancel(row.command.id);
    }
  }
}
