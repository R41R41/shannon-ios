/**
 * The owner's switches on the 運用 page that are not commands (`docs/ops-contract.md`, 「新しいワールドで始める」).
 * A setting is a closed boolean with a stored default; nothing here carries text and no model reads or writes one.
 */
export const OPS_SETTINGS_PATH = '/v1/ops/settings';

export interface OpsSettings {
  /**
   * 「新しいワールドで始める」. On: a Minecraft server start the owner newly asks for, while the server is stopped and no
   * Minecraft work is open, asks the body to delete the current world and start a new one. Off by default; unreadable is off.
   */
  freshWorld: boolean;
}

export const OPS_SETTINGS_LIMITS = {
  bodyBytes: 1024,
  writesPerMinute: 30,
} as const;

export interface OpsSettingsRefusal { status: 400; error: 'INVALID_REQUEST'; message: string }

const refusal = (message: string): OpsSettingsRefusal => ({ status: 400, error: 'INVALID_REQUEST', message });

/** The settings as they will be stored, or why the body is refused: `{ "freshWorld": boolean }` (and `scopeKey` for a fixed local token). */
export function validatedOpsSettingsRequest(value: unknown): OpsSettings | OpsSettingsRefusal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refusal('JSON object body is required');
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => key !== 'scopeKey' && key !== 'freshWorld');
  if (unknown !== undefined) return refusal(`${unknown.slice(0, 40).replace(/[^\x20-\x7e]/gu, '?')} is not allowed`);
  if (typeof body.freshWorld !== 'boolean') return refusal('freshWorld must be a boolean');
  return { freshWorld: body.freshWorld };
}
