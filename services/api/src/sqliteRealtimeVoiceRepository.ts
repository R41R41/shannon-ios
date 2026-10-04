import { randomUUID } from 'node:crypto';
import {
  SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
  type RealtimeVoiceAllowanceStatus,
  type RealtimeVoiceReservationStore,
  type RealtimeVoiceSessionReservation,
  type RealtimeVoiceSessionReservationRequest,
} from './realtimeVoice.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';

/** The retired realtime voice allowance ledger (migration compatibility only), kept apart from the companion state. */
export class SQLiteRealtimeVoiceRepository implements RealtimeVoiceReservationStore {
  constructor(private readonly context: SQLiteStoreContext) {}

  reserveRealtimeVoiceSession(
    request: RealtimeVoiceSessionReservationRequest,
  ): RealtimeVoiceSessionReservation | null {
    const scopeKey = request.scopeKey.trim();
    if (!scopeKey) throw new Error('REALTIME_VOICE_SCOPE_REQUIRED');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(request.dayKey)) throw new Error('REALTIME_VOICE_DAY_INVALID');
    if (!Number.isInteger(request.reservedSeconds) || request.reservedSeconds <= 0) {
      throw new Error('REALTIME_VOICE_RESERVATION_INVALID');
    }
    if (!Number.isInteger(request.dailyLimitSeconds) || request.dailyLimitSeconds < request.reservedSeconds) {
      throw new Error('REALTIME_VOICE_DAILY_LIMIT_INVALID');
    }
    if (!Number.isFinite(Date.parse(request.createdAt))) throw new Error('REALTIME_VOICE_CREATED_AT_INVALID');

    return this.context.transaction(() => {
      const row = this.context.database.prepare(`
        SELECT COALESCE(SUM(reserved_seconds), 0) AS reserved_seconds
        FROM realtime_voice_session_reservations
        WHERE scope_key = ? AND day_key = ?
      `).get(scopeKey, request.dayKey) as unknown as { reserved_seconds: number };
      const alreadyReserved = Number(row.reserved_seconds);
      if (alreadyReserved + request.reservedSeconds > request.dailyLimitSeconds) return null;

      const reservationId = randomUUID();
      this.context.database.prepare(`
        INSERT INTO realtime_voice_session_reservations
          (reservation_id, scope_key, day_key, reserved_seconds, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        reservationId,
        scopeKey,
        request.dayKey,
        request.reservedSeconds,
        request.createdAt,
      );
      return Object.freeze({
        reservationId,
        remainingSeconds: request.dailyLimitSeconds - alreadyReserved - request.reservedSeconds,
      });
    });
  }

  releaseRealtimeVoiceSessionReservation(reservationId: string): void {
    this.context.database.prepare(`
      DELETE FROM realtime_voice_session_reservations WHERE reservation_id = ?
    `).run(reservationId);
  }

  realtimeVoiceReservedSecondsForDay(scopeKey: string, dayKey: string): number {
    const row = this.context.database.prepare(`
      SELECT COALESCE(SUM(reserved_seconds), 0) AS reserved_seconds
      FROM realtime_voice_session_reservations
      WHERE scope_key = ? AND day_key = ?
    `).get(scopeKey, dayKey) as unknown as { reserved_seconds: number };
    return Number(row.reserved_seconds);
  }

  realtimeVoiceAllowanceStatus(
    scopeKey: string,
    dayKey: string,
    baseAllowanceSeconds: number,
    maximumAllowanceSeconds = SHANNON_REALTIME_MAXIMUM_DAILY_ALLOWANCE_SECONDS,
  ): RealtimeVoiceAllowanceStatus {
    const normalizedScopeKey = validatedRealtimeVoiceScope(scopeKey);
    validatedRealtimeVoiceDay(dayKey);
    validatedRealtimeVoiceAllowance(baseAllowanceSeconds, maximumAllowanceSeconds);
    const extension = this.context.database.prepare(`
      SELECT additional_seconds
      FROM realtime_voice_allowance_extensions
      WHERE scope_key = ? AND day_key = ?
    `).get(normalizedScopeKey, dayKey) as unknown as { additional_seconds: number } | undefined;
    const additionalAllowanceSeconds = Number(extension?.additional_seconds ?? 0);
    const totalAllowanceSeconds = Math.min(
      maximumAllowanceSeconds,
      baseAllowanceSeconds + additionalAllowanceSeconds,
    );
    const reservedSeconds = this.realtimeVoiceReservedSecondsForDay(normalizedScopeKey, dayKey);
    return Object.freeze({
      dayKey,
      baseAllowanceSeconds,
      additionalAllowanceSeconds,
      totalAllowanceSeconds,
      reservedSeconds,
      remainingSeconds: Math.max(0, totalAllowanceSeconds - reservedSeconds),
      maximumAllowanceSeconds,
    });
  }

  extendRealtimeVoiceAllowance(
    scopeKey: string,
    dayKey: string,
    baseAllowanceSeconds: number,
    additionalSeconds: number,
    maximumAllowanceSeconds: number,
    updatedAt: string,
  ): RealtimeVoiceAllowanceStatus | null {
    const normalizedScopeKey = validatedRealtimeVoiceScope(scopeKey);
    validatedRealtimeVoiceDay(dayKey);
    validatedRealtimeVoiceAllowance(baseAllowanceSeconds, maximumAllowanceSeconds);
    if (!Number.isInteger(additionalSeconds) || additionalSeconds <= 0) {
      throw new Error('REALTIME_VOICE_EXTENSION_INVALID');
    }
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('REALTIME_VOICE_UPDATED_AT_INVALID');

    return this.context.transaction(() => {
      const current = this.realtimeVoiceAllowanceStatus(
        normalizedScopeKey,
        dayKey,
        baseAllowanceSeconds,
        maximumAllowanceSeconds,
      );
      if (current.totalAllowanceSeconds + additionalSeconds > maximumAllowanceSeconds) return null;
      this.context.database.prepare(`
        INSERT INTO realtime_voice_allowance_extensions
          (scope_key, day_key, additional_seconds, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope_key, day_key) DO UPDATE SET
          additional_seconds = additional_seconds + excluded.additional_seconds,
          updated_at = excluded.updated_at
      `).run(normalizedScopeKey, dayKey, additionalSeconds, updatedAt);
      return this.realtimeVoiceAllowanceStatus(
        normalizedScopeKey,
        dayKey,
        baseAllowanceSeconds,
        maximumAllowanceSeconds,
      );
    });
  }
}

function validatedRealtimeVoiceScope(scopeKey: string): string {
  const normalized = scopeKey.trim();
  if (!normalized) throw new Error('REALTIME_VOICE_SCOPE_REQUIRED');
  return normalized;
}

function validatedRealtimeVoiceDay(dayKey: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) throw new Error('REALTIME_VOICE_DAY_INVALID');
}

function validatedRealtimeVoiceAllowance(baseSeconds: number, maximumSeconds: number): void {
  if (!Number.isInteger(baseSeconds) || baseSeconds <= 0
    || !Number.isInteger(maximumSeconds) || maximumSeconds < baseSeconds) {
    throw new Error('REALTIME_VOICE_DAILY_LIMIT_INVALID');
  }
}
