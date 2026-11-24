import { claudeBackground, completeStructured, type ClaudeBackground } from './claude/claudeStructured.js';
import { configuredResponseModel } from './anthropic/haikuConfig.js';
import type { LlmUsageStore } from './llmUsage.js';

/**
 * Her live line's writer (`SHANNON_MINECRAFT_LIVE_SPEECH`): one native Haiku request on the background route `minecraft_line` (lane `chat`), no
 * thinking, a short output ceiling, the fixed part of the prompt (her identity and the rules) cached and the moment's own facts after it. The
 * line used to be asked as a whole conversation turn, which sent the conversation's instructions and a structured reply (about sixteen
 * thousand tokens in, a hundred and sixty out, and the style of a report); a word of her voice needs only its rules and the scene. Never
 * throws: a failure is null (the moment is dropped, as before).
 */
export interface LiveLineWriter {
  complete(request: { scopeKey: string; system: string; message: string; signal?: AbortSignal }): Promise<string | null>;
}

export const LIVE_LINE_REQUEST = Object.freeze({ maximumOutputTokens: 120, timeoutMilliseconds: 8_000 });

export class ClaudeLiveLineWriter implements LiveLineWriter {
  constructor(private readonly claude: ClaudeBackground) {}

  async complete(request: { scopeKey: string; system: string; message: string; signal?: AbortSignal }): Promise<string | null> {
    try {
      const signal = request.signal ?? AbortSignal.timeout(LIVE_LINE_REQUEST.timeoutMilliseconds);
      const answer = await completeStructured<string>('minecraft_line', request.system, request.message, null,
        { claude: this.claude, scopeKey: request.scopeKey, maximumOutputTokens: LIVE_LINE_REQUEST.maximumOutputTokens, effort: 'none', thinking: 'disabled',
          cacheSystem: true, signal });
      return answer.ok && typeof answer.value === 'string' && answer.value.trim() ? answer.value : null;
    } catch { return null; }
  }
}

/** The conversation's small model when it is Haiku with a key; null otherwise (then the line is asked through the conversation turn, as before). */
export function configuredLiveLineWriter(environment: Readonly<Record<string, string | undefined>>,
  parts: { usageStore?: LlmUsageStore; now?: () => string } = {}): LiveLineWriter | null {
  const selected = configuredResponseModel(environment, 'SHANNON_LLM_MODEL');
  if (!selected) return null;
  try {
    const claude = claudeBackground(selected.model, { apiKey: selected.apiKey, ...(parts.usageStore ? { usageStore: parts.usageStore } : {}),
      ...(parts.now ? { now: parts.now } : {}) });
    return claude ? new ClaudeLiveLineWriter(claude) : null;
  } catch { return null; }
}
