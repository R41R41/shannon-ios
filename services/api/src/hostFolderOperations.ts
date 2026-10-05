import type { AutonomyConfig } from './autonomyBudget.js';
import { HOST_STEP_CODES, type HostStepCode } from './autonomyHostFolderPath.js';
import type { ClaimedHostStep, HostFolderDesk } from './autonomyHostFolderDesk.js';
import { resultFacts, type HostOperationResult } from './hostFolderOperationResults.js';
import type { HostOperation, HostOperationOrigin, HostOperationRow } from './hostFolderOperationsStore.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';

/**
 * v2 of her folder (`docs/host-folder-contract.md`): operations a tool call queues, the long-poll claim of the
 * bound device, and the device's report with a bounded result.
 *
 * `run` is the only entrance that queues an operation, and only the folder tools of the registry call it
 * (`shannonFolderTools.ts`). It fails at once when the device is not present, is stopped on its side, or cannot do
 * the operation, so nothing is left to run later by surprise; otherwise it waits a few seconds for the report and
 * drops an operation the device has not taken by then.
 *
 * The record: an operation from a conversation is written to the activity record when it closes (whatever closes
 * it: report, lease running out, or the tool giving up), with counts and never content. An operation from her own
 * time is recorded by its loop step against the gate's decision.
 */
export const HOST_PRESENCE_MILLISECONDS = 40_000;
export const HOST_CLAIM_MAXIMUM_WAIT_SECONDS = 25;
const LEASE_SECONDS: Readonly<Record<HostOperationOrigin, number>> = Object.freeze({ conversation: 15, autonomy: 60 });
const RESULT_RETENTION_MILLISECONDS = 120_000;
const CLAIM_POLL_MILLISECONDS = 500;
const RUN_POLL_MILLISECONDS = 200;

export type HostRunOutcome =
  | { kind: 'done'; result: HostOperationResult | undefined }
  | { kind: 'failed' | 'refused'; code: HostStepCode }
  | { kind: 'not_bound' | 'offline' | 'stopped' | 'unsupported' }
  | { kind: 'timeout'; handedOut: boolean };

export interface HostOperationRequest {
  host: string;
  origin: HostOperationOrigin;
  operation: HostOperation;
  tool: string;
  args: Record<string, unknown>;
  relativePath: string;
  toRelativePath?: string;
  waitMilliseconds: number;
}

export interface HostOperationRecorder {
  recordConversationAction(scopeKey: string, report: { summary: string; tool: string; outcome: 'done' | 'failed'; reasonCode?: string }): unknown;
}

/** In-process wake-ups: a queued operation wakes a held claim, a report wakes the waiting tool. Other processes are polled. */
export class HostFolderSignals {
  private readonly waiting = new Map<string, Set<() => void>>();

  notify(key: string): void {
    for (const wake of this.waiting.get(key) ?? []) wake();
  }

  wait(key: string, milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const set = this.waiting.get(key) ?? new Set();
      this.waiting.set(key, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) this.waiting.delete(key);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, milliseconds));
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

export interface HostClaimRequest { operations: readonly string[]; waitSeconds: number; localStop: boolean }
export type HostClaimedStep = ClaimedHostStep | (Record<string, unknown> & { id: string; operation: HostOperation; expiresAt: string });

export class HostFolderOperations {
  constructor(
    private readonly store: SQLiteAutonomyStore,
    private readonly config: AutonomyConfig,
    private readonly now: () => string,
    private readonly recorder: HostOperationRecorder,
    private readonly copies: HostFolderDesk,
    private readonly signals: HostFolderSignals = new HostFolderSignals(),
  ) {}

  /** The hosts whose folder a paired device works in, in the order they were registered. */
  boundHosts(): readonly string[] {
    return Object.keys(this.config.places.hostDevices ?? {});
  }

  /** Whether a tool call for this host could be handed to its device now. */
  presence(scopeKey: string, host: string, operation?: HostOperation): 'present' | 'not_bound' | 'offline' | 'stopped' | 'unsupported' {
    const bound = (this.config.places.hostDevices ?? {})[host];
    if (!bound || !Object.hasOwn(this.config.places.hostDevices ?? {}, host)) return 'not_bound';
    const seen = this.store.hostOperations.presence(scopeKey, host);
    if (!seen || seen.deviceId !== bound || Date.parse(this.now()) - Date.parse(seen.seenAt) > HOST_PRESENCE_MILLISECONDS) return 'offline';
    if (seen.localStop) return 'stopped';
    return operation && !seen.operations.includes(operation) ? 'unsupported' : 'present';
  }

