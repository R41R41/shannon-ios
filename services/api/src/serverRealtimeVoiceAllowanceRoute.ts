import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  realtimeVoiceJapanDayKey,
  SHANNON_REALTIME_ALLOWANCE_EXTENSION_SECONDS,
  SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
  type RealtimeVoiceReservationStore,
} from './realtimeVoice.js';
import { sendJson } from './serverHttp.js';

interface AllowancePrincipal {
  readonly scopeKey: string;
}

interface AllowanceRouteDependencies {
  readonly store: RealtimeVoiceReservationStore;
  readonly baseAllowanceSeconds: number;
  readonly now: () => string;
}

export function handleRealtimeVoiceAllowance(
  request: IncomingMessage,
  response: ServerResponse,
  principal: AllowancePrincipal | null,
  dependencies: AllowanceRouteDependencies,
): void {
  if (!principal) {
    sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    return;
  }
  const now = dependencies.now();
  const dayKey = realtimeVoiceJapanDayKey(new Date(now));
  if (request.method === 'GET') {
    sendJson(response, 200, dependencies.store.realtimeVoiceAllowanceStatus(
      principal.scopeKey,
      dayKey,
      dependencies.baseAllowanceSeconds,
      SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
    ));
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  const extended = dependencies.store.extendRealtimeVoiceAllowance(
    principal.scopeKey,
    dayKey,
    dependencies.baseAllowanceSeconds,
    SHANNON_REALTIME_ALLOWANCE_EXTENSION_SECONDS,
    SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
    now,
  );
  if (!extended) {
    sendJson(response, 409, {
      error: 'VOICE_REALTIME_ALLOWANCE_MAXIMUM_REACHED',
      message: '今日追加できるライブ音声枠は上限に達しています。',
    });
    return;
  }
  sendJson(response, 200, extended);
}
