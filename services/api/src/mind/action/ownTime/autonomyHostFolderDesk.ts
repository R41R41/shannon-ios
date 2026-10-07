import type { AutonomyActivityEntry } from '../../inhibition/inhibitionPorts.js';
import { autonomyDayKey, type AutonomyConfig } from '../../inhibition/inhibitionPorts.js';
import {
  HOST_FOLDER_LIMITS, HOST_STEP_CODES, ROOM_LOOK_GUARD, copyableStudyPiece, roomLookGuard, hostStepContentDigest, studyCopyContent, studyCopyPath,
  type HostStepCode,
} from './autonomyHostFolderPath.js';
import type { HostStep, HostStepStatus } from './store/autonomyHostFolderSteps.js';
import type { AutonomousActionRequest } from '../../inhibition/inhibitionPorts.js';
import type { ActionReport, RecordedDecision } from './autonomyService.js';
import type { SQLiteAutonomyStore } from './store/autonomyStore.js';
import { STUDY_KIND_LABEL, type StudyPiece, type StudyPieceKind } from './store/studyStore.js';

/**
 * Her folder on the owner's PC and Mac, stage 1: write-out only (`docs/host-folder-contract.md`).
 *
 * Her activity loop queues a copy of a note, or of a story she has called 「見せてもいい」.
 * The one paired device bound to the host claims it, writes the file inside the folder the
 * owner chose, and reports. The gate is asked twice: when she queues, and again at the
 * moment the text is handed to the device, so the stop switch holds at both. Nothing comes
 * back from the folder but an outcome and a code from a fixed set.
 *
 * Only the text of a study piece can be queued. There is no entrance here for code,
 * memory, the persona, or a prompt, which is what keeps this from being self-replication.
 */
export interface HostFolderGate {
  authorize(scopeKey: string, request: AutonomousActionRequest): RecordedDecision;
  recordAction(scopeKey: string, report: ActionReport): AutonomyActivityEntry;
}

export interface HostFolderCopy {
  host: string;
  pieceId: string;
  pieceVersion: number;
  kind: StudyPieceKind;
  kindLabel: string;
  title: string;
  relativePath: string;
}

export interface ClaimedHostStep {
  id: string;
  operation: 'write';
  relativePath: string;
  content: string;
  contentSha256: string;
  bytes: number;
  /** The report must arrive before this; afterwards the step is closed as failed. */
  expiresAt: string;
}

export type HostStepOutcome = 'done' | 'failed' | 'refused';
export interface HostStepReceipt { id: string; status: HostStepStatus; /** False when the step was already closed. */ recorded: boolean }

const WRITE_TOOL = 'folder.write';

export class HostFolderDesk {
  constructor(
    private readonly store: SQLiteAutonomyStore,
    private readonly config: AutonomyConfig,
    private readonly now: () => string,
    private readonly gate: HostFolderGate,
  ) {}

  /** Hosts whose folder a paired device works in, in the order they were registered. */
  boundHosts(): readonly string[] {
    return Object.keys(this.config.places.hostDevices ?? {});
  }

  /**
   * The hosts a copy may be planned for: bound, and not a device whose last v2 claim left `write` out (the Mac app
   * reads only, A18 S2). A host whose device has not made a v2 claim yet keeps v1's meaning.
   */
  copyHosts(scopeKey: string): readonly string[] {
    const devices = this.config.places.hostDevices ?? {};
    return this.boundHosts().filter(host => {
      const seen = this.store.hostOperations.presence(scopeKey, host);
      return !seen || seen.deviceId !== devices[host] || seen.operations.includes('write');
    });
  }

  /** True while a host can take a copy and today's count has room: the only time a copy is planned. */
  available(scopeKey: string, at: string): boolean {
    return this.copyHosts(scopeKey).length > 0
      && this.store.hostSteps.queuedOn(scopeKey, autonomyDayKey(at, this.config)) < this.config.maximumHostFolderWritesPerDay;
  }

