import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRequestToolAdditionBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ShannonModelToolSession } from '../chatModelTools.js';
import { TOOL_OPEN_PROVIDER_NAME } from '../../../mind/tools/shannonToolMenu.js';
import { isAppendOnlyAnthropicModel } from './haikuConfig.js';

/** Only native 5.5 function-tool sessions use this protocol. Native web search keeps its own request. */
export function stableForegroundMenu(model: string, session: ShannonModelToolSession | undefined): boolean {
  return isAppendOnlyAnthropicModel(model) && Boolean(session?.menu);
}

/**
 * Jev's selected definitions remain available on the first decision, but no longer change the cached tools/system.
 * The current offer is operator context after the history. Its original session still validates every open and call.
 * Known tools normally belong in deferred top-level declarations; the full registry exceeds the strict-schema cap,
 * so this bounded by-value protocol uses the same exception as subsequent tool_open additions.
 */
export function appendForegroundMenu(body: Anthropic.MessageCreateParamsNonStreaming, instructions: string): Anthropic.MessageCreateParamsNonStreaming {
  const tools = (body.tools ?? []) as Anthropic.Tool[];
  const open = tools.find(tool => tool.name === TOOL_OPEN_PROVIDER_NAME);
  if (!open) throw new Error('ANTHROPIC_FOREGROUND_MENU_MISSING');
  const changes: BetaRequestToolAdditionBlock[] = tools.filter(tool => tool.name !== TOOL_OPEN_PROVIDER_NAME)
    .map(definition => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition } }));
  // Keep a non-deferred tool so inline definitions do not change the provider's tool-use prefix. The name is checked
  // against the live offer by session.meta; embedding its changing allowlist here would invalidate every cache entry.
  const opener: Anthropic.Tool = { ...open, input_schema: { ...open.input_schema,
    properties: { name: { type: 'string', description: '開く道具の名前（現在の[ボクの道具・献立]にある名前）' } } } };
  return { ...body, tools: [opener], messages: [...body.messages, { role: 'system',
    content: [{ type: 'text', text: instructions }, ...changes] as unknown as Anthropic.ContentBlockParam[] }] };
}

/** Content-free inventory for Observer. Interpret changes in order; do not report inactive or deferred definitions. */
export function activeAnthropicToolNames(body: Anthropic.MessageCreateParamsNonStreaming): string[] {
  const names = new Set((body.tools ?? []).flatMap(tool => 'name' in tool && !('defer_loading' in tool && tool.defer_loading) ? [tool.name] : []));
  for (const message of body.messages) {
    if (message.role !== 'system' || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown as Array<{ type: string; tool?: { type?: string; name?: string; definition?: { name?: string } } }>) {
      if (block.type === 'tool_addition') {
        const name = block.tool?.type === 'tool_definition' ? block.tool.definition?.name : block.tool?.name;
        if (typeof name === 'string') names.add(name);
      } else if (block.type === 'tool_removal' && typeof block.tool?.name === 'string') names.delete(block.tool.name);
    }
  }
  return [...names];
}
