import {
  CHARACTER_CORE, INNER_NOTE_REFLECTION_SCHEMA, innerNoteReflectionInput, innerNoteReflectionInstructions, parsedInnerNoteReflection,
  type InnerNoteDraft, type InnerNoteReflectionFacts,
} from '@shannon/cognition';
import { claudeBackground, completeStructured, type ClaudeBackground } from '../../infra/models/claude/claudeStructured.js';
import { configuredResponseModel } from '../../infra/models/anthropic/haikuConfig.js';
import type { LlmUsageEvent } from '../../infra/models/llmUsage.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';
import { INNER_NOTE_SERVICE_LIMITS } from '../../contracts/innerNoteContract.js';
import type { InnerNoteUsage } from './store/innerNoteStore.js';

/**
 * The reflection that writes her inner note (Syzygy ADR-0012 D2, D3). Core: emotion.
 *
 * One native Haiku request through the background route (`claudeStructured.ts`, ADR-0009 stage 1's one entry): its fixed
 * instructions (her character core, the rules, the questions: `innerNoteReflectionInstructions`) carry a one-hour breakpoint of
 * their own, so a reflection reads them from the cache; the facts of the call follow, uncached. Nothing is kept at the provider
 * beyond its prompt cache (the Messages API stores no response; the OpenAI `store: false` of the ADR has no counterpart here).
 * Its tokens are booked in the `memory_background` lane. It runs after a turn, never inside one.
 */
export interface InnerNoteReflectionRequest {
  scopeKey: string;
  facts: InnerNoteReflectionFacts;
  signal?: AbortSignal;
}

export interface InnerNoteReflector {
  readonly model: string;
  /** The draft (null when the answer was not a note) and the usage of the call; throws when the provider refused or failed. */
  reflect(request: InnerNoteReflectionRequest): Promise<{ draft: InnerNoteDraft | null; usage: InnerNoteUsage | null }>;
}

export class ClaudeInnerNoteReflector implements InnerNoteReflector {
  readonly model: string;
  private last: LlmUsageEvent | null = null;
  private readonly claude: ClaudeBackground;

  /** `claude` is built here around the caller's usage store, so the usage of each call is also read back for the note's row. */
  constructor(build: (usageStore: { recordLlmUsage(event: LlmUsageEvent): void }) => ClaudeBackground,
    usageStore?: { recordLlmUsage(event: LlmUsageEvent): void }) {
    this.claude = build({ recordLlmUsage: event => this.noted(event, usageStore) });
    this.model = this.claude.model;
  }

  private noted(event: LlmUsageEvent, usageStore?: { recordLlmUsage(event: LlmUsageEvent): void }): void {
    this.last = event;
    usageStore?.recordLlmUsage(event);
  }

  async reflect(request: InnerNoteReflectionRequest) {
    this.last = null;
    // Syzygy ADR-0013 §6: with her fast layer handed, she reflects as narrator (one more fixed section; without it, the same bytes).
    const instructions = innerNoteReflectionInstructions(CHARACTER_CORE, { narrator: request.facts.fastLayer !== undefined,
      carryOver: request.facts.relationship !== undefined });
    const answer = await completeStructured('inner_note', instructions, innerNoteReflectionInput(request.facts),
      INNER_NOTE_REFLECTION_SCHEMA, { claude: this.claude, scopeKey: request.scopeKey, maximumOutputTokens: INNER_NOTE_SERVICE_LIMITS.maximumOutputTokens,
        effort: 'low', cacheSystem: true, ...(request.signal ? { signal: request.signal } : {}) });
    const usage = this.usage();
    if (!answer.ok) throw new Error(`INNER_NOTE_UPSTREAM_${answer.status}`);
    return { draft: parsedInnerNoteReflection(answer.value), usage };
  }

  private usage(): InnerNoteUsage | null {
    const event = this.last;
    if (!event) return null;
    return { model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens, cacheReadTokens: event.cachedInputTokens,
      cacheWriteTokens: null, costUsd: event.estimatedCostUsd };
  }
}

/** The conversation's small model, when it is Haiku with a key; null otherwise (then no note is written, and nothing else changes). */
export function configuredInnerNoteReflector(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
  usageStore?: { recordLlmUsage(event: LlmUsageEvent): void },
): InnerNoteReflector | null {
  const selected = configuredResponseModel(environment, 'SHANNON_LLM_MODEL');
  if (!selected) return null;
  try {
    const probe = claudeBackground(selected.model, { apiKey: selected.apiKey });
    if (!probe) return null;
  } catch { return null; }
  return new ClaudeInnerNoteReflector(store => claudeBackground(selected.model, { apiKey: selected.apiKey, usageStore: store })!, usageStore);
}