  /** Queues one operation and waits for its report. The single entrance for v2 operations. */
  async run(scopeKey: string, request: HostOperationRequest, signal?: AbortSignal): Promise<HostRunOutcome> {
    const presence = this.presence(scopeKey, request.host, request.operation);
    if (presence !== 'present') return { kind: presence };
    const queuedAt = this.now();
    const deadline = Date.parse(queuedAt) + Math.max(0, request.waitMilliseconds);
    const row = this.store.hostOperations.enqueue(scopeKey, {
      host: request.host, origin: request.origin, operation: request.operation, tool: request.tool, args: request.args,
      relativePath: request.relativePath, ...(request.toRelativePath !== undefined ? { toRelativePath: request.toRelativePath } : {}),
      handOutBefore: new Date(deadline).toISOString(), leaseSeconds: LEASE_SECONDS[request.origin],
    }, queuedAt);
    this.signals.notify(queueKey(scopeKey, request.host));
    for (;;) {
      const current = this.store.hostOperations.get(scopeKey, row.id);
      if (current && current.status !== 'queued' && current.status !== 'leased') return this.finished(scopeKey, current);
      const left = deadline - Date.parse(this.now());
      if (left <= 0 || signal?.aborted) break;
      await this.signals.wait(operationKey(row.id), Math.min(RUN_POLL_MILLISECONDS, left), signal);
    }
    // Not taken in time: it is dropped so it never runs later. Taken: it may still finish, and is recorded when it does.
    const dropped = this.store.transaction(() => {
      const current = this.store.hostOperations.get(scopeKey, row.id);
      if (current?.status !== 'queued') return current;
      this.close(scopeKey, current, 'dropped', this.now());
      return null;
    });
    if (dropped && dropped.status !== 'leased') return this.finished(scopeKey, dropped);
    return { kind: 'timeout', handedOut: dropped !== null };
  }

  /** The long-poll claim of a v2 device. A step from v1 copies is handed out here too, through the v1 desk. */
  async claim(scopeKey: string, host: string, deviceId: string | undefined, request: HostClaimRequest, signal?: AbortSignal):
    Promise<{ step: HostClaimedStep | null } | 'HOST_NOT_BOUND'> {
    const devices = this.config.places.hostDevices ?? {};
    if (!deviceId || !Object.hasOwn(devices, host) || devices[host] !== deviceId) return 'HOST_NOT_BOUND';
    const seen = () => this.store.hostOperations.markSeen(scopeKey, host, { deviceId, seenAt: this.now(), localStop: request.localStop, operations: request.operations });
    seen();
    if (request.localStop) return { step: null };
    const deadline = Date.parse(this.now()) + Math.min(HOST_CLAIM_MAXIMUM_WAIT_SECONDS, Math.max(0, request.waitSeconds)) * 1_000;
    try {
      for (;;) {
        const step = this.handOut(scopeKey, host, deviceId, request.operations);
        if (step) return { step };
        const left = deadline - Date.parse(this.now());
        if (left <= 0 || signal?.aborted) return { step: null };
        await this.signals.wait(queueKey(scopeKey, host), Math.min(CLAIM_POLL_MILLISECONDS, left), signal);
      }
    } finally {
      // A device holding a claim is present; the hold ends with its next claim.
      seen();
    }
  }

  /** The device's report of a v2 operation. Null when the id is not one (it may be a v1 copy). */
  report(scopeKey: string, id: string, deviceId: string | undefined, input: { outcome: 'done' | 'failed' | 'refused'; code?: HostStepCode; result?: HostOperationResult }):
    { id: string; status: string; recorded: boolean } | 'HOST_STEP_NOT_FOUND' | null {
    const at = this.now();
    return this.store.transaction(() => {
      this.sweep(scopeKey, at);
      const row = this.store.hostOperations.get(scopeKey, id);
      if (!row) return null;
      if (!deviceId || row.deviceId !== deviceId) return 'HOST_STEP_NOT_FOUND';
      if (row.status !== 'leased') return { id, status: row.status, recorded: false };
      const code = input.outcome === 'done' ? undefined : input.code ?? 'unknown';
      this.close(scopeKey, row, input.outcome, at, { ...(code ? { code } : {}), ...(input.outcome === 'done' && input.result ? { result: input.result } : {}) });
      this.signals.notify(operationKey(id));
      return { id, status: input.outcome, recorded: true };
    });
  }

  /** The operation of a v2 step, for the report route; null when the id is not one (it may be a v1 copy). */
  operationKind(scopeKey: string, id: string): HostOperation | null {
    return this.store.hostOperations.get(scopeKey, id)?.operation ?? null;
  }

