import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  deriveShannonFace, livingLingering, presentShannonFeeling,
  type CompanionStateSnapshot, type ShannonEmotionKind, type ShannonEmotionTiming, type ShannonExpressiveEmotion,
} from '@shannon/cognition';
import { emotionTiming } from './emotionTiming.js';
import { consumeDeviceAllowance, sendJson } from './serverHttp.js';
import {
  SHANNON_NOW_LIMITS, SHANNON_NOW_SCHEMA_VERSION,
  type ShannonNowFace, type ShannonNowFeeling, type ShannonNowResponse,
} from './contracts/shannonNowContract.js';
import type { SQLiteShannonNowReader } from './shannonNowReader.js';

export interface ShannonNowRouteDependencies {
  reader: Pick<SQLiteShannonNowReader, 'body' | 'looks' | 'touches' | 'reachOuts'>;
  /** Her stored state, or null when none was ever stored. Reading must not create one: this route writes nothing. */
  snapshot: (scopeKey: string) => CompanionStateSnapshot | null;
  /** `SHANNON_NOW_READ`. */
  enabled: () => boolean;
  /** The owner's scope; a device paired into another scope is a guest here. */
  ownerScopeKey: string;
  now: () => string;
  timing?: () => ShannonEmotionTiming;
}

/**
 * `GET /v1/shannon/now` (`docs/shannon-now-contract.md`): the owner's own app reads how she is.
 *
 * Refused for anyone but a paired device of the owner's scope: a caller with the fixed local
 * token has no device (`403 PAIRED_DEVICE_REQUIRED`), and a device paired into another scope is a
 * guest (`403 SHANNON_NOW_OWNER_ONLY`). The scope is the device's own and is never taken from the
 * request. Nothing is stored, no model is called, and the answer is not given to any other module.
 */
export function createShannonNowRoute(dependencies: ShannonNowRouteDependencies) {
  const usage = new Map<string, { startedAt: number; count: number }>();

  return (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string; deviceId: string } | null): void => {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!principal) {
      return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED', message: 'Only a paired device of the owner may read this.' });
    }
    if (principal.scopeKey !== dependencies.ownerScopeKey) {
      return sendJson(response, 403, { error: 'SHANNON_NOW_OWNER_ONLY', message: 'Only the owner may read this.' });
    }
    if (!dependencies.enabled()) {
      return sendJson(response, 403, { error: 'SHANNON_NOW_DISABLED', message: 'This read is switched off on the server.' });
    }
    if (!consumeDeviceAllowance(usage, principal.deviceId, SHANNON_NOW_LIMITS.readsPerMinute)) {
      return sendJson(response, 429, { error: 'RATE_LIMITED', message: 'Too many requests; retry after a minute.' });
    }
    sendJson(response, 200, shannonNowResponse(dependencies, principal.scopeKey));
  };
}

export function shannonNowResponse(dependencies: Omit<ShannonNowRouteDependencies, 'enabled' | 'ownerScopeKey'>, scopeKey: string): ShannonNowResponse {
  const at = dependencies.now();
  const since = new Date(Date.parse(at) - SHANNON_NOW_LIMITS.days * 24 * 60 * 60_000).toISOString();
  const { reader } = dependencies;
  return {
    schemaVersion: SHANNON_NOW_SCHEMA_VERSION,
    generatedAt: at,
    feeling: shannonNowFeeling(dependencies.snapshot(scopeKey), at, (dependencies.timing ?? emotionTiming)()),
    body: reader.body(scopeKey, at),
    looks: reader.looks(scopeKey, since),
    touches: reader.touches(scopeKey, since),
    reachOuts: reader.reachOuts(scopeKey, since),
    limits: { items: SHANNON_NOW_LIMITS.items, days: SHANNON_NOW_LIMITS.days },
  };
}

/**
 * Her feeling as faces and strengths. The cause of a feeling is between her and the owner in
 * the Talk where it arose; it is not copied here, so this answer holds no conversation text.
 */
export function shannonNowFeeling(snapshot: CompanionStateSnapshot | null, at: string, timing: ShannonEmotionTiming): ShannonNowFeeling {
  if (!snapshot) return { mood: { expression: 'neutral' }, present: null, lingering: [] };
  const current = presentShannonFeeling(snapshot, at, timing);
  const showing = current.primary !== 'neutral' && current.visibility !== 'hidden';
  const lingering = livingLingering(snapshot, at, timing)
    // What she feels now is already `present`; underneath is what else is still there.
    .filter(item => !(showing && item.feeling.kind === current.primary))
    .slice(0, SHANNON_NOW_LIMITS.lingering)
    .map(item => ({ ...faceOf(snapshot, item.feeling.kind), strength: round(item.strength), startedAt: item.feeling.startedAt }));
  return {
    mood: face(deriveShannonFace(snapshot.emotion)),
    present: showing ? { ...face(deriveShannonFace(snapshot.emotion, current)), intensity: round(current.intensity) } : null,
    lingering,
  };
}

function faceOf(snapshot: CompanionStateSnapshot, kind: ShannonEmotionKind): ShannonNowFace {
  // Only the kind and its visibility decide a face.
  return face(deriveShannonFace(snapshot.emotion, { primary: kind, visibility: 'expressed' } as ShannonExpressiveEmotion));
}

function face(value: { expression: string; feeling?: string }): ShannonNowFace {
  return { expression: value.expression, ...(value.feeling ? { feeling: value.feeling } : {}) };
}

function round(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}
