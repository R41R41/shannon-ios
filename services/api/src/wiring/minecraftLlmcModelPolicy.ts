import type { RecordableClient } from '../infra/decisionRecords/decisionRecordClient.js';
import { AnthropicRequestNotSentError } from '../infra/models/anthropic/anthropicFcaFailure.js';
import { DEFAULT_HAIKU_MODEL } from '../infra/models/anthropic/haikuConfig.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** A Minecraft run's explicit single-model policy. Invalid settings never fall back to a stronger model. */
export function strictMinecraftLlmcModel(values: Environment): string | null {
  const strict = values.SHANNON_MINECRAFT_LLMC_STRICT_MODEL?.trim();
  if (!strict || strict === 'off') return null;
  if (strict !== 'on') throw new Error('MINECRAFT_LLMC_STRICT_MODEL_INVALID');
  const model = values.SHANNON_MINECRAFT_LLMC_MODEL?.trim();
  const plan = values.SHANNON_MINECRAFT_LLMC_PLAN_MODEL?.trim();
  const escalate = values.SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL?.trim();
  if ((model !== DEFAULT_HAIKU_MODEL && model !== 'claude-sonnet-5-5')
    || (plan && plan !== model) || (escalate && escalate !== 'none')) {
    throw new Error('MINECRAFT_LLMC_STRICT_MODEL_INVALID');
  }
  return model;
}

/** Check immediately before the provider call, including injected clients and requests made while replanning. */
export function guardMinecraftLlmcModelClient<T extends RecordableClient>(client: T, model: string): T {
  const guarded = { messages: { create(body: never, options: never): PromiseLike<unknown> {
    if ((body as { model?: unknown }).model !== model) throw new AnthropicRequestNotSentError('MINECRAFT_LLMC_MODEL_POLICY');
    return client.messages.create(body, options);
  } } };
  return guarded as unknown as T;
}
