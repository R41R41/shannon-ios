import { randomUUID } from 'node:crypto';
import {
  VISION_FRAME_REPLY_SCHEMA, VISION_LIMITS, VISION_STATUS_SCHEMA, visionCandidateOf, visionDecisionRecord, visionFrameFresh,
  type VisionDecisionV1, type VisionDiscardReason, type VisionFrameReply, type VisionFrameV1, type VisionStatus,
} from '../../contracts/visionContract.js';
import { VisionDecisionsError, type VisionDecisionsAnswer, type VisionDecisionsClient } from '../../infra/models/openAIVisionDecisions.js';
import { observeAsync, observeSync, withObserverRun } from '../../infra/observer/observerContext.js';
import type { VisionBudget, VisionDegradeLevel } from './visionBudget.js';
import {
  VISION_NOTICE_CHOICE, VISION_NOTICE_PREDICATE, VISION_NOTICE_THRESHOLDS, visionNoticeCandidates, visionNoticeContext, visionNoticeVerdict,
} from './visionCandidates.js';
import type { VisionFrameHolder } from './visionFrames.js';

/**
 * 「見て気づく」 of the camera (Syzygy ADR-0011 §4.3 and §4.4) in the vision worker: a frame that passed the device's gate is
 * checked again here (the owner's scope, freshness, the device's rate, one decision at a time, the audience now), reserved in
 * the budget, judged by one Decisions request (predicate and choice together), checked once more after the answer (generation,
 * audience, TTL), and delivered: a reaction back to the device at once, a notice and an escalation to the API through the
 * bridge, a percept to the workspace. The frame is dropped after its decision; nothing of it is written anywhere.
 */
export type VisionAudienceNow = 'owner_alone' | 'others' | 'unknown';
export interface VisionPerceptWire {
  code: string; probability: number; sourceId: string; sourceKind: string; body: string | null;
  privacy: 'owner_private'; ttlMs: number; frameRef: string | null; at: string;
}
/** What the worker asks of the API (`wiring/visionBridgeWiring.ts`). The API re-checks the audience for everything it says. */
export interface VisionBridge {
  audience(scopeKey: string): Promise<VisionAudienceNow>;
  percept(scopeKey: string, percept: VisionPerceptWire): Promise<void>;
  notice(scopeKey: string, notice: { decisionId: string; category: string; deviceId: string; at: string }): Promise<{ delivered: boolean }>;
  escalate(scopeKey: string, look: { decisionId: string; deviceId: string; mimeType: string; base64: string; width: number; height: number; at: string }):
    Promise<{ seen: boolean }>;
  presence(scopeKey: string, presence: { deviceId: string; personCount: number; at: string }): Promise<void>;
}
export interface VisionWatchOptions {
  ownerScope: string;
  budget: VisionBudget;
  /** Null without a Decisions key: every frame is answered `stop`. */
  decisions: VisionDecisionsClient | null;
  frames: VisionFrameHolder;
  bridge: VisionBridge;
  /** The camera source switch (`SHANNON_VISION_CAMERA`). */
  cameraWatch(): boolean;
  /** Escalation to a closer look (`SHANNON_VISION_ESCALATE`). */
  escalate(): boolean;
  now(): number;
  /** How long a percept stays in the workspace. */
  perceptTtlMs?: number;
  /** What was chosen, kept across restarts (`SQLiteVisionChoiceStore`); absent, in memory. */
  choices?: VisionChoiceLedger;
}
/** The camera notice's chosen candidates: cooldowns and the hourly cap read them. */
export interface VisionChoiceLedger {
  record(scopeKey: string, candidateId: string, kind: 'react' | 'notice' | 'escalate', at: string): void;
  lastChosenAt(scopeKey: string, candidateId: string): string | null;
  countSince(scopeKey: string, kinds: readonly ('react' | 'notice' | 'escalate')[], since: string): number;
}

