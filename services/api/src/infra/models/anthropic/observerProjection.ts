import type Anthropic from '@anthropic-ai/sdk';
import { shannonTool, toolFromProviderName } from '../../../mind/tools/shannonTools.js';
import { SELF_REWRITE_TOOLS } from '../../../mind/tools/selfRewriteToolDefinitions.js';

/** Only registry/built-in tool symbols may cross the observer boundary, never arbitrary provider text. */
export function observedToolName(name: string): string {
  if (name === 'web_search' || name === 'tool_open') return name;
  const tool = toolFromProviderName(name) ?? shannonTool(name);
  if (tool) return tool.name;
  return SELF_REWRITE_TOOLS.find(tool => tool.name === name || tool.name.replaceAll('.', '_') === name)?.name ?? 'unknown';
}

/** Counts and actual offered names only: system, history, schemas and signed blocks stay in the request. */
export function observedAnthropicRequest(body: Anthropic.MessageCreateParamsNonStreaming) {
  return { model: body.model, messageCount: body.messages.length, maximumOutputTokens: body.max_tokens,
    offeredTools: (body.tools ?? []).map(tool => 'name' in tool ? observedToolName(tool.name) : 'unknown') };
}

const stopReasons = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']);
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The provider answer may be private extraction JSON. Visible reply text is captured only at the reply decoder. */
export function observedAnthropicResponse(message: Anthropic.Message) {
  const usage = message.usage;
  return { model: message.model, stopReason: stopReasons.has(message.stop_reason ?? '') ? message.stop_reason : 'unknown',
    textCharacters: message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0),
    selectedTools: message.content.flatMap(block => block.type === 'tool_use' ? [observedToolName(block.name)] : []),
    usage: { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens),
      cacheReadTokens: count(usage?.cache_read_input_tokens), cacheCreationTokens: count(usage?.cache_creation_input_tokens),
      cacheCreation1hTokens: count(usage?.cache_creation?.ephemeral_1h_input_tokens), cacheCreation5mTokens: count(usage?.cache_creation?.ephemeral_5m_input_tokens) } };
}
