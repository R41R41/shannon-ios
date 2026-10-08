/** Trusted owner preference, pinned once when the original Minecraft request is accepted. */
export const MINECRAFT_PRIMARY_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' } as const;
export interface MinecraftPrimaryModel { mode: keyof typeof MINECRAFT_PRIMARY_MODELS; model: string; revision: number }
export type MinecraftPrimaryModelReader = (scopeKey: string) => MinecraftPrimaryModel | null;
export function minecraftPrimaryModel(value: unknown): MinecraftPrimaryModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const pin = value as MinecraftPrimaryModel;
  return typeof pin.mode === 'string' && Object.hasOwn(MINECRAFT_PRIMARY_MODELS, pin.mode) && MINECRAFT_PRIMARY_MODELS[pin.mode] === pin.model
    && Number.isSafeInteger(pin.revision) && pin.revision >= 0 ? { mode: pin.mode, model: pin.model, revision: pin.revision } : null;
}
export function validMinecraftPrimaryModels(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 2 && value.every(model => Object.values(MINECRAFT_PRIMARY_MODELS).includes(model))
    && new Set(value).size === value.length;
}
