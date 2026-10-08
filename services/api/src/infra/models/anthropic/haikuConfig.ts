import { anthropicApiKey } from './anthropicConfig.js';

/** Owner-selected small model. This dateless ID is Anthropic's pinned 2026-10-07 release. */
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
type Environment = Readonly<Record<string, string | undefined>>;

export function isHaikuModel(model: string): boolean { return model.startsWith('claude-haiku-'); }

/** Preserve deliberate overrides; only the replaced Luna family and an absent setting select Haiku. */
export function replacementModel(value?: string): string {
  const model = value?.trim();
  return !model || /^gpt-5[.-]6-luna(?:-|$)/iu.test(model) ? DEFAULT_HAIKU_MODEL : model;
}

export function configuredResponseModel(environment: Environment, modelSettingName: string, fallback?: string): { model: string; apiKey: string } | null {
  const model = replacementModel(environment[modelSettingName]?.trim() || fallback);
  const apiKey = isHaikuModel(model) ? environment.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(environment) : environment.OPENAI_API_KEY?.trim();
  return apiKey ? { model, apiKey } : null;
}
