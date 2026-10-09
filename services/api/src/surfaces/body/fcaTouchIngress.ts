import type { FcaTouchInput, FcaTouchPort } from '../../mind/action/reflex/fcaTouchPorts.js';
import type { FeltTouch } from '../../mind/emotion/bodyTouch.js';

/** No extra reaction, feeling or memory: these are the identities just accepted by BodyTouches. */
export function observeFcaTouch(port: FcaTouchPort | null | undefined, input: {
  scopeKey: string; deviceId: string; touchId: string; observedAt: string; audience: 'owner' | 'others';
  touch: FcaTouchInput['touch']; felt: FeltTouch; gestures: readonly string[]; stances: readonly string[]; stanceSourceIds: readonly string[];
}): void {
  try { port?.observe({ scopeKey: input.scopeKey, deviceId: input.deviceId, touchId: input.touchId,
    observedAt: input.observedAt, audience: input.audience, touch: input.touch,
    experienceId: input.felt.burst.id, emotion: input.felt.snapshot.emotion, stateVersion: input.felt.snapshot.version,
    gestures: input.gestures, stances: input.stances, stanceSourceIds: input.stanceSourceIds }); } catch { /* Existing local reaction and durable touch remain authoritative. */ }
}
