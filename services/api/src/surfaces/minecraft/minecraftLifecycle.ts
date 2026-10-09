import { setTimeout as delay } from 'node:timers/promises';
import type { MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import { validLifecyclePoll, type MinecraftLifecycleAuthority, type MinecraftLifecycleCommand, type MinecraftLifecyclePoll,
  type MinecraftLifecycleReceipt, type MinecraftLifecycleReply, type MinecraftLifecycleRequest, type MinecraftLifecycleState } from '../../contracts/minecraftLifecycleContract.js';
import { MinecraftLifecycleStore } from './store/minecraftLifecycleStore.js';

/** No process execution here: the configured, paired operator owns native state and commands. */
export class MinecraftLifecycle {
  constructor(readonly store: MinecraftLifecycleStore, readonly configuration: MinecraftBodyConfiguration,
    private readonly options: { now(): number; allowed(authority: MinecraftLifecycleAuthority, command?: MinecraftLifecycleCommand): boolean;
      servers?: ReadonlySet<string>; pollMilliseconds?: number; waitMilliseconds?: number; cancelWaitMilliseconds?: number }) {}
  private state(serverId: string): MinecraftLifecycleState | null {
    const frame = this.store.frame();
    if (!frame || this.options.now() - frame.receivedAt > 3000) return null;
    return frame.poll.states.find(s => s.serverId === serverId) ?? null;
  }
  available(scopeKey: string): boolean { const frame = this.store.frame(); return scopeKey === this.configuration.ownerScopeKey && !!frame && this.options.now() - frame.receivedAt <= 3000; }
  status(scopeKey: string): readonly MinecraftLifecycleState[] { return this.available(scopeKey) ? this.store.frame()!.poll.states : []; }
  private permittedServer(serverId: string): boolean { return this.configuration.servers.has(serverId) && (!this.options.servers || this.options.servers.has(serverId)); }
  private allowed(command: MinecraftLifecycleCommand): boolean {
    return command.authority.scopeKey === this.configuration.ownerScopeKey && this.permittedServer(command.serverId)
      && Date.parse(command.deadlineAt) > this.options.now() && this.options.allowed(command.authority, command);
  }
  poll(principal: { scopeKey: string; deviceId: string }, input: unknown): MinecraftLifecycleReply {
    if (principal.scopeKey !== this.configuration.ownerScopeKey || principal.deviceId !== this.configuration.deviceId) throw new Error('MINECRAFT_LIFECYCLE_DEVICE_DENIED');
    if (!validLifecyclePoll(input, this.options.now()) || input.states.some(s => !this.permittedServer(s.serverId))) throw new Error('MINECRAFT_LIFECYCLE_POLL_INVALID');
    const frame = this.store.frame();
    if (frame?.poll.connectionId === input.connectionId && input.sequence <= frame.poll.sequence) throw new Error('MINECRAFT_LIFECYCLE_STALE_FRAME');
    this.store.updateFrame(input, this.options.now());
    const acknowledged: string[] = [], commands: MinecraftLifecycleCommand[] = [], cancel: string[] = [];
    for (const receipt of input.receipts) {
      const c = this.store.command(receipt.id);
      // Receipt delivery may recover across operator restart; identity remains its original connection and command.
      if (!c || receipt.connectionId !== c.connectionId || receipt.serverId !== c.serverId || receipt.action !== c.action
        || !this.store.delivered(c.id) || receipt.state.serverId !== c.serverId || !this.validReceipt(c, receipt)) continue;
      if (this.store.settle(receipt)) acknowledged.push(receipt.id);
    }
    for (const row of this.store.pending()) {
      const c = row.command;
      if (!this.allowed(c) || c.connectionId !== input.connectionId) this.cancel(c.id);
      if (row.cancelled || !this.allowed(c) || c.connectionId !== input.connectionId) {
        if (row.delivered && c.connectionId === input.connectionId) cancel.push(c.id);
        continue;
      }
      // Every world shares one operator serialization slot; a shutdown or logout cannot race another lifecycle action.
      if (!row.delivered && commands.length === 0 && !this.store.pending().some(r => r.delivered)
        && this.store.deliver(c.id)) commands.push(c);
    }
    return { schemaVersion: 1, commands, cancel, acknowledged };
  }
  private validReceipt(command: MinecraftLifecycleCommand, r: MinecraftLifecycleReceipt): boolean {
    const issuedAt = Date.parse(command.issuedAt), observedAt = Date.parse(r.observedAt), stateAt = Date.parse(r.state.observedAt);
    // A delayed original ACK remains valid; evidence from before this original command never proves its effect.
    if (!Number.isFinite(issuedAt) || observedAt < issuedAt || stateAt < issuedAt || stateAt > observedAt
      || r.stopGuard && (Date.parse(r.stopGuard.checkedAt) < issuedAt || Date.parse(r.stopGuard.checkedAt) > observedAt)) return false;
    if (r.outcome !== 'completed') return true;
    if (!r.inputsReleased) return false;
    switch (command.action) {
      case 'start': return r.state.running === 'running' && ['changed', 'already_running'].includes(r.code);
      case 'stop': return r.state.running === 'stopped' && (r.code === 'already_stopped' || r.code === 'changed'
        && r.stopGuard?.admissionClosed === true && r.stopGuard.otherPlayers === 0 && Date.parse(r.stopGuard.checkedAt) <= Date.parse(r.observedAt));
      case 'login': return r.state.running === 'running' && r.state.bot === 'joined' && ['changed', 'already_joined'].includes(r.code);
      case 'logout': return r.state.bot === 'absent' && ['changed', 'already_absent'].includes(r.code);
    }
  }
  private cancel(id: string): void {
    const row = this.store.pending().find(r => r.command.id === id);
    if (!row) return;
    this.store.cancel(id);
    if (!row.delivered) {
      const c = row.command, state = this.state(c.serverId) ?? { serverId: c.serverId, observedAt: new Date(this.options.now()).toISOString(), running: 'unknown', bot: 'unknown', otherPlayers: null };
      this.store.settle({ id, connectionId: c.connectionId, serverId: c.serverId, action: c.action, outcome: 'cancelled', code: 'authority_revoked', inputsReleased: true,
        observedAt: new Date(this.options.now()).toISOString(), state });
    }
  }
  async execute(request: MinecraftLifecycleRequest, signal?: AbortSignal): Promise<MinecraftLifecycleReceipt> {
    const previous = this.store.command(request.id);
    if (previous) {
      if (previous.action !== request.action || previous.serverId !== request.serverId || JSON.stringify(previous.authority) !== JSON.stringify(request.authority)) throw new Error('MINECRAFT_LIFECYCLE_OPERATION_CONFLICT');
      const receipt = this.store.receipt(request.id);
      if (receipt && receipt.outcome !== 'unknown' && receipt.inputsReleased) return receipt;
      throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
    }
    signal?.throwIfAborted();
    if (!this.available(request.authority.scopeKey) || !this.state(request.serverId)) throw new Error('MINECRAFT_LIFECYCLE_UNAVAILABLE');
    const command: MinecraftLifecycleCommand = { ...request, schemaVersion: 1, connectionId: this.store.frame()!.poll.connectionId,
      issuedAt: new Date(this.options.now()).toISOString(),
      deadlineAt: new Date(this.options.now() + (this.options.waitMilliseconds ?? 120_000)).toISOString() };
    if (!this.allowed(command)) throw new Error('MINECRAFT_LIFECYCLE_AUTHORITY_DENIED');
    // A new ID is not a retry path around an unresolved physical operation.
    if (this.store.unresolved()) throw new Error('MINECRAFT_LIFECYCLE_BUSY');
    this.store.insert(command);
    let cancellingAt: number | null = null;
    for (;;) {
      const receipt = this.store.receipt(command.id);
      if (receipt) {
        if (receipt.outcome === 'unknown' || !receipt.inputsReleased) throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
        return receipt;
      }
      if (signal?.aborted || !this.available(request.authority.scopeKey) || !this.allowed(command)) {
        this.cancel(command.id); cancellingAt ??= this.options.now();
      }
      if (cancellingAt !== null && this.options.now() - cancellingAt >= (this.options.cancelWaitMilliseconds ?? 5000)) throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
      await delay(this.options.pollMilliseconds ?? 25);
    }
  }
  safe(executionId: string): boolean { return this.store.safe(executionId); }
  /** Only a terminal native acknowledgement can settle the original action's unknown external receipt. */
  receipt(id: string): MinecraftLifecycleReceipt | null { return this.store.receipt(id); }
  cancelExecution(executionId: string): void { for (const row of this.store.pending()) if (row.command.authority.executionId === executionId) this.cancel(row.command.id); }
  authorize(principal: { scopeKey: string; deviceId: string }, id: string): boolean {
    if (principal.scopeKey !== this.configuration.ownerScopeKey || principal.deviceId !== this.configuration.deviceId) throw new Error('MINECRAFT_LIFECYCLE_DEVICE_DENIED');
    const row = this.store.pending().find(r => r.command.id === id), frame = this.store.frame();
    return !!row && row.delivered && !row.cancelled && !!frame && this.available(principal.scopeKey)
      && row.command.connectionId === frame.poll.connectionId && this.allowed(row.command);
  }
}
