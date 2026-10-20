import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { WorkingEventLog, type ActionLease } from '@shannon/mind';
import type { MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt, MinecraftControlReply } from '../../contracts/minecraftControlContract.js';
import { MinecraftControlStore } from './store/minecraftControlStore.js';
import { validControlPoll } from './minecraftControlValidation.js';

interface Frame { poll: MinecraftControlPoll; received: number }
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
const ioTurn = () => new Promise<void>(resolve => setImmediate(resolve));
/** A paired body supplies observations and executes exact commands; the shared FCA owns all long-term decisions. */
export class MinecraftControl {
  readonly frames = new Map<string, Frame>();
  private readonly images = new Map<string, { dataUrl: string; expires: number }>();
  private readonly captureMisses = new Map<string, { connectionId: string; at: number }>();
  /** Per body, the connections a newer one replaced (the last 16). */
  private readonly retired = new Map<string, string[]>();
  /**
   * A poll from a connection a newer one replaced, while the newer one is alive: refused. A body process kept from run to run may
   * keep an earlier loop polling (practice ground, 2026-10-20); taking each connection's frame in turn swapped the catalog under a
   * step (FCA_BODY_CATALOG_CHANGED). A new connection retires the one before it; the earlier one comes back only once the newer one
   * has been silent for `MINECRAFT_RETIRED_CONNECTION_MS`.
   */
  private retiredConnection(bodyId: string, old: { poll: { connectionId: string }; received: number } | undefined, connectionId: string): boolean {
    if (!old || old.poll.connectionId === connectionId) return false;
    const retired = this.retired.get(bodyId) ?? [];
    if (retired.includes(connectionId) && this.options.now() - old.received < MINECRAFT_RETIRED_CONNECTION_MS) return true;
    this.retired.set(bodyId, [...retired.filter(id => id !== old.poll.connectionId && id !== connectionId), old.poll.connectionId].slice(-16));
    return false;
  }
  /** When each body last arrived: a new connection, connected again, or alive again (`settling`). */
  private readonly arrivals = new Map<string, number>();
  /** Told when a body on the same connection is seen alive and then dead (its facts' `alive` turns false). Listeners never throw. */
  readonly deathListeners = new Set<(bodyId: string) => void>();
  /** The commands this process waits for, and when each was last handed to the body (`command`). */
  private readonly waiting = new Map<string, Waiting>();
  private readonly deliveries = new Map<string, number>();
  /**
   * What each body told while it worked (session mb-arch, stage 1): needs in reach, each command's progress, stalls. Kept here, in
   * memory, per body; the task's arbiter reads it (working). Taking them costs nothing when no one reads them.
   */
  private readonly workingLogs = new Map<string, WorkingEventLog>();
  constructor(readonly store: MinecraftControlStore, readonly configuration: MinecraftBodyConfiguration,
    private readonly options: { now(): number; leaseValid(lease: ActionLease, taskId: string): boolean; ownerAlone(): boolean; leaseKnown?(lease: ActionLease, taskId: string): boolean; pollMilliseconds?: number; cancelWaitMilliseconds?: number;
      /** How long a frame stays current (3 s); tests shorten it. */
      frameMilliseconds?: number }) {}
  private allowed(command: Pick<MinecraftControlCommand, 'kind' | 'lease' | 'context'>): boolean {
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
  /** The events this body told while it worked, or null before its first poll that carried any. */
  working(bodyId: string): WorkingEventLog | null { return this.workingLogs.get(bodyId) ?? null; }
  available(): string[] { return [...this.frames.keys()].filter(id => this.frame(id)); }
  observe(bodyId: string): BodyObservation | null { return this.frame(bodyId)?.poll.observation ?? null; }
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
    if (!old || old.poll.connectionId !== input.connectionId || (!old.poll.observation.connected && input.observation.connected)
      || (old.poll.observation.facts.alive === false && input.observation.facts.alive !== false)) this.arrivals.set(bodyId, this.options.now());
    if (old?.poll.connectionId === input.connectionId && old.poll.observation.facts.alive !== false && input.observation.facts.alive === false) {
      for (const listener of this.deathListeners) try { listener(bodyId); } catch { /* learning never fails a poll */ }
    }
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
      if (!this.store.settle(receipt)) continue;
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
    const reported = new Set([...input.activeOperationIds, ...input.receipts.map(receipt => receipt.id)]);
    for (const row of this.store.pending(bodyId)) {
      if (row.command.connectionId !== input.connectionId || !row.delivered || row.confirmed) continue;
      if (reported.has(row.command.id)) this.store.confirm(row.command.id);
      else if (input.receipts.length < RECEIPTS_PER_POLL) this.store.undelivered(row.command.id);
    }
    const commands: MinecraftControlCommand[] = [], cancel: string[] = [];
    for (const row of this.store.pending(bodyId)) {
      const c = row.command;
      const expired = this.expired(c);
      if (c.connectionId !== input.connectionId || expired || !this.allowed(c)) this.store.cancel(c.id);
      const cancelled = row.cancelled || this.store.receipt(c.id)?.outcome === 'cancelled' || expired || !this.allowed(c);
      if (cancelled) { if (row.delivered && c.connectionId === input.connectionId) cancel.push(c.id); continue; }
      if (!row.delivered && commands.length < 1 && c.connectionId === input.connectionId && this.store.deliver(c.id)) {
        commands.push(c);
        this.deliveries.set(c.id, this.options.now());
      }
    }
    return { schemaVersion: 1, mode: 'common-fca', commands, cancel, acknowledged, ...(eventsThrough !== undefined ? { eventsThrough } : {}) };
  }
  /** A poll's events into the body's log; the highest number taken, or undefined when the poll carried none. Never fails the poll. */
  private takeEvents(bodyId: string, input: MinecraftControlPoll): number | undefined {
    try {
      const log = this.workingLogs.get(bodyId) ?? (input.events ? new WorkingEventLog() : undefined);
      if (!log) return undefined;
      this.workingLogs.set(bodyId, log);
      log.connect(input.connectionId);
      return input.events ? log.take(input.connectionId, input.events).through : undefined;
    } catch { return undefined; }
  }
  /** A command this process waits for expires when its wait says so (time counted from delivery, without stalls); another by its deadline. */
  private expired(command: MinecraftControlCommand): boolean {
    const waiting = this.waiting.get(command.id);
    return waiting ? waiting.expired : Date.parse(command.deadlineAt) <= this.options.now();
  }
  async command(input: { id: string; context: BodyTaskContext; lease: ActionLease; kind: MinecraftControlCommand['kind'];
    skill?: string; arguments?: Readonly<Record<string, unknown>>; operation?: MinecraftControlCommand['operation']; stop?: MinecraftControlCommand['stop']; milliseconds?: number }, signal?: AbortSignal): Promise<MinecraftControlReceipt> {
    // After a stall the body's queued polls are handled in the next I/O turn: a frame is judged gone only after it.
    if (!this.frame(input.context.bodyId)) await ioTurn();
    const frame = this.frame(input.context.bodyId); if (!frame) throw new Error('FCA_BODY_UNAVAILABLE');
    if (!this.allowed(input)) throw new Error('FCA_BODY_LEASE_INVALID');
    signal?.throwIfAborted();
    const command: MinecraftControlCommand = { schemaVersion: 1, id: input.id, serverId: frame.poll.serverId, connectionId: frame.poll.connectionId,
      kind: input.kind, context: input.context, lease: input.lease, deadlineAt: new Date(this.options.now() + (input.milliseconds ?? 30_000)).toISOString(),
      ...(input.skill ? { skill: input.skill } : {}), ...(input.arguments ? { arguments: input.arguments } : {}),
      ...(input.operation ? { operation: input.operation } : {}), ...(input.stop ? { stop: input.stop } : {}) };
    // Existing IDs only return original receipts; never issue a replacement after uncertain delivery.
    const existing = this.store.command(command.id);
    if (existing) {
      const { deadlineAt: _a, ...original } = existing, { deadlineAt: _b, ...retry } = command;
      if (JSON.stringify(original) !== JSON.stringify(retry)) throw new Error('FCA_BODY_OPERATION_CONFLICT');
      const receipt = this.store.receipt(command.id);
      if (receipt && receipt.outcome !== 'unknown' && receipt.inputsReleased) return receipt;
      throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
    }
    const waiting: Waiting = { expired: false };
    this.waiting.set(command.id, waiting);
    try {
      this.store.insert(command, new Date(this.options.now()).toISOString(), () => {
        signal?.throwIfAborted();
        return this.allowed(command) && this.frame(command.context.bodyId)?.poll.connectionId === command.connectionId;
      });
      return await this.receiptOf(command, input, waiting, signal);
    } finally { this.waiting.delete(command.id); this.deliveries.delete(command.id); }
  }
  /**
   * Waits for the body's receipt. Minecraft run 6 (2026-10-14): the API's thread was blocked for 10 s while a stop was being handed
   * over; the stop's 5 s ran out on the wall clock, the frame looked stale only because the body's polls could not be read, and
   * the stop was declared unknown. Now the time counts from the (last) delivery and a stall is not counted; after a stall the frame is
   * judged only once the next I/O turn has read the body's polls; and before an outcome is declared unknown the body is asked again:
   * one fresh poll, which still lists the command when it is running (one more wait) or does not (unknown).
   */
  private async receiptOf(command: MinecraftControlCommand, input: { context: BodyTaskContext; lease: ActionLease; kind: MinecraftControlCommand['kind']; milliseconds?: number },
    waiting: Waiting, signal?: AbortSignal): Promise<MinecraftControlReceipt> {
    const step = this.options.pollMilliseconds ?? 25, budget = input.milliseconds ?? 30_000, inserted = this.options.now();
    const cancelWait = this.options.cancelWaitMilliseconds ?? 5000, bodyId = input.context.bodyId;
    let cancellingAt: number | null = null, lag = 0, last = this.options.now(), asked: number | null = null, extended = false;
    for (;;) {
      const result = this.store.receipt(command.id);
      if (result) {
        if (result.outcome === 'unknown' || !result.inputsReleased) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
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
      if (signal?.aborted || !this.frame(bodyId) || now >= (this.deliveries.get(command.id) ?? inserted) + budget + lag || !this.allowed(input)) {
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
        } else if (asked === null || (latest && latest.received > asked) || now - asked >= cancelWait) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
      }
      await delay(step);
    }
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