  private handOut(scopeKey: string, host: string, deviceId: string, operations: readonly string[]): HostClaimedStep | null {
    const at = this.now();
    const fromV2 = this.store.transaction(() => {
      this.sweep(scopeKey, at);
      this.copies.closeOverdue(scopeKey, at);
      if (this.store.hostOperations.leased(scopeKey, host) || this.store.hostSteps.leased(scopeKey, host)) return 'busy' as const;
      // Her own time's operations wait while she is switched off or paused; a conversation's are the owner's own requests.
      const row = this.store.hostOperations.nextQueued(scopeKey, host, operations, at, this.config.enabled && !this.paused(scopeKey));
      if (!row) return null;
      const expiresAt = new Date(Date.parse(at) + row.leaseSeconds * 1_000).toISOString();
      if (!this.store.hostOperations.lease(scopeKey, row.id, deviceId, expiresAt)) return null;
      return { ...row.args, id: row.id, operation: row.operation, expiresAt };
    });
    if (fromV2 === 'busy') return null;
    if (fromV2) return fromV2;
    if (!operations.includes('write')) return null;
    const copy = this.copies.claim(scopeKey, host, deviceId);
    return copy === 'HOST_NOT_BOUND' ? null : copy.step;
  }

  /** Closes leases that ran out and queued operations nobody waits for, and forgets untaken results. */
  private sweep(scopeKey: string, at: string): void {
    for (const row of this.store.hostOperations.stale(scopeKey, at)) this.close(scopeKey, row, row.status === 'leased' ? 'expired' : 'dropped', at);
    this.store.hostOperations.forgetResults(scopeKey, new Date(Date.parse(at) - RESULT_RETENTION_MILLISECONDS).toISOString());
  }

  private close(scopeKey: string, row: HostOperationRow, status: 'done' | 'failed' | 'refused' | 'expired' | 'dropped', at: string, detail: { code?: HostStepCode; result?: HostOperationResult } = {}): void {
    if (!this.store.hostOperations.close(scopeKey, row.id, status, at, detail)) return;
    if (row.origin !== 'conversation') return;
    const place = `自分のフォルダ（${row.host}）`;
    const target = `「${row.relativePath || 'いちばん上'}」`;
    const name = `${place}での${NAMES[row.operation]}（${target}${row.toRelativePath !== undefined ? `→「${row.toRelativePath}」` : ''}）`;
    this.recorder.recordConversationAction(scopeKey, {
      tool: row.tool, outcome: status === 'done' ? 'done' : 'failed', ...(detail.code ? { reasonCode: detail.code } : status === 'done' ? {} : { reasonCode: status }),
      summary: status === 'done' ? `${place}の${target}${DONE[row.operation](row.toRelativePath ?? '')}${resultFacts(row.operation, detail.result)}。`
        : status === 'expired' ? `${name}を端末に渡しましたが、時間内に結果が届きませんでした。どうなったかは分かりません。`
          : status === 'dropped' ? `${name}は、端末が受け取らなかったのでやめました。`
            : `${name}はできませんでした（${HOST_STEP_CODES[detail.code ?? 'unknown']}）。`,
    });
  }

  private finished(scopeKey: string, row: HostOperationRow): HostRunOutcome {
    if (row.status === 'done') return { kind: 'done', result: this.store.hostOperations.takeResult(scopeKey, row.id) as HostOperationResult | undefined };
    if (row.status === 'failed' || row.status === 'refused') return { kind: row.status, code: row.code ?? 'unknown' };
    return { kind: 'timeout', handedOut: row.status === 'expired' };
  }

  private paused(scopeKey: string): boolean {
    try { return this.store.control(scopeKey).paused; } catch { return true; }
  }
}

const NAMES: Readonly<Record<HostOperation, string>> = Object.freeze({
  list: '一覧', read: '読み取り', search: '検索', create: '作成', update: '書き換え', move: '移動', delete: '削除（ゴミ箱へ）',
});
const DONE: Readonly<Record<HostOperation, (to: string) => string>> = Object.freeze({
  list: () => 'の一覧を見ました', read: () => 'を読みました', search: () => 'の中を探しました', create: () => 'を作りました',
  update: () => 'を書き換えました', move: (to: string) => `を「${to}」に移しました`, delete: () => 'をゴミ箱に移しました',
});

function queueKey(scopeKey: string, host: string): string {
  return `queue:${scopeKey}:${host}`;
}

function operationKey(id: string): string {
  return `operation:${id}`;
}
