import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { VISION_FRAME_SCHEMA, type VisionFrameV1 } from '../../src/contracts/visionContract.js';
import type { VisionDecisionsAnswer, VisionDecisionsClient, VisionDecisionsRequest } from '../../src/infra/models/openAIVisionDecisions.js';
import { SQLiteVisionBudgetStore } from '../../src/mind/vision/store/visionBudgetStore.js';
import {
  VisionBudget, VisionFrameHolder, VisionWatch, type VisionAudienceNow, type VisionBridge, type VisionPerceptWire,
} from '../../src/mind/vision/visionPorts.js';

/** A marker no real picture contains: the privacy scans look for it, and for the base64 of the whole frame, in every sink. */
export const FRAME_MARKER = 'SYNTHETIC-VISION-FRAME-7f3a9c';

/** A synthetic JPEG-shaped frame (SOI, an APP0 segment holding the marker, EOI): never a camera image. */
export function syntheticJpeg(size = 2_048): Uint8Array {
  const body = Buffer.alloc(size, 0x5a);
  body.set([0xff, 0xd8, 0xff, 0xe0], 0);
  body.write(FRAME_MARKER, 8, 'ascii');
  body.set([0xff, 0xd9], size - 2);
  return new Uint8Array(body);
}

export function frameMeta(bytes: Uint8Array, at: number, overrides: Partial<VisionFrameV1> = {}): VisionFrameV1 {
  return {
    schema: VISION_FRAME_SCHEMA, frameId: `frame-${randomUUID()}`, capturedAt: new Date(at).toISOString(), receivedAt: null,
    source: { kind: 'app_camera', bodyId: null, deviceId: 'device-1' }, sessionId: 'watch-1', generation: 1, privacy: 'owner_private',
    audienceAtCapture: 'owner_alone', ttlMs: 4_000, encoding: { width: 512, height: 384, format: 'jpeg', byteLength: bytes.length },
    gate: { reason: 'difference', difference: 0.4, personCount: 1 }, state: null, ...overrides,
  };
}

export function answer(choice: string, predicate = 0.9, confidence = 0.8, inputTokens = 602): VisionDecisionsAnswer {
  return { predicate, choice: { id: choice, confidence, probabilities: [{ id: choice, probability: confidence }] }, refused: false,
    usage: { usageComplete: true, inputTokens, estimatedCostUsd: inputTokens * 0.1 / 1_000_000 }, elapsedMs: 250 };
}

export class FakeDecisions implements VisionDecisionsClient {
  readonly requests: VisionDecisionsRequest[] = [];
  next: Array<VisionDecisionsAnswer | Error> = [];
  /** Runs while the call is out (the test changes the audience, the clock, the generation). */
  during: (() => void) | null = null;
  async decide(request: VisionDecisionsRequest): Promise<VisionDecisionsAnswer> {
    this.requests.push(request);
    this.during?.();
    const value = this.next.shift() ?? answer('quiet', 0.1);
    if (value instanceof Error) throw value;
    return value;
  }
}

export class FakeBridge implements VisionBridge {
  audienceNow: VisionAudienceNow = 'owner_alone';
  readonly percepts: VisionPerceptWire[] = [];
  readonly notices: Array<{ decisionId: string; category: string }> = [];
  readonly escalations: Array<{ decisionId: string; base64: string }> = [];
  readonly presences: number[] = [];
  async audience() { return this.audienceNow; }
  async percept(_scopeKey: string, percept: VisionPerceptWire) { this.percepts.push(percept); }
  async notice(_scopeKey: string, notice: { decisionId: string; category: string }) { this.notices.push(notice); return { delivered: true }; }
  async escalate(_scopeKey: string, look: { decisionId: string; base64: string }) { this.escalations.push(look); return { seen: true }; }
  async presence(_scopeKey: string, presence: { personCount: number }) { this.presences.push(presence.personCount); }
}

export function visionWorld(options: { camera?: boolean; escalate?: boolean; halted?: boolean; capUsd?: number } = {}) {
  let clock = Date.parse('2026-10-14T09:00:00.000Z');
  const db = new DatabaseSync(':memory:');
  const ledger = new SQLiteVisionBudgetStore(db);
  const switches = { camera: options.camera ?? true, escalate: options.escalate ?? false, halted: options.halted ?? false };
  const budget = new VisionBudget({ ledger, dayKey: at => at.slice(0, 10), halted: () => switches.halted, ...(options.capUsd ? { dailyCapUsd: options.capUsd } : {}) });
  const decisions = new FakeDecisions();
  const bridge = new FakeBridge();
  const frames = new VisionFrameHolder(() => clock);
  const watch = new VisionWatch({ ownerScope: 'owner', budget, decisions, frames, bridge, now: () => clock,
    cameraWatch: () => switches.camera, escalate: () => switches.escalate });
  return {
    db, ledger, budget, decisions, bridge, frames, watch, switches,
    principal: { scopeKey: 'owner', deviceId: 'device-1' },
    now: () => clock,
    advance: (milliseconds: number) => { clock += milliseconds; },
  };
}
