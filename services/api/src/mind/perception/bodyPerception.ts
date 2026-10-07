import type { MemoryAudience } from '@shannon/cognition';
import type { MindEvent } from '@shannon/mind';
import { closedId, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of a touch of her body (`bodyReaction.ts`). The body decided who can see it (`audience`: `owner` or `others`,
 * as the request said), and the reaction holds the matching `MemoryAudience` in one place (`BODY_PRESENT`), the value its replay
 * of the Talk receives; both are copied here. A touch carries no text: only its kind, how it was given and the body.
 */
export interface BodyPerceptionInput {
  /** The touch's id (the body's idempotency key). */
  touchId: string;
  deviceId: string;
  /** The body's decision, as the request carried it. */
  audience: 'owner' | 'others';
  /** The `MemoryAudience` the reaction holds for that decision (`BODY_PRESENT`), copied as it is. */
  present: MemoryAudience;
  /** Pressed (dragged) or only passed over. */
  input: 'press' | 'hover';
  at: string;
}

export function bodyPerception(input: BodyPerceptionInput): MindEvent | null {
  const alone = input.audience === 'owner';
  return perceived({
    id: perceivedId('body'), kind: 'touch', surface: 'body', time: input.at, body: closedId(input.deviceId, 80),
    audience: input.present, presence: { ownerOnlyHears: alone, othersMayHear: !alone },
    // Whose hand it was is not proven: the body sees a pointer, not a person.
    speaker: { kind: 'unknown' },
    salienceInputs: { touch: input.input },
    provenance: { source: 'body', sourceId: closedId(input.touchId), trust: 'system' },
    content: null,
  });
}
