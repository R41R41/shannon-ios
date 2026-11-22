/**
 * The OpenAI side of the Minecraft head's models (owner 2026-11-18: run Shannon and Minebot on the monthly OpenAI credit, gpt-6.2-sol first,
 * and compare the models with Sonnet). The name's prefix chooses the maker: `claude-` is Anthropic as it always was, `gpt-` is OpenAI's
 * Responses API (`openAiFcaModel.ts`, `openAiStructured.ts`). One setting per role, so a role can use another model.
 */
export const OPENAI_LLMC_MODELS: readonly string[] = ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna'];

/** Whether a model name is OpenAI's (a task's history never crosses the maker: a new model starts a new epoch). */
export function isOpenAiModel(model: string): boolean { return model.startsWith('gpt-'); }

/**
 * OpenAI counts a request's tokens about this much above `estimatedAnthropicTokens` / `llmcTokens` (fitted to Claude's count). Until it is
 * measured on a run, every bound of the head that is a count of tokens is seen through it for an OpenAI model.
 */
export const OPENAI_TOKEN_SCALE = 1.2;

/**
 * Where the decision message is shortened for a GPT-6 model (in the unit of the head's own estimate, the journal's `estimatedInputTokens`).
 * The family's context is 1,050,000 tokens and its dearer price starts at 272,000 input tokens; the head's estimate is about 1.8 times
 * the real count, so 160,000 here is about 89,000 real tokens. The Claude default (95,000) cut the map and the observation to a few hundred
 * characters in a fifth of the decisions for no gain in price.
 */
export const OPENAI_COMPACT_ABOVE_TOKENS = 160_000;

export type OpenAiEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export const DEFAULT_OPENAI_EFFORT: OpenAiEffort = 'medium';
const EFFORTS: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** The reasoning effort a role asks for: the setting when it is one of the model's, else `medium` (sol and astra take no `none`). */
export function openAiEffort(value: string | undefined, model: string): OpenAiEffort {
  const effort = value?.trim().toLowerCase();
  if (!effort || !EFFORTS.has(effort)) return DEFAULT_OPENAI_EFFORT;
  if (effort === 'none' && /-(?:sol|astra)(?:-|$)/u.test(model)) return DEFAULT_OPENAI_EFFORT;
  return effort as OpenAiEffort;
}

/** The OpenAI key of the environment it is handed (never read from anywhere else, never printed). */
export function openAiApiKey(values: Readonly<Record<string, string | undefined>>): string | null {
  return values.OPENAI_API_KEY?.trim() || null;
}
