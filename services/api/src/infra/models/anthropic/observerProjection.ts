import type Anthropic from '@anthropic-ai/sdk';
import { shannonTool, toolFromProviderName } from '../../../mind/tools/shannonTools.js';
import { SELF_REWRITE_TOOLS } from '../../../mind/tools/selfRewriteToolDefinitions.js';
import { activeAnthropicToolNames } from './anthropicForegroundMenu.js';

/** Only registry/built-in tool symbols may cross the observer boundary, never arbitrary provider text. */
export function observedToolName(name: string, allowed: readonly { name: string }[] = []): string {
  const bodyTool = allowed.find(tool => tool.name === name || tool.name.replaceAll('.', '_') === name)?.name;
  if (bodyTool && /^(?:mc\.[a-z][a-z0-9-]{0,59}|minecraft\.(?:observe|reflex))$/u.test(bodyTool)) return bodyTool;
  if (name === 'web_search' || name === 'web_fetch' || name === 'tool_open' || name === 'tool_call') return name;
  const tool = toolFromProviderName(name) ?? shannonTool(name);
  if (tool) return tool.name;
  return SELF_REWRITE_TOOLS.find(tool => tool.name === name || tool.name.replaceAll('.', '_') === name)?.name ?? 'unknown';
}

/** Counts and actual offered names only: system, history, schemas and signed blocks stay in the request. */
export function observedAnthropicRequest(body: Anthropic.MessageCreateParamsNonStreaming) {
  return { model: body.model, messageCount: body.messages.length, maximumOutputTokens: body.max_tokens,
    offeredTools: activeAnthropicToolNames(body).map(name => observedToolName(name)) };
}

const stopReasons = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']);
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** The provider answer may be private extraction JSON. Visible reply text is captured only at the reply decoder. */
export function observedAnthropicResponse(message: Anthropic.Message) {
  const usage = message.usage;
  return { model: message.model, stopReason: stopReasons.has(message.stop_reason ?? '') ? message.stop_reason : 'unknown',
    textCharacters: message.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0),
    selectedTools: message.content.flatMap(block => block.type === 'tool_use' || block.type === 'server_tool_use' ? [observedToolName(block.name)] : []),
    usage: { inputTokens: count(usage?.input_tokens), outputTokens: count(usage?.output_tokens),
      cacheReadTokens: count(usage?.cache_read_input_tokens), cacheCreationTokens: count(usage?.cache_creation_input_tokens),
      cacheCreation1hTokens: count(usage?.cache_creation?.ephemeral_1h_input_tokens), cacheCreation5mTokens: count(usage?.cache_creation?.ephemeral_5m_input_tokens),
      webSearchRequests: count(usage?.server_tool_use?.web_search_requests) } };
}