  /** The copy she would queue next: the named piece, or the newest one a bound host does not have yet. */
  nextCopy(scopeKey: string, at: string, pieceId?: string): HostFolderCopy | null {
    if (!this.available(scopeKey, at)) return null;
    const named = pieceId ? this.store.study.get(scopeKey, pieceId) : null;
    const seen = this.roomLook(scopeKey);
    for (const piece of pieceId ? (named ? [named] : []) : this.store.study.list(scopeKey)) {
      // What she wrote after reading the owner's never goes into a file, where a later session could read it back unmarked (ADR-0007).
      if (this.informed(scopeKey, piece.id)) continue;
      const host = this.copyHosts(scopeKey).find(name => !this.store.hostSteps.hasCopy(scopeKey, name, piece.id, piece.version));
      const draft = host ? this.draft(piece, seen) : null;
      if (host && draft) {
        return { host, pieceId: piece.id, pieceVersion: piece.version, kind: piece.kind, kindLabel: STUDY_KIND_LABEL[piece.kind], title: piece.title, relativePath: draft.relativePath };
      }
    }
    return null;
  }

  /** A piece marked by the provenance mark (`ownerInformedMarks.ts`); one that cannot be read counts as marked. */
  private informed(scopeKey: string, pieceId: string): boolean {
    try { return this.store.informed.marked(scopeKey, `shannon-study://${pieceId}`); } catch { return true; }
  }

  /** Queues the copy. Everything is read again here, so what leaves is the piece as it is when the step is recorded. */
  enqueue(scopeKey: string, copy: Pick<HostFolderCopy, 'host' | 'pieceId' | 'pieceVersion'>, at: string): HostStep {
    return this.store.transaction(() => {
      const dayKey = autonomyDayKey(at, this.config);
      if (!this.boundHosts().includes(copy.host)) throw new Error('HOST_STEP_HOST_NOT_BOUND');
      if (!this.copyHosts(scopeKey).includes(copy.host)) throw new Error('HOST_STEP_HOST_CANNOT_WRITE');
      if (this.store.hostSteps.queuedOn(scopeKey, dayKey) >= this.config.maximumHostFolderWritesPerDay) throw new Error('HOST_STEP_DAILY_LIMIT');
      const piece = this.store.study.get(scopeKey, copy.pieceId);
      const draft = piece && piece.version === copy.pieceVersion ? this.draft(piece, this.roomLook(scopeKey)) : null;
      if (!piece || !draft || this.informed(scopeKey, piece.id)) throw new Error('HOST_STEP_PIECE_NOT_COPYABLE');
      if (this.store.hostSteps.hasCopy(scopeKey, copy.host, piece.id, piece.version)) throw new Error('HOST_STEP_ALREADY_QUEUED');
      return this.store.hostSteps.enqueue(scopeKey, { host: copy.host, dayKey, pieceId: piece.id, pieceVersion: piece.version, ...draft }, at);
    });
  }

  /**
   * At most one step for the device bound to `host`. While she is switched off or paused
   * nothing is handed out and the gate is not asked, so polling leaves no trace in the record.
   */
  claim(scopeKey: string, host: string, deviceId: string | undefined): { step: ClaimedHostStep | null } | 'HOST_NOT_BOUND' {
    const devices = this.config.places.hostDevices ?? {};
    if (!deviceId || !Object.hasOwn(devices, host) || devices[host] !== deviceId) return 'HOST_NOT_BOUND';
    if (!this.config.enabled || this.paused(scopeKey)) return { step: null };
    const at = this.now();
    return this.store.transaction(() => {
      this.closeOverdue(scopeKey, at);
      // One step at a time per host: a second claim waits for the report or for the lease to run out.
      if (this.store.hostSteps.leased(scopeKey, host)) return { step: null };
      const step = this.store.hostSteps.nextQueued(scopeKey, host);
      if (!step) return { step: null };
      const decision = this.gate.authorize(scopeKey, {
        domain: 'host_folder', host, relativePath: step.relativePath, tool: WRITE_TOOL,
        summary: `自分のフォルダ（${host}）に「${step.relativePath}」を置きます。`,
      });
      if (decision.decision !== 'allow' || decision.domain !== 'host_folder') {
        // Switched off or paused in this instant: it waits. Anything else will not change by waiting, so it is dropped.
        if (decision.reason !== 'paused' && decision.reason !== 'disabled') this.store.hostSteps.close(scopeKey, step.id, 'dropped', at, { decisionId: decision.activityId });
        return { step: null };
      }
      const piece = this.store.study.get(scopeKey, step.pieceId);
      if (!piece || piece.status === 'put_away' || hostStepContentDigest(step.content).sha256 !== step.contentSha256) {
        this.store.hostSteps.close(scopeKey, step.id, 'dropped', at, { decisionId: decision.activityId });
        this.gate.recordAction(scopeKey, {
          decisionId: decision.activityId, outcome: 'failed', tool: WRITE_TOOL,
          summary: `「${step.relativePath}」は、元の作品がしまわれたか確かめられなかったため、置くのをやめました。`,
        });
        return { step: null };
      }
      const expiresAt = new Date(Date.parse(at) + this.config.hostStepLeaseMilliseconds).toISOString();
      if (!this.store.hostSteps.lease(scopeKey, step.id, { deviceId, decisionId: decision.activityId, leaseUntil: expiresAt })) throw new Error('HOST_STEP_NOT_QUEUED');
      return { step: {
        id: step.id, operation: step.operation, relativePath: step.relativePath, content: step.content,
        contentSha256: step.contentSha256, bytes: step.bytes, expiresAt,
      } };
    });
  }

