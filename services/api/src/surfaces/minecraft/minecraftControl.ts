import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { ActionLease } from '@shannon/mind';
import type { MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import type { BodyObservation, BodyTaskContext } from '../../contracts/bodyControlContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt, MinecraftControlReply } from '../../contracts/minecraftControlContract.js';
import { MinecraftControlStore } from './store/minecraftControlStore.js';
import { validControlPoll } from './minecraftControlValidation.js';

interface Frame { poll: MinecraftControlPoll; received: number }
/** A paired body supplies observations and executes exact commands; the shared FCA owns all long-term decisions. */
export class MinecraftControl {
  readonly frames = new Map<string, Frame>();
  private readonly images = new Map<string, { dataUrl: string; expires: number }>();
  constructor(readonly store: MinecraftControlStore, readonly configuration: MinecraftBodyConfiguration,
    private readonly options: { now(): number; leaseValid(lease: ActionLease, taskId: string): boolean; ownerAlone(): boolean; leaseKnown?(lease: ActionLease, taskId: string): boolean; pollMilliseconds?: number; cancelWaitMilliseconds?: number }) {}
  private allowed(command: Pick<MinecraftControlCommand, 'kind' | 'lease' | 'context'>): boolean {
    if (command.kind === 'stop' || command.kind === 'release') return this.options.leaseKnown?.(command.lease, command.context.taskId) ?? this.options.leaseValid(command.lease, command.context.taskId);
    return this.options.ownerAlone() && this.options.leaseValid(command.lease, command.context.taskId);
  }
  bodyId(serverId: string): string { return `minecraft:${serverId}`; }
  frame(bodyId: string): Frame | null {
    const frame = this.frames.get(bodyId);
    return frame && frame.poll.observation.connected && this.options.now() - frame.received <= 3000 ? frame : null;
  }
  available(): string[] { return [...this.frames.keys()].filter(id => this.frame(id)); }
  observe(bodyId: string): BodyObservation | null { return this.frame(bodyId)?.poll.observation ?? null; }
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
    // References sent by the body never allow arbitrary URLs or a previous connection's pixels to enter inference.
    const observation = { ...input.observation, receivedAt: new Date(this.options.now()).toISOString() };
    delete observation.image;
    const previousImage = old?.poll.connectionId === input.connectionId ? old.poll.observation.image : undefined;
    if (previousImage && this.image(previousImage.ref)) observation.image = previousImage;
    this.frames.set(bodyId, { poll: { ...input, observation, skills: input.skills ?? old!.poll.skills }, received: this.options.now() });
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
      acknowledged.push(receipt.id);
      if (receipt.image && receipt.outcome === 'completed' && this.options.now() - Date.parse(receipt.image.capturedAt) >= 0 && this.options.now() - Date.parse(receipt.image.capturedAt) <= 2500) {
        const ref = `frame:${createHash('sha256').update(receipt.id).digest('hex')}`;
        const expires = this.options.now() + 3000;
        this.images.set(ref, { dataUrl: receipt.image.dataUrl, expires });
        observation.image = { ref, capturedAt: receipt.image.capturedAt, expiresAt: new Date(expires).toISOString() };
      }
    }
    for (const [ref, image] of this.images) if (image.expires < this.options.now()) this.images.delete(ref);
    const commands: MinecraftControlCommand[] = [], cancel: string[] = [];
    for (const row of this.store.pending(bodyId)) {
      const c = row.command;
      if (c.connectionId !== input.connectionId || Date.parse(c.deadlineAt) <= this.options.now()
        || !this.allowed(c)) this.store.cancel(c.id);
      const cancelled = row.cancelled || this.store.receipt(c.id)?.outcome === 'cancelled'
        || Date.parse(c.deadlineAt) <= this.options.now() || !this.allowed(c);
      if (cancelled) { if (row.delivered && c.connectionId === input.connectionId) cancel.push(c.id); continue; }
      if (!row.delivered && commands.length < 1 && c.connectionId === input.connectionId && this.store.deliver(c.id)) commands.push(c);
    }
    return { schemaVersion: 1, mode: 'common-fca', commands, cancel, acknowledged };
  }
  async command(input: { id: string; context: BodyTaskContext; lease: ActionLease; kind: MinecraftControlCommand['kind'];
    skill?: string; arguments?: Readonly<Record<string, unknown>>; operation?: MinecraftControlCommand['operation']; stop?: MinecraftControlCommand['stop']; milliseconds?: number }, signal?: AbortSignal): Promise<MinecraftControlReceipt> {
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
    this.store.insert(command, new Date(this.options.now()).toISOString(), () => {
      signal?.throwIfAborted();
      return this.allowed(command) && this.frame(command.context.bodyId)?.poll.connectionId === command.connectionId;
    });
    let cancellingAt: number | null = null;
    for (;;) {
      const result = this.store.receipt(command.id);
      if (result) {
        if (result.outcome === 'unknown' || !result.inputsReleased) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
        return result;
      }
      if (signal?.aborted || !this.frame(input.context.bodyId) || this.options.now() >= Date.parse(command.deadlineAt)
        || !this.allowed(input)) {
        this.store.cancel(command.id); cancellingAt ??= this.options.now();
      }
      if (cancellingAt !== null && this.options.now() - cancellingAt >= (this.options.cancelWaitMilliseconds ?? 5000)) throw new Error('FCA_BODY_OUTCOME_UNKNOWN');
      await delay(this.options.pollMilliseconds ?? 25);
    }
  }
  cancelTask(taskId: string): void { for (const body of this.frames.keys()) for (const row of this.store.pending(body)) if (row.command.context.taskId === taskId) this.store.cancel(row.command.id); }
}
