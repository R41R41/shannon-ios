import { setTimeout as delay } from 'node:timers/promises';
import type { MinecraftBodyConfiguration } from '../../contracts/minecraftBodyContract.js';
import { LIFECYCLE_CAPABILITY_FRESH_WORLD, lifecycleCapabilities, validLifecyclePoll, type MinecraftLifecycleAuthority, type MinecraftLifecycleCommand,
  type MinecraftLifecyclePoll, type MinecraftLifecycleReceipt, type MinecraftLifecycleReply, type MinecraftLifecycleRequest, type MinecraftLifecycleState }
  from '../../contracts/minecraftLifecycleContract.js';
import { MinecraftLifecycleStore } from './store/minecraftLifecycleStore.js';

/** No process execution here: the configured, paired operator owns native state and commands. */
export class MinecraftLifecycle {
  constructor(readonly store: MinecraftLifecycleStore, readonly configuration: MinecraftBodyConfiguration,
    private readonly options: { now(): number; allowed(authority: MinecraftLifecycleAuthority, command?: MinecraftLifecycleCommand): boolean;
      servers?: ReadonlySet<string>; pollMilliseconds?: number; waitMilliseconds?: number; cancelWaitMilliseconds?: number;
      /**
       * 「新しいワールドで始める」 (`wiring/freshWorldWiring.ts`), asked only for a NEW command that carries `options.freshWorld`, just
       * before it is stored: write the decision to the activity record and answer whether the command may carry the option. False
       * (or a throw) sends an ordinary start instead; nothing about the world is claimed. `aborted` follows when the command then
       * could not be stored, `settled` when its receipt is accepted (best effort, never throws into the poll).
       */
      freshWorld?: { issue(command: MinecraftLifecycleCommand): boolean; aborted(command: MinecraftLifecycleCommand): void;
        settled(command: MinecraftLifecycleCommand, receipt: MinecraftLifecycleReceipt): void } }) {}
  private state(serverId: string): MinecraftLifecycleState | null {
    const frame = this.store.frame();
    if (!frame || this.options.now() - frame.receivedAt > 3000) return null;
    return frame.poll.states.find(s => s.serverId === serverId) ?? null;
  }
  available(scopeKey: string): boolean { const frame = this.store.frame(); return scopeKey === this.configuration.ownerScopeKey && !!frame && this.options.now() - frame.receivedAt <= 3000; }
  status(scopeKey: string): readonly MinecraftLifecycleState[] { return this.available(scopeKey) ? this.store.frame()!.poll.states : []; }
  /**
   * Whether the body that sent the latest fresh frame advertised the capability. The frame is replaced by every poll, so a body that
   * was replaced by an older build, or that went away, stops counting at once (a frame older than 3 s counts for nothing).
   */
  supports(scopeKey: string, capability: string): boolean {
    return this.available(scopeKey) && lifecycleCapabilities(this.store.frame()!.poll).has(capability);
  }
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
      if (this.store.settle(receipt)) {
        acknowledged.push(receipt.id);
        if (c.options?.freshWorld) { try { this.options.freshWorld?.settled(c, receipt); } catch { /* the record of the result never fails a poll */ } }
      }
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
      // The body's reply carries ordinary state only (no time of day): its RCON confirmation is the `changed` code.
      case 'set_day': return r.state.running === 'running' && r.code === 'changed' && r.stopGuard === undefined;
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
  /**
   * A fresh-world start keeps its option only if the body connected right now says it can do it and the decision could be written
   * down; otherwise it is the ordinary start (the caller decided on an earlier frame, and a new world is never claimed on a doubt).
   */
  private decidedFreshWorld(command: MinecraftLifecycleCommand): { command: MinecraftLifecycleCommand; issuedFreshWorld: boolean } {
    if (!command.options?.freshWorld) return { command, issuedFreshWorld: false };
    let ok = false;
    try {
      ok = this.supports(command.authority.scopeKey, LIFECYCLE_CAPABILITY_FRESH_WORLD) && !!this.options.freshWorld?.issue(command);
    } catch {
      ok = false;
    }
    if (ok) return { command, issuedFreshWorld: true };
    const { options: _dropped, ...ordinary } = command;
    return { command: ordinary, issuedFreshWorld: false };
  }
  private abortedFreshWorld(command: MinecraftLifecycleCommand): void {
    try {
      this.options.freshWorld?.aborted(command);
    } catch { /* best effort: the line is a compensation for a record, not part of the command */ }
  }
  async execute(request: MinecraftLifecycleRequest, signal?: AbortSignal): Promise<MinecraftLifecycleReceipt> {
    const previous = this.store.command(request.id);
    if (previous) {
      if (previous.action !== request.action || previous.serverId !== request.serverId || JSON.stringify(previous.authority) !== JSON.stringify(request.authority)
        || JSON.stringify(previous.options ?? null) !== JSON.stringify(request.options ?? null)) throw new Error('MINECRAFT_LIFECYCLE_OPERATION_CONFLICT');
      const receipt = this.store.receipt(request.id);
      if (receipt && receipt.outcome !== 'unknown' && receipt.inputsReleased) return receipt;
      throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
    }
    signal?.throwIfAborted();
    if (!this.available(request.authority.scopeKey) || !this.state(request.serverId)) throw new Error('MINECRAFT_LIFECYCLE_UNAVAILABLE');
    const asked: MinecraftLifecycleCommand = { ...request, schemaVersion: 1, connectionId: this.store.frame()!.poll.connectionId,
      issuedAt: new Date(this.options.now()).toISOString(),
      deadlineAt: new Date(this.options.now() + (this.options.waitMilliseconds ?? 120_000)).toISOString() };
    if (!this.allowed(asked)) throw new Error('MINECRAFT_LIFECYCLE_AUTHORITY_DENIED');
    // A new ID is not a retry path around an unresolved physical operation.
    if (this.store.unresolved()) throw new Error('MINECRAFT_LIFECYCLE_BUSY');
    const { command, issuedFreshWorld } = this.decidedFreshWorld(asked);
    try {
      this.store.insert(command);
    } catch (error) {
      if (issuedFreshWorld) this.abortedFreshWorld(command);
      throw error;
    }
    let cancellingAt: number | null = null;
    for (;;) {
      const receipt = this.store.receipt(command.id);
      if (receipt) {
        if (receipt.outcome === 'unknown' || !receipt.inputsReleased) throw new Error('MINECRAFT_LIFECYCLE_OUTCOME_UNKNOWN');
        return receipt;
      }
      // 2026-10-13 (Ops login): a delivered command is the operator's to finish; while it actuates (a start or a login takes
      // tens of seconds) its frames may pause, and that pause alone revoked a login that then spawned. A stale frame stops
      // only a command not yet delivered; the original authority, its deadline and the caller's signal still stop either.
      const stale = !this.available(request.authority.scopeKey) && !this.store.delivered(command.id);
      if (signal?.aborted || stale || !this.allowed(command)) {
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