  /** The device's one report for a step it holds. A repeat returns what was recorded and writes nothing. */
  report(
    scopeKey: string, id: string, deviceId: string | undefined,
    input: { outcome: HostStepOutcome; code?: HostStepCode; bytes?: number },
  ): HostStepReceipt | 'HOST_STEP_NOT_FOUND' {
    const at = this.now();
    return this.store.transaction(() => {
      this.closeOverdue(scopeKey, at);
      const step = this.store.hostSteps.get(scopeKey, id);
      // A step is known only to the device it was handed to.
      if (!step || !deviceId || step.deviceId !== deviceId) return 'HOST_STEP_NOT_FOUND';
      if (step.status !== 'leased' || !step.claimDecisionId) return { id, status: step.status, recorded: false };
      const code = input.outcome === 'done' ? undefined : input.code ?? 'unknown';
      if (!this.store.hostSteps.close(scopeKey, id, input.outcome, at, { ...(code ? { code } : {}), ...(input.bytes !== undefined ? { bytes: input.bytes } : {}) })) {
        return { id, status: step.status, recorded: false };
      }
      const place = `自分のフォルダ（${step.host}）`;
      this.gate.recordAction(scopeKey, {
        decisionId: step.claimDecisionId, outcome: input.outcome === 'done' ? 'done' : 'failed', tool: WRITE_TOOL,
        ...(input.outcome === 'done' ? { link: `shannon-study://${step.pieceId}` } : {}),
        summary: input.outcome === 'done' ? `${place}に「${step.relativePath}」を置きました。`
          : input.outcome === 'refused' ? `${place}に「${step.relativePath}」を置くことを、端末が断りました（${HOST_STEP_CODES[code!]}）。`
          : `${place}に「${step.relativePath}」を置けませんでした（${HOST_STEP_CODES[code!]}）。`,
      });
      return { id, status: input.outcome, recorded: true };
    });
  }

  /** Closes every lease that ran out without a report: recorded as failed, never handed out again. */
  closeOverdue(scopeKey: string, at: string = this.now()): number {
    return this.store.transaction(() => {
      let closed = 0;
      for (const step of this.store.hostSteps.overdue(scopeKey, at)) {
        if (!this.store.hostSteps.close(scopeKey, step.id, 'expired', at)) continue;
        closed += 1;
        if (!step.claimDecisionId) continue;
        this.gate.recordAction(scopeKey, {
          decisionId: step.claimDecisionId, outcome: 'failed', tool: WRITE_TOOL,
          summary: `自分のフォルダ（${step.host}）に「${step.relativePath}」を渡しましたが、時間内に結果が届きませんでした。置けたかどうかは分かりません。やり直しません。`,
        });
      }
      return closed;
    });
  }

  /** A note that restates her note about a look at the room is not copied either (`roomLookGuard`). */
  private roomLook(scopeKey: string): (text: string) => boolean {
    return roomLookGuard(this.store.study.roomLookTexts(scopeKey, ROOM_LOOK_GUARD.notes));
  }

  private draft(piece: StudyPiece, seen: (text: string) => boolean): { relativePath: string; content: string; contentSha256: string; bytes: number } | null {
    if (!copyableStudyPiece(piece) || seen(`${piece.title}\n${piece.body}`)) return null;
    const relativePath = studyCopyPath(piece, autonomyDayKey(piece.createdAt, this.config));
    const content = studyCopyContent(piece);
    const digest = hostStepContentDigest(content);
    return relativePath && digest.bytes <= HOST_FOLDER_LIMITS.bytes ? { relativePath, content, contentSha256: digest.sha256, bytes: digest.bytes } : null;
  }

  /** A stop switch that cannot be read counts as on, as in the gate. */
  private paused(scopeKey: string): boolean {
    try { return this.store.control(scopeKey).paused; } catch { return true; }
  }
}
