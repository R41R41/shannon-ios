import type Anthropic from '@anthropic-ai/sdk';
import { providerToolName, type ShannonToolDefinition, type ToolInputProperty } from '../../../mind/tools/shannonTools.js';
import { VOICE_REPLY_INSTRUCTIONS, type ShannonChatModelRequest, type ShannonVoiceModelRequest } from '../chatModel.js';
import { TOOLS_WITHHELD_INSTRUCTIONS, toolInstructions, type ShannonModelToolSession } from '../chatModelTools.js';
import { chatTurnRequestBody, offersTools, precedingReplyMessage, turnContextMessage } from '../chatModelTurn.js';
import { WEB_SEARCH_INSTRUCTIONS } from '../chatModelSupport.js';
import type { SonnetSettings } from './anthropicConfig.js';
import { isHaikuModel } from './haikuConfig.js';
import { structuredSchema } from './anthropicSchema.js';
export { structuredSchema } from './anthropicSchema.js';

/**
 * The Sonnet tier's request (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * Built from the same parts as luna's (`chatTurnRequestBody` for text, the voice payload's parts for voice), so the prompt
 * layers, the tool instructions and the registry's descriptions are the same text; only the lines below are Sonnet's own.
 * - Her prompt layers (identity, the fixed instructions, what she knows of the owner) are one `system` block with
 *   `cache_control`: tools render before it, so tools and system are the cached prefix. The turn's context follows the
 *   owner's words as a mid-conversation `system` message (operator authority, after the history, the cache untouched).
 * - Her registry tools are `strict` (the constraints the strict schema does not support are written into the description);
 *   `tool_choice` is `auto`, and `none` for the answer without tools (forced use is a 400 on this model).
 * - A web search is the server tool `web_search_20260209` offered with a line that asks for it, not a forced search.
 * - Text: the structured reply through `output_config.format` (the same schema, in the subset Anthropic supports).
 * - Thinking `adaptive` (text) or `between_tools` (voice) at the configured effort (`low` by default).
 */
export const SONNET_TEXT_LINES = [
  '[返答の形・Claude]',
  '最後の返事は指定のJSONの形だけで書く（前後に文を書かない）。道具を呼ぶ返事では文章を書かずに道具だけを呼ぶ。',
].join('\n');
export const SONNET_VOICE_LINES = '[返答の形・Claude] 話す言葉だけを書く。考えたことや道具の名前は書かない。';
export const SONNET_WEB_LINE = '[Web検索・Claude] この返事では、答える前に web_search で今の情報を調べ、調べた結果だけをもとに答える。';

type Message = Anthropic.MessageParam;
type ContentBlock = Anthropic.ContentBlockParam;

/** A registry tool as a strict Anthropic tool: the same name and description, the constraints strict schemas lack moved into words. */
export function sonnetTool(tool: ShannonToolDefinition): Anthropic.Tool {
  const properties = Object.fromEntries(Object.entries(tool.input.properties).map(([name, property]) => [name, strictProperty(property)]));
  return {
    name: providerToolName(tool.name), description: tool.description, strict: true,
    input_schema: { type: 'object', properties, required: [...tool.input.required], additionalProperties: false } as Anthropic.Tool.InputSchema,
  };
}

function strictProperty(property: ToolInputProperty): Record<string, unknown> {
  if (property.type === 'string') {
    const length = property.minLength && property.maxLength ? `（${property.minLength}〜${property.maxLength}字）` : property.maxLength ? `（${property.maxLength}字まで）` : '';
    return { type: 'string', description: `${property.description}${length}`, ...(property.enum ? { enum: [...property.enum] } : {}) };
  }
  if (property.type === 'integer') return { type: 'integer', description: `${property.description}（${property.minimum}〜${property.maximum}）` };
  return { type: 'boolean', description: property.description };
}


/**
 * Luna's input items as Anthropic messages: the history (consecutive turns of one role joined, and a first turn of hers
 * preceded by a marker so the conversation starts with a user turn), the owner's words, and the turn's context as a
 * mid-conversation `system` message right after them.
 */
