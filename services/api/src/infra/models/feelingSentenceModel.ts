import {
  CHARACTER_CORE, FEELING_SENTENCE_LIMITS, FEELING_SENTENCE_SCHEMA, feelingSentenceInput, feelingSentenceInstructions, parsedFeelingSentence,
  type FeelingSentenceFacts,
} from '@shannon/cognition';
import { claudeBackground, completeStructured, type ClaudeBackground } from './claude/claudeStructured.js';
import { configuredResponseModel } from './anthropic/haikuConfig.js';
import type { LlmUsageStore } from './llmUsage.js';

/**
 * Her feeling sentence's writer (Syzygy ADR-0013 D7, stage 2 item 3): one native Haiku request on the background route
 * `feeling_sentence` (lane `chat`), no thinking, its fixed instructions (the rules and her character core) cached, the closed facts of
 * the turn after them. Nothing is kept: the lines go into this one reply's prompt and are dropped. Never throws: a failure is null.
 */
export interface FeelingSentenceWriter {
  write(request: { scopeKey: string; facts: FeelingSentenceFacts; signal?: AbortSignal }): Promise<readonly string[] | null>;
}

export class ClaudeFeelingSentenceWriter implements FeelingSentenceWriter {
  constructor(private readonly claude: ClaudeBackground) {}

  async write(request: { scopeKey: string; facts: FeelingSentenceFacts; signal?: AbortSignal }): Promise<readonly string[] | null> {
    try {
      const signal = request.signal ?? AbortSignal.timeout(FEELING_SENTENCE_LIMITS.requestMilliseconds);
      const answer = await completeStructured('feeling_sentence', feelingSentenceInstructions(CHARACTER_CORE), feelingSentenceInput(request.facts),
        FEELING_SENTENCE_SCHEMA, { claude: this.claude, scopeKey: request.scopeKey, maximumOutputTokens: FEELING_SENTENCE_LIMITS.maximumOutputTokens,
          effort: 'none', thinking: 'disabled', cacheSystem: true, signal });
      return answer.ok ? parsedFeelingSentence(answer.value) : null;
    } catch { return null; }
  }
}

/** The conversation's small model when it is Haiku with a key; null otherwise (then no sentence is written, and nothing else changes). */
export function configuredFeelingSentenceWriter(environment: Readonly<Record<string, string | undefined>>,
  parts: { usageStore?: LlmUsageStore; now?: () => string } = {}): FeelingSentenceWriter | null {
  const selected = configuredResponseModel(environment, 'SHANNON_LLM_MODEL');
  if (!selected) return null;
  try {
    const claude = claudeBackground(selected.model, { apiKey: selected.apiKey, ...(parts.usageStore ? { usageStore: parts.usageStore } : {}),
      ...(parts.now ? { now: parts.now } : {}) });
    return claude ? new ClaudeFeelingSentenceWriter(claude) : null;
  } catch { return null; }
}
