import type Anthropic from '@anthropic-ai/sdk';
import { claudeClient } from '../../src/infra/models/claude/claudeClient.js';
import { estimatedAnthropicCostUsd } from '../../src/infra/models/claude/claudeUsage.js';

/**
 * The eval's own Claude calls (the rubric judge and the user simulator), through the existing SDK client. Live only; the key is
 * read from the environment it is handed and never printed. Their spend is counted apart from Shannon's.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5-5';

export interface EvalClaude {
  model: string;
  /** USD spent by this client so far. */
  spentUsd(): number;
  text(system: string, user: string, maxTokens: number): Promise<string>;
}

export function evalClaudeKey(environment: Readonly<Record<string, string | undefined>>): string | null {
  return environment.SHANNON_ANTHROPIC_API_KEY?.trim() || environment.ANTHROPIC_API_KEY?.trim() || environment.SHANNON_HAIKU_API_KEY?.trim() || null;
}

export function createEvalClaude(environment: Readonly<Record<string, string | undefined>>, model = environment.SHANNON_EVALS_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL): EvalClaude | null {
  const apiKey = evalClaudeKey(environment);
  if (!apiKey) return null;
  const client = claudeClient({ apiKey, timeoutMilliseconds: 90_000 });
  let spent = 0;
  return {
    model,
    spentUsd: () => spent,
    async text(system, user, maxTokens) {
      const message: Anthropic.Message = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
      const usage = message.usage;
      spent += estimatedAnthropicCostUsd(model, { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, searches: 0 });
      return message.content.filter((block): block is Anthropic.TextBlock => block.type === 'text').map(block => block.text).join('').trim();
    },
  };
}

/** The first JSON object in a model's text, or null. */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