export function sonnetMessages(input: readonly unknown[]): Message[] {
  const messages: Message[] = [];
  const contexts: string[] = [];
  const text = (content: unknown): string => typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).filter(Boolean).join('\n\n') : '';
  for (const item of input) {
    const value = item && typeof item === 'object' ? item as { role?: unknown; content?: unknown } : {};
    if (value.role === 'developer') { contexts.push(text(value.content)); continue; }
    if (value.role !== 'user' && value.role !== 'assistant') continue;
    const blocks: ContentBlock[] = Array.isArray(value.content)
      ? value.content.map(part => ({ type: 'text' as const, text: text([part]) })).filter(block => block.text)
      : [{ type: 'text', text: text(value.content) }];
    const last = messages.at(-1);
    if (last && last.role === value.role) last.content = [...last.content as ContentBlock[], ...blocks];
    else messages.push({ role: value.role, content: blocks });
  }
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '[ここまでの会話の続き]' }] });
  if (contexts.length) messages.push({ role: 'system', content: contexts.join('\n\n') });
  return messages;
}

/** The function tools a session offers now (with the tool menu, the schemas sent this round). */
export function sonnetTools(session: ShannonModelToolSession | undefined): Anthropic.Tool[] {
  return session ? session.definitions.map(sonnetTool) : [];
}

export function webSearchTool(maxUses: number): Anthropic.WebSearchTool20260209 {
  return { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses };
}

const system = (text: string, model: string): Anthropic.TextBlockParam[] => [{ type: 'text', text, cache_control: { type: 'ephemeral', ...(isHaikuModel(model) ? { ttl: '1h' as const } : {}) } }];

/** The text turn's request (non-streaming shape; the stream sends the same body). */
export function sonnetChatBody(settings: SonnetSettings, request: ShannonChatModelRequest, agentHostHint: string | undefined): Anthropic.MessageCreateParamsNonStreaming {
  const luna = chatTurnRequestBody(settings.model, request, agentHostHint);
  const web = !offersTools(request) && Boolean(request.useWebSearch || request.placeSearch);
  const tools: Anthropic.ToolUnion[] = offersTools(request) ? sonnetTools(request.tools) : web ? [webSearchTool(3)] : [];
  const schema = ((luna.text as { format?: { schema?: unknown } }).format?.schema) ?? {};
  return {
    model: settings.model,
    max_tokens: 16_000,
    system: system([String(luna.instructions), SONNET_TEXT_LINES, ...(web ? [SONNET_WEB_LINE] : [])].join('\n\n'), settings.model),
    messages: sonnetMessages(luna.input as unknown[]),
    ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
    thinking: { type: settings.textThinking } as Anthropic.ThinkingConfigParam,
    output_config: { effort: isHaikuModel(settings.model) && request.tier === 'luna_plus' ? 'medium' : settings.effort, format: { type: 'json_schema', schema: structuredSchema(schema) as Record<string, unknown> } },
  };
}

/** The voice turn's request: the parts of luna's voice payload, spoken text only. */
export function sonnetVoiceBody(settings: SonnetSettings, request: ShannonVoiceModelRequest, maximumOutputTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  const toolsOffered = request.tools?.definitions.length && !request.useWebSearch ? request.tools : undefined;
  const instructions = [
    request.systemPrompt, VOICE_REPLY_INSTRUCTIONS,
    ...(toolsOffered ? [toolInstructions(toolsOffered, true)] : request.toolsWithheld ? [TOOLS_WITHHELD_INSTRUCTIONS] : []),
    ...(request.profilePrompt ? [request.profilePrompt] : []), SONNET_VOICE_LINES, ...(request.useWebSearch ? [SONNET_WEB_LINE] : []),
  ].join('\n\n');
  const input = [
    ...request.history.map(item => ({ role: item.role, content: item.content })),
    ...turnContextMessage([...(request.turnContext ? [request.turnContext] : []), ...(request.useWebSearch ? [WEB_SEARCH_INSTRUCTIONS] : [])]),
    ...precedingReplyMessage(request),
    { role: 'user', content: request.message },
  ];
  const complex = request.conversationClass === 'skill_complex';
  const tools: Anthropic.ToolUnion[] = toolsOffered ? sonnetTools(toolsOffered) : request.useWebSearch ? [webSearchTool(complex ? 3 : 2)] : [];
  return {
    model: settings.model,
    // Thinking counts toward the ceiling: room for it beside the spoken reply.
    max_tokens: maximumOutputTokens + (settings.voiceThinking === 'adaptive' ? 4_000 : 1_000),
    system: system(instructions, settings.model),
    messages: sonnetMessages(input),
    ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
    thinking: { type: settings.voiceThinking } as Anthropic.ThinkingConfigParam,
    output_config: { effort: isHaikuModel(settings.model) && request.tier === 'luna_plus' ? 'medium' : settings.effort },
  };
}
