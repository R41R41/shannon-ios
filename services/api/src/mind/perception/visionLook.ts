import { randomUUID } from 'node:crypto';
import {
  VISION_FRAME_SCHEMA, checkedVisionFrame, type VisionAudience, type VisionFrameV1, type VisionSourceKind,
} from '../../contracts/visionContract.js';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { MindPerceiver } from './perceiver.js';
import { visionPerception } from './visionPerception.js';

/**
 * `look(source, purpose)` (Syzygy ADR-0011 §4.2, stage 1 slice 6): the one shape every look takes once its frame was used, whichever
 * path took it (a look through the owner's app, a look through her body's camera, a photo shared in a call, an escalation from the
 * camera's notice). It writes nothing of the picture: it describes the frame as `vision.frame.v1`, sends the same closed percept to
 * the workspace, and the same line to the Observer's `vision` section. The audience is the one the API holds when the frame was used.
 */
export const VISION_LOOK_SOURCES = Object.freeze(['app_look', 'body_look', 'photo', 'app_camera'] as const satisfies readonly VisionSourceKind[]);
export type VisionLookSource = typeof VISION_LOOK_SOURCES[number];
export const VISION_LOOK_PURPOSES = Object.freeze(['owner_asked', 'curious', 'shared_photo', 'own_time', 'escalate'] as const);
export type VisionLookPurpose = typeof VISION_LOOK_PURPOSES[number];

export interface VisionLookImage { format: 'jpeg' | 'png'; byteLength: number; width: number; height: number }
export interface VisionLookInput {
  scopeKey: string;
  source: VisionLookSource;
  purpose: VisionLookPurpose;
  deviceId: string | null;
  /** `seen`: the model saw it and she said something; `not_seen`: it failed; `withheld`: the audience changed and nothing was said. */
  outcome: 'seen' | 'not_seen' | 'withheld';
  audience: VisionAudience;
  at: string;
  image: VisionLookImage | null;
  perceiver?: MindPerceiver | null;
}

const LOOK_TTL_MS = 10 * 60_000;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;

/** Width and height of a JPEG (its first frame header) or a PNG (its IHDR), or null. Reads the header only. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  let offset = 2;
  while (bytes[0] === 0xff && bytes[1] === 0xd8 && offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const word = (at: number) => (bytes[offset + at]! << 8) | bytes[offset + at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: word(5), width: word(7) };
    offset += 2 + length;
  }
  return null;
}

/** The frame record of a look (no picture), or null when the image is unknown or outside the contract. */
export function visionLookFrame(input: VisionLookInput): VisionFrameV1 | null {
  if (!input.image || input.image.width < 1 || input.image.height < 1) return null;
  const checked = checkedVisionFrame({
    schema: VISION_FRAME_SCHEMA, frameId: `look-${randomUUID()}`, capturedAt: input.at, receivedAt: input.at,
    source: { kind: input.source, bodyId: null, deviceId: input.deviceId && DEVICE_ID.test(input.deviceId) ? input.deviceId : null },
    sessionId: null, generation: null, privacy: input.audience === 'owner_alone' ? 'owner_private' : 'shared_room',
    audienceAtCapture: input.audience, ttlMs: 60_000, encoding: { ...input.image }, gate: null, state: null,
  });
  return typeof checked === 'string' ? null : checked;
}

/** One look, used: its frame record, its percept and its Observer line. Never throws; perception never stops a look. */
export function visionLook(input: VisionLookInput): VisionFrameV1 | null {
  try {
    const frame = visionLookFrame(input);
    observeSync('visionAct', { phase: 'look', source: input.source, purpose: input.purpose }, () => frame,
      value => ({ outcome: input.outcome, audience: input.audience, frame: value ? { ...value, source: value.source.kind } : null }));
    if (input.outcome === 'seen' && input.perceiver) {
      const event = visionPerception({ code: 'look', probability: 0.6, sourceId: frame?.frameId ?? `look-${randomUUID()}`, sourceKind: input.source,
        body: input.deviceId, privacy: input.audience === 'owner_alone' ? 'owner_private' : 'shared_room', ttlMs: LOOK_TTL_MS, frameRef: null, at: input.at });
      input.perceiver.perceive(input.scopeKey, event, { code: 'look', tool: input.source, reason: input.purpose });
    }
    return frame;
  } catch {
    return null;
  }
}