/** The ledger in memory (tests, and a worker whose database could not hold it). */
export function memoryChoiceLedger(): VisionChoiceLedger {
  const rows: Array<{ scopeKey: string; candidateId: string; kind: 'react' | 'notice' | 'escalate'; at: string }> = [];
  return {
    record: (scopeKey, candidateId, kind, at) => { rows.push({ scopeKey, candidateId, kind, at }); },
    lastChosenAt: (scopeKey, candidateId) => rows.filter(row => row.scopeKey === scopeKey && row.candidateId === candidateId).at(-1)?.at ?? null,
    countSince: (scopeKey, kinds, since) => rows.filter(row => row.scopeKey === scopeKey && kinds.includes(row.kind) && row.at >= since).length,
  };
}
export interface VisionPrincipal { scopeKey: string; deviceId: string }
export type VisionFrameResult = { status: 200; reply: VisionFrameReply } | { status: 400 | 403 | 409 | 429; error: string; nextFrameNotBefore?: string };

interface DeviceState { lastAcceptedAt: number; inFlight: boolean; sessionId: string | null; generation: number }
type StopReason = VisionFrameReply['stopReason'];
const PERCEPT_TTL_MS = 10 * 60_000;
const iso = (time: number) => new Date(time).toISOString();

/** Whether the bytes start as the declared format does (JPEG SOI, PNG signature). */
function formatMatches(bytes: Uint8Array, mimeType: string, format: string): boolean {
  if (mimeType === 'image/jpeg') return format === 'jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return format === 'png' && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** Checks a frame body against its metadata: a JPEG or PNG of the declared size, within the limits. */
export function visionFrameBodyError(meta: VisionFrameV1, bytes: Uint8Array, mimeType: string): string | null {
  if (meta.source.kind !== 'app_camera' || meta.privacy !== 'owner_private' || meta.audienceAtCapture !== 'owner_alone') return 'VISION_SOURCE_REFUSED';
  const sized = bytes.length >= 4 && bytes.length <= VISION_LIMITS.frameBytes && bytes.length === meta.encoding.byteLength;
  if (!sized || Math.max(meta.encoding.width, meta.encoding.height) > VISION_LIMITS.longSide) return 'VISION_FRAME_SIZE';
  return formatMatches(bytes, mimeType, meta.encoding.format) ? null : 'VISION_FRAME_FORMAT';
}

export class VisionWatch {
  private readonly devices = new Map<string, DeviceState>();
  private readonly choices: VisionChoiceLedger;
  private readonly recent: string[] = [];
  private lastLevel: VisionDegradeLevel = 0;

  constructor(private readonly options: VisionWatchOptions) {
    this.choices = options.choices ?? memoryChoiceLedger();
  }

  /** `GET /v1/vision/status`: whether the device may watch now. */
  async status(principal: VisionPrincipal): Promise<VisionStatus> {
    const at = iso(this.options.now());
    const level = this.level(principal.scopeKey, at);
    const stop = this.stopReason(level, principal.scopeKey, at) ?? (await this.audience(principal.scopeKey) === 'owner_alone' ? null : 'audience');
    return {
      schema: VISION_STATUS_SCHEMA, watchAllowed: stop === null, reason: stop, degrade: level,
      limits: { judgeFramesPerSecond: VISION_LIMITS.judgeFramesPerSecond, sendIntervalMs: VISION_LIMITS.sendIntervalMs,
        longSide: VISION_LIMITS.longSide, frameBytes: VISION_LIMITS.frameBytes, ttlMs: VISION_LIMITS.cameraTtlMs },
    };
  }

  /** `POST /v1/vision/presence`: two or more people were seen. The device stops; the API hears a candidate for `others`. */
  async presence(principal: VisionPrincipal, personCount: number, at: string): Promise<void> {
    if (!Number.isSafeInteger(personCount) || personCount < 2) return;
    this.endSession(principal.deviceId);
    try {
      await this.options.bridge.presence(principal.scopeKey, { deviceId: principal.deviceId, personCount, at });
    } catch { /* the device has stopped either way */ }
  }

  /** `POST /v1/vision/frames`. */
  async frame(principal: VisionPrincipal, meta: VisionFrameV1, bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png'): Promise<VisionFrameResult> {
    const refused = visionFrameBodyError(meta, bytes, mimeType);
    if (refused) return { status: 400, error: refused };
    // A camera frame is never used past 4 s, whatever TTL the device sent (§4.4).
    if (meta.ttlMs > VISION_LIMITS.cameraTtlMs) meta = { ...meta, ttlMs: VISION_LIMITS.cameraTtlMs };
    if (meta.source.deviceId !== null && meta.source.deviceId !== principal.deviceId) return { status: 403, error: 'VISION_WRONG_DEVICE' };
    const now = this.options.now();
    const device = this.device(principal.deviceId);
    if (!this.currentSession(device, meta)) return { status: 409, error: 'VISION_STALE_GENERATION' };
    const next = device.lastAcceptedAt + VISION_LIMITS.sendIntervalMs;
    if (device.inFlight || now + 100 < next) return { status: 429, error: 'VISION_TOO_SOON', nextFrameNotBefore: iso(Math.max(next, now + 250)) };
    device.inFlight = true;
    device.lastAcceptedAt = now;
    try {
      const reply = await withObserverRun({ scopeKey: principal.scopeKey, surface: 'vision' },
        () => this.judged(principal, meta, bytes, mimeType, now));
      return { status: 200, reply };
    } finally {
      device.inFlight = false;
      this.options.frames.drop(meta.frameId);
    }
  }

  private async judged(principal: VisionPrincipal, meta: VisionFrameV1, bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png', started: number):
    Promise<VisionFrameReply> {
    const at = iso(started);
    const level = this.level(principal.scopeKey, at);
    const stop = await observeAsync('visionGate', { phase: 'frame', generation: meta.generation, level },
      async () => this.stopReason(level, principal.scopeKey, at) ?? (await this.audience(principal.scopeKey) === 'owner_alone' ? null : 'audience' as const),
      value => ({ stop: value }));
    if (stop) {
      this.endSession(principal.deviceId);
      return this.reply(meta, 'stop', stop, 'skipped', null, level);
    }
    if (!visionFrameFresh(meta, this.options.now())) return this.reply(meta, 'continue', null, 'discarded', null, level);
    const frameRef = this.options.frames.hold(meta, bytes, mimeType);
    const decision = await this.decide(principal, meta, frameRef, level as 0 | 1, started);
    // No room left in the day's vision budget for this call: the device stops watching (§7.3 level 2).
    if (decision.discardReason === 'budget') return this.reply(meta, 'stop', 'budget', 'skipped', null, level);
    await this.deliver(principal, meta, decision, frameRef);
    const chosen = decision.outcome === 'chosen' ? decision.choice.candidateId : null;
    return this.reply(meta, 'continue', null, decision.outcome, chosen, this.level(principal.scopeKey, iso(this.options.now())));
  }

  /** One Decisions call under a reservation, then the checks after it. Answers the decision record (never the picture). */
  private async decide(principal: VisionPrincipal, meta: VisionFrameV1, frameRef: string, level: 0 | 1, started: number): Promise<VisionDecisionV1> {
    const candidates = visionNoticeCandidates({ escalate: this.options.escalate() && level === 0 });
    const base = { decisionId: `vision-${randomUUID()}`, frameId: meta.frameId, sessionId: meta.sessionId ?? `watch-${principal.deviceId}`,
      generation: meta.generation ?? 1, source: meta.source, candidates: candidates.map(candidate => candidate.id), degrade: level };
    const reservation = this.options.budget.reserve(principal.scopeKey, 'decision', iso(started));
    if (!reservation) return this.record(base, null, 'skipped', 'budget', started, 0);
    const held = this.options.frames.get(meta.frameId);
    let answer: VisionDecisionsAnswer | null = null;
    let failure: VisionDiscardReason | null = null;
    const decided = this.options.now();
    try {
      answer = await observeAsync('visionDecision', { candidateCount: candidates.length, generation: base.generation, level },
        () => this.options.decisions!.decide({
          context: visionNoticeContext({ at: meta.capturedAt, recent: this.recent }),
          image: held ? { mimeType: held.mimeType, bytes: held.bytes } : null,
          predicate: VISION_NOTICE_PREDICATE, choice: { ...VISION_NOTICE_CHOICE, candidates }, signal: AbortSignal.timeout(3_000),
        }), value => ({ predicate: value.predicate, choice: value.choice?.id ?? null, confidence: value.choice?.confidence ?? null,
          inputTokens: value.usage.inputTokens, costUsd: value.usage.estimatedCostUsd, elapsedMs: value.elapsedMs }), { model: 'gpt-6-luna' });
      this.options.budget.close(reservation, answer.usage, iso(this.options.now()));
    } catch (error) {
      failure = this.failed(error, reservation);
    }
    // A timeout counts its full wait toward the p95, so a slow provider reaches level 1 (§7.3) and not only failures.
    this.options.budget.observed({ ok: answer !== null, elapsedMs: answer?.elapsedMs ?? this.options.now() - decided }, this.options.now());
    return this.checked(principal, meta, base, answer, failure, reservation.amountUsd, started, this.options.now() - decided);
  }

  private lastChosen(scopeKey: string, candidateId: string): number | null {
    try {
      const at = this.choices.lastChosenAt(scopeKey, candidateId);
      return at ? Date.parse(at) : null;
    } catch {
      // A ledger that cannot be read counts as just chosen: when unsure, quiet.
      return this.options.now();
    }
  }

  private remember(scopeKey: string, candidateId: string, now: number): void {
    const kind = visionCandidateOf(candidateId)?.kind;
    if (kind !== 'react' && kind !== 'notice' && kind !== 'escalate') return;
    try {
      this.choices.record(scopeKey, candidateId, kind, iso(now));
    } catch { /* the cooldown is then only as long as this process */ }
  }

  private failed(error: unknown, reservation: Parameters<VisionBudget['close']>[0]): VisionDiscardReason {
    const known = error instanceof VisionDecisionsError ? error.usage : null;
    this.options.budget.close(reservation, known, iso(this.options.now()));
    if (!(error instanceof VisionDecisionsError)) return 'http_error';
    return error.code === 'network' ? 'http_error' : error.code === 'usage_unknown' ? 'usage_unknown' : error.code;
  }

  /** After the answer: a newer generation, another audience or a passed TTL discards it (§8.1: never acted on, never re-asked). */
  private async checked(principal: VisionPrincipal, meta: VisionFrameV1, base: DecisionBase, answer: VisionDecisionsAnswer | null,
    failure: VisionDiscardReason | null, reservedUsd: number, started: number, decisionMs: number): Promise<VisionDecisionV1> {
    if (!answer) return this.record(base, null, 'failed', failure, started, reservedUsd, decisionMs);
    if (answer.refused) return this.record(base, answer, 'refused', null, started, reservedUsd, decisionMs);
    const device = this.device(principal.deviceId);
    const stale = device.sessionId !== meta.sessionId || (meta.generation ?? 1) < device.generation;
    const discard: VisionDiscardReason | null = stale ? 'stale_generation' : !visionFrameFresh(meta, this.options.now()) ? 'expired'
      : await this.audience(principal.scopeKey) !== 'owner_alone' ? 'audience_changed' : null;
    if (discard) return this.record(base, answer, 'discarded', discard, started, reservedUsd, decisionMs);
    const level = this.level(principal.scopeKey, iso(this.options.now()));
    const now = this.options.now();
    const verdict = visionNoticeVerdict({ predicate: answer.predicate, choiceId: answer.choice?.id ?? null, confidence: answer.choice?.confidence ?? null,
      level: level === 0 ? 0 : 1, now, lastChosenAt: id => this.lastChosen(principal.scopeKey, id),
      spokenLastHour: this.choices.countSince(principal.scopeKey, ['notice', 'escalate'], iso(now - 60 * 60_000)) });
    const record = this.record({ ...base, degrade: level }, answer, verdict.outcome, verdict.discardReason, started, reservedUsd, decisionMs,
      verdict.candidateId);
    if (verdict.candidateId) {
      this.remember(principal.scopeKey, verdict.candidateId, now);
      this.recent.push(verdict.candidateId);
      if (this.recent.length > 8) this.recent.shift();
    }
    return record;
  }

  private record(base: DecisionBase, answer: VisionDecisionsAnswer | null, outcome: VisionDecisionV1['outcome'], discardReason: VisionDiscardReason | null,
    started: number, reservedUsd: number, decisionMs: number | null = null, chosen: string | null = null): VisionDecisionV1 {
    const choice = answer?.choice;
    const record = visionDecisionRecord({
      ...base, gate: { probability: answer?.predicate ?? null, threshold: VISION_NOTICE_THRESHOLDS.gate },
      choice: { candidateId: chosen ?? (outcome === 'discarded' ? choice?.id ?? null : null), confidence: choice?.confidence ?? null,
        probabilities: (choice?.probabilities ?? []).map(entry => ({ id: entry.id, probability: entry.probability })) },
      outcome, discardReason, timings: { queuedMs: 0, decisionMs, totalMs: this.options.now() - started },
      cost: { reservedUsd, estimatedUsd: answer?.usage.estimatedCostUsd ?? null, inputTokens: answer?.usage.inputTokens ?? null,
        usageComplete: answer?.usage.usageComplete ?? false },
      decidedAt: iso(this.options.now()),
    });
    // The Observer's `vision` section: candidate ids, probabilities, timings, cost, generation, discarded answers; never a picture.
    observeSync('visionAct', { phase: 'decision' }, () => record, value => ({ ...value, source: value.source.kind }));
    return record;
  }

  /** Where a chosen candidate goes: a reaction rides on the reply; a notice and an escalation go to the API; a percept to the workspace. */
  private async deliver(principal: VisionPrincipal, meta: VisionFrameV1, decision: VisionDecisionV1, frameRef: string): Promise<void> {
    const id = decision.outcome === 'chosen' ? decision.choice.candidateId : null;
    const candidate = id ? visionCandidateOf(id) : null;
    if (!candidate || !id) return;
    const at = iso(this.options.now());
    const probability = decision.gate.probability ?? 0;
    const percept: VisionPerceptWire = { code: id, probability, sourceId: decision.decisionId, sourceKind: meta.source.kind,
      body: principal.deviceId, privacy: 'owner_private', ttlMs: this.options.perceptTtlMs ?? PERCEPT_TTL_MS, frameRef: null, at };
    await observeAsync('visionAct', { phase: 'deliver', kind: candidate.kind }, async () => {
      await this.options.bridge.percept(principal.scopeKey, percept).catch(() => undefined);
      if (candidate.kind === 'notice') await this.notice(principal, decision, candidate.category!, at);
      if (candidate.kind === 'escalate') await this.escalateLook(principal, meta, decision, frameRef, at);
    }, () => ({ kind: candidate.kind }));
  }

  private async notice(principal: VisionPrincipal, decision: VisionDecisionV1, category: string, at: string): Promise<void> {
    const reservation = this.options.budget.reserve(principal.scopeKey, 'notice_line', at);
    if (!reservation) return;
    try {
      await this.options.bridge.notice(principal.scopeKey, { decisionId: decision.decisionId, category, deviceId: principal.deviceId, at });
    } catch { /* not delivered: nothing is re-sent */ }
    // The line's usage is booked by the model's own route; here the reservation is kept at its bound.
    this.options.budget.close(reservation, null, iso(this.options.now()));
  }

  private async escalateLook(principal: VisionPrincipal, meta: VisionFrameV1, decision: VisionDecisionV1, _frameRef: string, at: string): Promise<void> {
    const held = this.options.frames.get(meta.frameId);
    if (!held) return;
    const reservation = this.options.budget.reserve(principal.scopeKey, 'escalate', at);
    if (!reservation) return;
    try {
      await this.options.bridge.escalate(principal.scopeKey, { decisionId: decision.decisionId, deviceId: principal.deviceId,
        mimeType: held.mimeType, base64: Buffer.from(held.bytes).toString('base64'), width: meta.encoding.width, height: meta.encoding.height, at });
    } catch { /* not seen: nothing is re-sent */ }
    this.options.budget.close(reservation, null, iso(this.options.now()));
  }

  private reply(meta: VisionFrameV1, watch: 'continue' | 'stop', stopReason: StopReason, outcome: VisionFrameReply['outcome'],
    candidateId: string | null, level: VisionDegradeLevel): VisionFrameReply {
    const candidate = candidateId ? visionCandidateOf(candidateId) : null;
    return { schema: VISION_FRAME_REPLY_SCHEMA, frameId: meta.frameId, watch, stopReason, outcome, candidateId,
      reaction: candidate?.kind === 'react' ? candidate.reaction : null, degrade: level,
      nextFrameNotBefore: iso(this.options.now() + VISION_LIMITS.sendIntervalMs) };
  }

  private stopReason(level: VisionDegradeLevel, scopeKey: string, at: string): StopReason {
    if (!this.options.cameraWatch() || !this.options.decisions || level === 3) return 'disabled';
    if (level < 2) return null;
    return this.options.budget.spentUsd(scopeKey, at) >= this.options.budget.capUsd ? 'budget' : 'degraded';
  }

  /** The level now; a change is perceived once (ADR-0009 D7: she sees herself). */
  private level(scopeKey: string, at: string): VisionDegradeLevel {
    let level: VisionDegradeLevel;
    try {
      level = this.options.budget.level(scopeKey, at);
    } catch {
      level = 2;
    }
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      const percept: VisionPerceptWire = { code: `degrade:${level}`, probability: 1, sourceId: `degrade-${randomUUID()}`, sourceKind: 'app_camera',
        body: null, privacy: 'owner_private', ttlMs: this.options.perceptTtlMs ?? PERCEPT_TTL_MS, frameRef: null, at };
      void this.options.bridge.percept(scopeKey, percept).catch(() => undefined);
    }
    return level;
  }

  private async audience(scopeKey: string): Promise<VisionAudienceNow> {
    try {
      return scopeKey === this.options.ownerScope ? await this.options.bridge.audience(scopeKey) : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private device(deviceId: string): DeviceState {
    let state = this.devices.get(deviceId);
    if (!state) {
      state = { lastAcceptedAt: 0, inFlight: false, sessionId: null, generation: 0 };
      this.devices.set(deviceId, state);
    }
    return state;
  }

  /** A frame of the current watch session (or of a newer one, which becomes current); an older generation is stale. */
  private currentSession(device: DeviceState, meta: VisionFrameV1): boolean {
    const generation = meta.generation ?? 1;
    if (meta.sessionId !== device.sessionId) {
      device.sessionId = meta.sessionId;
      device.generation = generation;
      return true;
    }
    if (generation < device.generation) return false;
    device.generation = generation;
    return true;
  }

  private endSession(deviceId: string): void {
    const device = this.device(deviceId);
    device.generation += 1;
  }
}

type DecisionBase = Pick<VisionDecisionV1, 'decisionId' | 'frameId' | 'sessionId' | 'generation' | 'source' | 'candidates' | 'degrade'>;
