/**
 * `reasoning.effort` for the GPT-6 models that cannot answer without thinking (Sol and Astra: `none` is refused), and the
 * owner's choice of it per layer. A layer named `SHANNON_LLM_MODEL` reads `SHANNON_LLM_REASONING_EFFORT`; one named
 * `SHANNON_X_MODEL` reads `SHANNON_X_REASONING_EFFORT`. Unset: Sol and Astra think at `medium`, every other model keeps the
 * effort the request itself carries (so Luna and the legacy models are byte-for-byte what they were).
 */
export type OpenAIReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

const EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high'];

export function requiresOpenAIReasoning(model: string): boolean {
  return /^gpt-6(?:\.\d+)?-(?:sol|astra)(?:-|$)/u.test(model);
}

export function openAIReasoningEffortSetting(modelSettingName: string): string {
  return `${modelSettingName.replace(/_MODEL$/u, '')}_REASONING_EFFORT`;
}

/** The configured effort of a layer; `none` is read as `low` for a model that must think. A word that is no effort throws. */
export function configuredOpenAIReasoningEffort(
  environment: Readonly<Record<string, string | undefined>>, modelSettingName: string, model: string,
): OpenAIReasoningEffort | undefined {
  const name = openAIReasoningEffortSetting(modelSettingName);
  const value = environment[name]?.trim().toLowerCase();
  if (!value) return requiresOpenAIReasoning(model) ? 'medium' : undefined;
  if (value === 'none') return requiresOpenAIReasoning(model) ? 'low' : undefined;
  if (!EFFORTS.includes(value)) throw new Error(`${name} must be low, medium or high`);
  return value as OpenAIReasoningEffort;
}

/**
 * Reasoning tokens are counted in `max_output_tokens`: a ceiling sized for a reply with no thinking (180 tokens for a greeting)
 * would be spent before the first word. A model that must think gets this much more room, by effort; it is only a ceiling, so
 * what is not thought is not paid.
 */
export const REASONING_HEADROOM_TOKENS: Readonly<Record<OpenAIReasoningEffort, number>> = Object.freeze({
  minimal: 500, low: 1_500, medium: 4_000, high: 8_000,
});

/** The request body with its `reasoning.effort` set (and, for a model that must think, room for it); anything else comes back as it came. */
export function withReasoningEffort(body: unknown, effort: OpenAIReasoningEffort | undefined, model: string): unknown {
  if (!effort || typeof body !== 'string') return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.reasoning) return body;
    const ceiling = parsed.max_output_tokens;
    return JSON.stringify({
      ...parsed, reasoning: { ...(parsed.reasoning as object), effort },
      ...(requiresOpenAIReasoning(model) && typeof ceiling === 'number' ? { max_output_tokens: ceiling + REASONING_HEADROOM_TOKENS[effort] } : {}),
    });
  } catch { return body; }
}
