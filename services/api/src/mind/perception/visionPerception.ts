import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import type { MindEvent, MindPerceptPrivacy } from '@shannon/mind';
import { closedId, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of what she saw (Syzygy ADR-0011 §5): one `percept` with a closed code, the probability its decision gave, a
 * TTL, the privacy of the source and a frame reference that only names a frame in a process's memory. It carries no words and no
 * picture: the workspace renders the code through its own closed words (`promptLayout.ts`).
 *
 * A source that showed only the owner (`owner_private`) is the owner's audience: with anyone else present it is never rendered
 * (`audienceCovers`). Anything else (a shared room, a shared world, a stream) is perceived as an unknown guest's presence.
 */
export interface VisionPerceptionInput {
  /** A candidate id (`react:<id>`, `notice:<category>`, `escalate`), `presence:others`, `degrade:<0-3>` or `look`. */
  code: string;
  /** The decision's probability that it calls for a response, in [0, 1]; 1 for a state change of her own. */
  probability: number;
  /** The decision or event this percept came from (an idempotency key of the worker). */
  sourceId: string;
  /** The source kind (`app_camera`, `app_look`, ...) and the device or body, when one saw it. */
  sourceKind: string;
  body: string | null;
  privacy: MindPerceptPrivacy;
  ttlMs: number;
  frameRef: string | null;
  at: string;
}

const CODE = /^(?:react:[a-z_]{1,40}|notice:[a-z_]{1,40}|escalate|look|presence:others|degrade:[0-3])$/u;

export function visionPerception(input: VisionPerceptionInput): MindEvent | null {
  if (!CODE.test(input.code)) return null;
  const ownerOnly = input.privacy === 'owner_private';
  return perceived({
    id: perceivedId('vision'), kind: 'percept', surface: 'vision', time: input.at, body: input.body ? closedId(input.body, 80) : null,
    audience: ownerOnly ? OWNER_AUDIENCE : UNKNOWN_GUEST_PRESENCE, presence: { ownerOnlyHears: ownerOnly, othersMayHear: !ownerOnly },
    speaker: { kind: 'system' },
    salienceInputs: { percept: Math.min(1, Math.max(0, Number.isFinite(input.probability) ? input.probability : 0)) },
    provenance: { source: closedId(`vision.${input.sourceKind}`, 60), sourceId: closedId(input.sourceId), trust: 'system' },
    content: null,
    percept: { ttlMs: input.ttlMs, privacy: input.privacy, frameRef: input.frameRef },
  });
}
