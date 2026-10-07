/** Her voice identity, kept (Syzygy ADR-0008 stage 3, S2: the SQLite part of `voiceIdentity.ts` and the rules it reads rows with, moved unchanged into the surface's store folder). */
import type { ShannonRealtimeVoiceId, ShannonVoiceIdentityMode, ShannonVoiceIdentityPreference, ShannonVoiceIdentityStore } from '../voiceIdentity.js';
import { DatabaseSync } from 'node:sqlite';

export class SQLiteVoiceIdentityStore implements ShannonVoiceIdentityStore {
  private readonly database: DatabaseSync;

  constructor(
    path: string,
    private readonly automaticVoice: ShannonRealtimeVoiceId = 'marin',
  ) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS voice_identity_preferences (
        scope_key TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('automatic','manual')),
        selected_voice TEXT CHECK (selected_voice IN ('marin','cedar','coral')),
        updated_at TEXT NOT NULL,
        CHECK (
          (mode = 'automatic' AND selected_voice IS NULL)
          OR (mode = 'manual' AND selected_voice IS NOT NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS voice_identity_preview_usage (
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        request_count INTEGER NOT NULL CHECK (request_count > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, day_key)
      );
    `);
  }

  read(scopeKey: string): ShannonVoiceIdentityPreference {
    const row = this.database.prepare(`
      SELECT mode, selected_voice, updated_at
      FROM voice_identity_preferences
      WHERE scope_key = ?
    `).get(scopeKey) as unknown as {
      mode: ShannonVoiceIdentityMode;
      selected_voice: ShannonRealtimeVoiceId | null;
      updated_at: string;
    } | undefined;
    return row
      ? normalizedPreference(row.mode, row.selected_voice, this.automaticVoice, row.updated_at)
      : automaticPreference(this.automaticVoice);
  }

  save(
    scopeKey: string,
    mode: ShannonVoiceIdentityMode,
    selectedVoice: ShannonRealtimeVoiceId | null,
    updatedAt: string,
  ): ShannonVoiceIdentityPreference {
    const preference = normalizedPreference(mode, selectedVoice, this.automaticVoice, updatedAt);
    this.database.prepare(`
      INSERT INTO voice_identity_preferences (scope_key, mode, selected_voice, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        mode = excluded.mode,
        selected_voice = excluded.selected_voice,
        updated_at = excluded.updated_at
    `).run(scopeKey, preference.mode, preference.selectedVoice, preference.updatedAt);
    return preference;
  }

  close(): void {
    this.database.close();
  }

  consumePreviewAllowance(scopeKey: string, at = new Date(), maximumPerDay = 12): boolean {
    const dayKey = japanDayKey(at);
    const changed = this.database.prepare(`
      INSERT INTO voice_identity_preview_usage (scope_key, day_key, request_count, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(scope_key, day_key) DO UPDATE SET
        request_count = request_count + 1,
        updated_at = excluded.updated_at
      WHERE request_count < ?
    `).run(scopeKey, dayKey, at.toISOString(), maximumPerDay).changes;
    this.database.prepare(`
      DELETE FROM voice_identity_preview_usage WHERE day_key < ?
    `).run(japanDayKey(new Date(at.getTime() - 14 * 86_400_000)));
    return changed === 1;
  }
}

export function automaticPreference(automaticVoice: ShannonRealtimeVoiceId): ShannonVoiceIdentityPreference {
  return {
    mode: 'automatic',
    selectedVoice: null,
    effectiveVoice: automaticVoice,
    updatedAt: null,
  };
}

export function normalizedPreference(
  mode: ShannonVoiceIdentityMode,
  selectedVoice: ShannonRealtimeVoiceId | null,
  automaticVoice: ShannonRealtimeVoiceId,
  updatedAt: string,
): ShannonVoiceIdentityPreference {
  if (mode === 'manual' && !selectedVoice) throw new Error('VOICE_IDENTITY_SELECTION_REQUIRED');
  return {
    mode,
    selectedVoice: mode === 'manual' ? selectedVoice : null,
    effectiveVoice: mode === 'manual' ? selectedVoice as ShannonRealtimeVoiceId : automaticVoice,
    updatedAt,
  };
}

export function validIdentifier(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,100}$/u.test(normalized)) throw new Error('voice preview identifier is invalid');
  return normalized;
}

export function boundedInteger(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum ? Number(value) : fallback;
}

export function optionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function japanDayKey(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
