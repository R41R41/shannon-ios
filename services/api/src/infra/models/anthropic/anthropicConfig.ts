import { skillRoutingSwitches } from '@shannon/learning';
import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../config/serverEnvironment.js';

/**
 * The Sonnet tier's settings (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * Read from the environment it is handed, never printed:
 * - the key: `SHANNON_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`;
 * - the model: `SHANNON_SONNET_MODEL` (default `claude-sonnet-5-5`);
 * - effort: `SHANNON_SONNET_EFFORT` (`low` default; `low` | `medium` | `high`);
 * - thinking on text: `SHANNON_SONNET_TEXT_THINKING` (`adaptive` default, or `between_tools`); on voice:
 *   `SHANNON_SONNET_VOICE_THINKING` (`between_tools` default, or `adaptive`). `between_tools` is accepted at effort `high`
 *   or below only, which is all this setting allows.
 *
 * Routing (owner answers I-1 and I-2): the `sonnet` tier is served only while the key is present **and**
 * `SHANNON_SONNET_ROUTING=on` (default off) and the difficulty policy is on (`skillRoutingSwitches`).
 */
export type SonnetEffort = 'low' | 'medium' | 'high';
export type SonnetThinking = 'adaptive' | 'between_tools';
/** Haiku rejects `between_tools`; its voice turn either thinks adaptively or not at all (`haikuVoiceThinking`). */
export type ClaudeVoiceThinking = SonnetThinking | 'disabled';

export interface ClaudeChatSettings {
  model: string;
  effort: SonnetEffort;
  textThinking: SonnetThinking;
  voiceThinking: ClaudeVoiceThinking;
}

/**
 * Haiku's voice turn does not think before it speaks unless `SHANNON_HAIKU_VOICE_THINKING=on` (owner-approved 2026-10-13) (2026-10-13, VM probe of
 * `claude-haiku-5-5` at effort low: adaptive thinking spent 450–650 hidden tokens and 2–3 s before the first spoken word of a
 * one- or two-sentence reply). The Sonnet tier's voice already answers before thinking (`between_tools`); Haiku rejects that
 * value, so its equivalent is `disabled`. Text keeps adaptive thinking.
 */
export function haikuVoiceThinking(environment: Environment = serverEnvironment()): ClaudeVoiceThinking {
  return switchOn(environment, 'SHANNON_HAIKU_VOICE_THINKING') ? 'adaptive' : 'disabled';
}

export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';

type Environment = Readonly<Record<string, string | undefined>>;

export function anthropicApiKey(environment: Environment = serverEnvironment()): string | null {
  return environment.SHANNON_ANTHROPIC_API_KEY?.trim() || environment.ANTHROPIC_API_KEY?.trim() || null;
}

export function sonnetSettings(environment: Environment = serverEnvironment()): ClaudeChatSettings {
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T => {
    const text = value?.trim().toLowerCase();
    return text && (allowed as readonly string[]).includes(text) ? text as T : fallback;
  };
  return Object.freeze({
    model: environment.SHANNON_SONNET_MODEL?.trim() || DEFAULT_SONNET_MODEL,
    effort: pick(environment.SHANNON_SONNET_EFFORT, ['low', 'medium', 'high'] as const, 'low'),
    textThinking: pick(environment.SHANNON_SONNET_TEXT_THINKING, ['adaptive', 'between_tools'] as const, 'adaptive'),
    voiceThinking: pick(environment.SHANNON_SONNET_VOICE_THINKING, ['adaptive', 'between_tools'] as const, 'between_tools'),
  });
}

/** Whether the `sonnet` tier may leave for Anthropic: the key, `SHANNON_SONNET_ROUTING=on`, and stage 2's difficulty on. */
export function sonnetRoutingAvailable(environment: Environment = serverEnvironment()): boolean {
  return anthropicApiKey(environment) !== null && skillRoutingSwitches(environment).sonnetRouting;
}
