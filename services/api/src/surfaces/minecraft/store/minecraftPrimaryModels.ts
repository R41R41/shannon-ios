import type { DatabaseSync } from 'node:sqlite';
import { minecraftPrimaryModel, validMinecraftPrimaryModels, type MinecraftPrimaryModel } from '../../../contracts/minecraftPrimaryModelContract.js';

/** Additive migration leaves every existing request/result/acknowledgement untouched. */
export function migrateMinecraftPrimaryModels(database: DatabaseSync): void {
  for (const [table, column] of [['minecraft_body_requests', 'primary_model_json'], ['minecraft_body_presence', 'primary_models_json']]) {
    if (!(database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(row => row.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }
}
export function readMinecraftPrimaryModel(json: string | null): MinecraftPrimaryModel | null {
  try { return minecraftPrimaryModel(JSON.parse(json ?? 'null')); } catch { return null; }
}
export function supportsMinecraftPrimaryModel(database: DatabaseSync, scope: string, model: string): boolean {
  const row = database.prepare('SELECT primary_models_json FROM minecraft_body_presence WHERE scope_key=?').get(scope) as { primary_models_json: string | null } | undefined;
  // A pre-mode body has no negotiated model control. It may only take legacy unpinned requests.
  try { const models: unknown = JSON.parse(row?.primary_models_json ?? '[]'); return validMinecraftPrimaryModels(models) && models.includes(model); }
  catch { return false; }
}
export function recordMinecraftPrimaryModels(database: DatabaseSync, scope: string, models: readonly string[] | undefined): void {
  database.prepare('UPDATE minecraft_body_presence SET primary_models_json=? WHERE scope_key=?').run(JSON.stringify(models ?? []), scope);
}
export function pinnedMinecraftRequestSupported(models: readonly string[] | undefined, json: string | null): boolean {
  if (json === null) return true; // Requests accepted before rollout keep their original legacy planner.
  const pin = readMinecraftPrimaryModel(json);
  return !!pin && validMinecraftPrimaryModels(models) && models.includes(pin.model);
}
