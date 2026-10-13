import type Anthropic from '@anthropic-ai/sdk';
import { providerToolName, type ShannonToolDefinition, type ToolInputProperty } from '../../../mind/tools/shannonTools.js';
import type { ShannonChatModelRequest, ShannonVoiceModelRequest } from '../chatModel.js';
import {
  RICH_TEXT_BLOCK_INSTRUCTIONS, SHORT_VOICE_REPLY_INSTRUCTIONS, SPOKEN_STRUCTURED_REPLY_LINE, VOICE_NATURAL_INSTRUCTIONS,
} from '../../../mind/action/respond/respondInstructions.js';
import { TOOLS_WITHHELD_INSTRUCTIONS, toolInstructions, type ShannonModelToolSession } from '../chatModelTools.js';
import { chatTurnRequestBody, offersTools, precedingReplyMessage, turnContextMessage } from '../chatModelTurn.js';
import { WEB_SEARCH_INSTRUCTIONS } from '../chatModelSupport.js';
import type { SonnetSettings } from './anthropicConfig.js';
import { isHaikuModel, usesOneHourAnthropicCache } from './haikuConfig.js';
import { structuredSchema } from './anthropicSchema.js';
import { appendForegroundMenu, stableForegroundMenu } from './anthropicForegroundMenu.js';
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
 * - Voice offers native web search. Structured text receives a separate non-JSON search receipt through a read tool.
 * - Text: the structured reply through `output_config.format` (the same schema, in the subset Anthropic supports).
 * - Thinking `adaptive` (text) or `between_tools` (voice) at the configured effort (`low` by default); Haiku at medium.
 */
export const SONNET_TEXT_LINES = [
  '[返答の形・Claude]',
  '最後の返事は指定のJSONの形だけで書く（前後に文を書かない）。道具を呼ぶ返事では文章を書かずに道具だけを呼ぶ。',
].join('\n');
export const SONNET_VOICE_LINES = '[返答の形・Claude] 話す言葉だけを書く。考えたことや道具の名前は書かない。';
export const SONNET_WEB_LINE = '[Web検索・Claude] この返事では、答える前に web_search で今の情報を調べ、調べた結果だけをもとに答える。';
/** The structured answer after the auxiliary search: its evidence came from that search alone. */
export const WEB_ANSWER_LINE = '[Web検索の回答] このターンの検索結果だけに基づいて答える。調べる予定だけで返事を終えない。確認できない情報は断定しない。';
/** The field a turn that requires the web read answers with when it must ask for the missing target first. */
export const WEB_SEARCH_NEEDS_INPUT = Object.freeze({
  type: 'boolean',
  description: '検索に必要な対象や地域が不明で、replyでその不足を短く質問する場合だけtrue。検索の約束や結果はfalse。検索未実行を完了としない。',
});

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
  // 20260209 otherwise defaults to code-execution filtering. Both voice and the auxiliary text read
  // use direct web receipts; keep the caller explicit without changing search limits or cache markers.
  return { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, allowed_callers: ['direct'] };
}

/**
 * The owner's answer 3 of 2026-10-12 (Syzygy ADR-0009 stage 1 plan, §6): a Haiku conversation turn, text or voice, thinks at
 * medium on every tier and is never raised mid-turn. Sonnet keeps its configured effort.
 */
export const HAIKU_CONVERSATION_EFFORT = 'medium';

export function conversationEffort(settings: SonnetSettings): SonnetSettings['effort'] {
  return isHaikuModel(settings.model) ? HAIKU_CONVERSATION_EFFORT : settings.effort;
}

const system = (text: string, model: string): Anthropic.TextBlockParam[] => [{ type: 'text', text, cache_control: { type: 'ephemeral', ...(usesOneHourAnthropicCache(model) ? { ttl: '1h' as const } : {}) } }];

/** A voice turn answered through the structured text request keeps the spoken rules (`spokenReply`). */
export function spokenReplyLines(request: Pick<ShannonChatModelRequest, 'spokenReply'>): string[] {
  return request.spokenReply ? [SPOKEN_STRUCTURED_REPLY_LINE, SHORT_VOICE_REPLY_INSTRUCTIONS, VOICE_NATURAL_INSTRUCTIONS] : [];
}

/** The text turn's request (non-streaming shape; the stream sends the same body). */
export function sonnetChatBody(settings: SonnetSettings, request: ShannonChatModelRequest, agentHostHint: string | undefined): Anthropic.MessageCreateParamsNonStreaming {
  const inline = offersTools(request) && stableForegroundMenu(settings.model, request.tools);
  const luna = chatTurnRequestBody(settings.model, inline ? { ...request, tools: undefined, toolsWithheld: undefined } : request, agentHostHint);
  const web = !offersTools(request) && Boolean(request.useWebSearch || request.placeSearch);
  // Web evidence was obtained by the non-JSON auxiliary operation before this structured answer.
  const tools: Anthropic.ToolUnion[] = offersTools(request) ? sonnetTools(request.tools) : [];
  const schema = ((luna.text as { format?: { schema?: Record<string, unknown> } }).format?.schema) ?? {};
  if (request.requireWebSearch) {
    schema.properties = { ...schema.properties as object, webSearchNeedsInput: { ...WEB_SEARCH_NEEDS_INPUT } };
    schema.required = [...schema.required as string[], 'webSearchNeedsInput'];
  }
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: settings.model,
    max_tokens: 16_000,
    // Rich chat: how a text reply is shown (tables, charts, images), for the app's own Talk only.
    system: system([String(luna.instructions), SONNET_TEXT_LINES, ...(request.richBlocks ? [RICH_TEXT_BLOCK_INSTRUCTIONS] : []),
      ...spokenReplyLines(request), ...(web ? [WEB_ANSWER_LINE] : [])].join('\n\n'), settings.model),
    messages: sonnetMessages(luna.input as unknown[]),
    ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
    thinking: { type: settings.textThinking } as Anthropic.ThinkingConfigParam,
    output_config: {
      effort: conversationEffort(settings),
      format: { type: 'json_schema', schema: structuredSchema(schema) as Record<string, unknown> },
    },
  };
  return inline ? appendForegroundMenu(body, toolInstructions(request.tools!, false)) : body;
}

/** The voice turn's request: the parts of luna's voice payload, spoken text only. */
export function sonnetVoiceBody(settings: SonnetSettings, request: ShannonVoiceModelRequest, maximumOutputTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  const toolsOffered = request.tools?.definitions.length && !request.useWebSearch ? request.tools : undefined;
  const inline = stableForegroundMenu(settings.model, toolsOffered);
  const instructions = [
    request.systemPrompt, SHORT_VOICE_REPLY_INSTRUCTIONS, VOICE_NATURAL_INSTRUCTIONS,
    ...(toolsOffered ? inline ? [] : [toolInstructions(toolsOffered, true)] : request.toolsWithheld ? [TOOLS_WITHHELD_INSTRUCTIONS] : []),
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
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: settings.model,
    // Thinking counts toward the ceiling: room for it beside the spoken reply.
    max_tokens: maximumOutputTokens + (settings.voiceThinking === 'adaptive' ? 4_000 : 1_000),
    system: system(instructions, settings.model),
    messages: sonnetMessages(input),
    ...(tools.length ? { tools, tool_choice: { type: 'auto' as const } } : {}),
    thinking: { type: settings.voiceThinking } as Anthropic.ThinkingConfigParam,
    output_config: { effort: conversationEffort(settings) },
  };
  return inline ? appendForegroundMenu(body, toolInstructions(toolsOffered!, true)) : body;
}
