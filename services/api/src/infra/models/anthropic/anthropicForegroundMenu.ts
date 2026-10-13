import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRequestToolAdditionBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ShannonModelToolSession } from '../chatModelTools.js';
import { TOOL_OPEN_PROVIDER_NAME } from '../../../mind/tools/shannonToolMenu.js';
import { isAppendOnlyAnthropicModel } from './haikuConfig.js';
import { alwaysLoadedToolNames, providerToolName, toolFromProviderName } from '../../../mind/tools/shannonTools.js';
import { nonStrictTool, strictGrammarFits, strictRequestFits, TOOL_CALL_SCHEMA, TOOL_CALL_INSTRUCTIONS } from './anthropicToolCapacity.js';

/** Only native 5.5 function-tool sessions use this protocol. Native web search keeps its own request. */
export function stableForegroundMenu(model: string, session: ShannonModelToolSession | undefined): boolean {
  return isAppendOnlyAnthropicModel(model) && Boolean(session?.menu);
}

/**
 * The opener without the turn's allowlist. Keep a non-deferred tool so inline definitions do not change the provider's tool-use
 * prefix. The name is checked against the live offer by session.meta; embedding its changing allowlist here would invalidate
 * every cache entry.
 */
export function stableOpener(open: Anthropic.Tool): Anthropic.Tool {
  const name = { type: 'string', description: '開く道具の名前（現在の[ボクの道具・献立]にある名前）' };
  return { ...open, input_schema: { ...open.input_schema, properties: { name } } };
}

/**
 * Jev's selected definitions remain available on the first decision, but no longer change the cached tools/system.
 * The current offer is operator context after the history. Its original session still validates every open and call.
 * Definitions are strict while the request stays within the grammar budget (`ANTHROPIC_GRAMMAR_BUDGET`; the stopping/approval
 * controls and the owner's voice lookups first); the rest go as native non-strict definitions, still callable by name.
 */
export function appendForegroundMenu(body: Anthropic.MessageCreateParamsNonStreaming, instructions: string): Anthropic.MessageCreateParamsNonStreaming {
  const tools = (body.tools ?? []) as Anthropic.Tool[];
  const open = tools.find(tool => tool.name === TOOL_OPEN_PROVIDER_NAME);
  if (!open) throw new Error('ANTHROPIC_FOREGROUND_MENU_MISSING');
  const bounded = { ...body, tools: [stableOpener(open), TOOL_CALL_SCHEMA] };
  if (!strictRequestFits(bounded)) throw new Error('ANTHROPIC_OUTPUT_SCHEMA_CAPACITY');
  const candidates = tools.filter(tool => tool.name !== TOOL_OPEN_PROVIDER_NAME);
  const registryNames = candidates.map(tool => ({ name: toolFromProviderName(tool.name)?.name ?? tool.name }));
  const controls = new Set(alwaysLoadedToolNames(registryNames).map(providerToolName));
  const admitted: Anthropic.Tool[] = [];
  for (const tool of [...candidates.filter(tool => controls.has(tool.name)), ...candidates.filter(tool => !controls.has(tool.name))]) {
    if (strictGrammarFits(bounded, [...admitted, tool])) admitted.push(tool);
  }
  const names = new Set(admitted.map(tool => tool.name));
  const changes: BetaRequestToolAdditionBlock[] = candidates
    .map(definition => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition: names.has(definition.name) ? definition : nonStrictTool(definition) } }));
  return { ...bounded, messages: [...body.messages, { role: 'system',
    content: [{ type: 'text', text: `${instructions}\n${TOOL_CALL_INSTRUCTIONS}` }, ...changes] as unknown as Anthropic.ContentBlockParam[] }] };
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

/**
 * A rejected request has no new signed prefix. Rewrite only its unaccepted tail; accepted messages remain exact. After a
 * compiled-grammar refusal its definitions stay native tools, without strict decoding, so they are still called by name.
 */
export function nonStrictUnacceptedTail(messages: readonly Anthropic.MessageParam[], acceptedLength: number): Anthropic.MessageParam[] {
  return messages.map((message, index) => {
    if (index < acceptedLength || message.role !== 'system' || !Array.isArray(message.content)) return message;
    const content = (message.content as unknown as Array<{ type: string; tool?: { type?: string; definition?: Anthropic.Tool } }>).map(block => {
      if (block.type !== 'tool_addition' || !block.tool?.definition?.strict) return block;
      return { ...block, tool: { ...block.tool, definition: nonStrictTool(block.tool.definition) } };
    });
    return { ...message, content: content as unknown as Anthropic.ContentBlockParam[] };
  });
}
