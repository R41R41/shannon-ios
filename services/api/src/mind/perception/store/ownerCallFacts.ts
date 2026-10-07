/**
 * The owner's calls elsewhere, kept (Syzygy ADR-0008 stage 3, S2: the SQLite part of `ownerCallElsewhere.ts`, moved unchanged into
 * the surface's store folder; the rules stay there).
 */
import { DatabaseSync } from 'node:sqlite';
import type { OwnerCallSurface } from '../ownerCallElsewhere.js';

/**
 * What the database says of the owner's devices for a call elsewhere: her calls they answered, and which app a device
 * is: her body's registration (`surface`), else what it reported for private listening (`private_listening.kind`), else
 * a VoIP registration (only the iPhone app has one). Unknown is left out.
 */
export class SQLiteOwnerCallFacts {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 2000;');
  }

  /** Her calls answered since `since`, with the device and the moment of the answer (`ended_at` of an answered call). */
  answered(scopeKey: string, since: string): Array<{ deviceId: string; answeredAt: string }> {
    if (!this.database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'incoming_calls'`).get()) return [];
    return (this.database.prepare(`
      SELECT device_id, ended_at FROM incoming_calls WHERE scope_key = ? AND state = 'answered' AND ended_at >= ? ORDER BY ended_at DESC LIMIT 8
    `).all(scopeKey, since) as unknown as Array<{ device_id: string; ended_at: string }>).map(row => ({ deviceId: row.device_id, answeredAt: row.ended_at }));
  }

  surface(scopeKey: string, deviceId: string): OwnerCallSurface | undefined {
    const tables = new Set((this.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('body_capabilities', 'private_listening', 'voip_push_registrations')`).all() as unknown as Array<{ name: string }>).map(row => row.name));
    const of = (value: unknown): OwnerCallSurface | undefined => value === 'iphone' ? 'ios' : value === 'mac' ? 'mac' : undefined;
    if (tables.has('body_capabilities')) {
      const row = this.database.prepare('SELECT surface FROM body_capabilities WHERE scope_key = ? AND device_id = ?').get(scopeKey, deviceId) as { surface?: unknown } | undefined;
      const surface = of(row?.surface);
      if (surface) return surface;
    }
    if (tables.has('private_listening')) {
      const row = this.database.prepare('SELECT kind FROM private_listening WHERE scope_key = ? AND device_id = ?').get(scopeKey, deviceId) as { kind?: unknown } | undefined;
      const surface = of(row?.kind);
      if (surface) return surface;
    }
    if (tables.has('voip_push_registrations')
      && this.database.prepare('SELECT 1 FROM voip_push_registrations WHERE scope_key = ? AND device_id = ?').get(scopeKey, deviceId)) return 'ios';
    return undefined;
  }

  close(): void { this.database.close(); }
}
