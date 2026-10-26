import { placeSearchInstructions, placeSearchSchema } from '../../integrations/places/placeDiscovery.js';
import type { ShannonChatModelRequest, ShannonChatModelResult } from './chatModel.js';
import { REPLY_FEELING_SCHEMA, replyFeelingInstructions } from '../../mind/emotion/chatReplyFeeling.js';
import { REPLY_REACTION_SCHEMA } from '../../mind/action/respond/replyReaction.js';
import {
  ATTACHMENT_SAFETY_INSTRUCTIONS,
  GENERATED_ARTIFACT_INSTRUCTIONS,
  INTENT_PLAN_INSTRUCTIONS,
  ROOM_LOOK_SCHEMA,
  NATURAL_TALK_STYLE_INSTRUCTIONS,
  SHANNON_RESPONSE_STYLE_INSTRUCTIONS,
  THREAD_SUMMARY_INSTRUCTIONS,
  THREAD_TITLE_INSTRUCTIONS,
  WEB_SEARCH_INSTRUCTIONS,
  agentTaskInstructions,
  attachmentProjection,
  extractOutputText,
  extractWebSources,
  parseStructuredTurn,
  priorThreadSummaryInstructions,
  stableScopeIdentifier,
} from './chatModelSupport.js';
import { APP_LOOK_SCHEMA } from '../../contracts/appLookContract.js';
import { MINECRAFT_INTENT_SCHEMA } from '../../surfaces/minecraft/minecraftIntent.js';
import { TOOLS_WITHHELD_INSTRUCTIONS, asksForParallelCalls, providerFunctionTools, toolInstructions } from './chatModelTools.js';

/**
 * The text-chat turn of the OpenAI Responses adapter: the request body and the reading of
 * the completed response. Moved out of `chatModel.ts` so the streaming call can send the same
 * body and read the same way (`chatModelGolden.test.ts` holds both to recorded bytes). Key
 * order is part of the request; do not reorder.
 *
 * The request runs from what never changes to what changes every turn, so the provider's prompt
 * cache holds as much of its start as it can (Syzygy ADR-0003 principle 4). The instructions are
 * her identity, the fixed blocks of this adapter, the blocks fixed for a Talk (her reply's
 * feeling, her tools) and what she knows of the owner. The turn's own blocks
 * (`chatTurnContextBlocks`) are one developer message after the history and just before the
 * owner's words, so the replayed history is part of the prefix the next turn repeats.
 */
export function chatTurnRequestBody(
  model: string, request: ShannonChatModelRequest, agentHostHint: string | undefined,
): Record<string, unknown> {
  return {
    model,
    instructions: chatTurnInstructions(request, agentHostHint),
    input: [
      ...request.history.map(item => ({ role: item.role, content: item.content })),
      ...turnContextMessage(chatTurnContextBlocks(request)),
      ...precedingReplyMessage(request),
      {
        role: 'user',
        content: request.attachments?.length
          ? [
            { type: 'input_text', text: request.message },
            { type: 'input_text', text: attachmentProjection(request.attachments) },
          ]
          : request.message,
      },
    ],
    // Stage 2: `luna_plus` thinks one step longer.
    reasoning: { effort: request.tier === 'luna_plus' ? 'low' : 'none' },
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'shannon_chat_turn',
        strict: true,
        schema: chatTurnSchema(withoutReactionOffer(request)),
      },
    },
    max_output_tokens: 2_200,
    ...(request.useWebSearch || request.placeSearch ? {
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      max_tool_calls: 3,
    } : {}),
    // Her registry tools (`chatModelTools.ts`), never beside a forced web search. A text turn that offers only reading tools may
    // ask for several calls in one response, which run together (ADR-0003 stage 4, `chatModelToolStep.ts`); one that offers a
    // write asks for one at a time, so that two writes never meet the output ceiling; `SHANNON_PARALLEL_TOOLS=off`: one at a time.
    ...(offersTools(request) ? { tools: providerFunctionTools(request.tools!.definitions), tool_choice: 'auto', parallel_tool_calls: asksForParallelCalls(request.tools!.definitions) } : {}),
    store: false,
    prompt_cache_key: stableScopeIdentifier(request.scopeKey),
    safety_identifier: stableScopeIdentifier(request.scopeKey),
  };
}

/**
 * Her prompt layers for a text turn, in this order: her identity, the fixed blocks of the text surface, the blocks fixed for a
 * Talk (her reply's feeling, her tools) and what she knows of the owner. Shared by the OpenAI adapter and the Claude request.
 */
export function chatTurnInstructions(request: ShannonChatModelRequest, agentHostHint: string | undefined): string {
  // `SHANNON_NATURAL_TALK` (the owner alone): the conversation's style in place of the report's.
  return [request.systemPrompt, request.naturalTalk ? NATURAL_TALK_STYLE_INSTRUCTIONS : SHANNON_RESPONSE_STYLE_INSTRUCTIONS,
    GENERATED_ARTIFACT_INSTRUCTIONS,
    INTENT_PLAN_INSTRUCTIONS,
    agentTaskInstructions(agentHostHint),
    THREAD_SUMMARY_INSTRUCTIONS,
    ...(request.offerReplyFeeling ? [replyFeelingInstructions()] : []),
    ...(offersTools(request) ? [toolInstructions(request.tools!, false)] : request.toolsWithheld ? [TOOLS_WITHHELD_INSTRUCTIONS] : []),
    ...(request.profilePrompt ? [request.profilePrompt] : []),
  ].join('\n\n');
}

/** The structured reply of a text turn: the base fields and the ones this turn offers. Key order is part of the request. */
export function chatTurnSchema(request: ShannonChatModelRequest): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', description: 'ユーザーに見せる自然な日本語の返答' },
      // After `reply`, so the first sentence of a streamed reply never waits for it (chatReplyStreamDecoder.ts).
      ...(request.offerReplyFeeling ? { feeling: REPLY_FEELING_SCHEMA } : {}),
      threadSummary: {
        type: ['string', 'null'],
        description: 'この返答までのトークの目的、決定、現在地、未決事項を短く表すナビゲーション要約',
      },
      // Always in the schema, so the schema (part of the cached prefix) is the same on the turn that asks for a title
      // and on every other; only that turn's `[トークタイトル]` block asks for one, and only then is it read.
      threadTitle: { type: ['string', 'null'], description: '最初のユーザー発言とシャノン側のreplyの話題を表す短いトークタイトル。[トークタイトル]で求められた時だけ書き、それ以外はnull' },
      taskDecision: {
        type: 'object',
        additionalProperties: false,
        properties: {
          disposition: { type: 'string', enum: ['none', 'clarify', 'propose'] },
          reason: { type: 'string', description: '判定理由。内部監査用に短く具体的に書く' },
        },
        required: ['disposition', 'reason'],
      },
      taskProposal: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              goal: { type: 'string' },
              hostHint: { type: ['string', 'null'] },
              projectHint: { type: ['string', 'null'] },
              risk: { type: ['string', 'null'] },
            },
            required: ['title', 'goal', 'hostHint', 'projectHint', 'risk'],
          },
        ],
      },
      intentPlan: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              nextStep: { type: 'string', description: '目的に対する直近の具体的な一手' },
              steps: {
                type: 'array', minItems: 1, maxItems: 5,
                items: { type: 'string', description: '短く検証可能な計画段階' },
              },
            },
            required: ['nextStep', 'steps'],
          },
        ],
      },
      artifacts: {
        anyOf: [
          { type: 'null' },
          {
            type: 'array',
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: '拡張子を含む安全で短いファイル名' },
                mimeType: {
                  type: 'string',
                  enum: ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/x-source-code'],
                },
                content: { type: 'string', description: 'ユーザーが保存できるUTF-8テキスト生成物' },
                summary: { type: ['string', 'null'], description: '生成物の内容を表す短い説明' },
              },
              required: ['name', 'mimeType', 'content', 'summary'],
            },
          },
        ],
      },
      ...(request.placeSearch ? { places: placeSearchSchema } : {}), ...(request.offerRoomLook ? { roomLook: ROOM_LOOK_SCHEMA } : {}), ...(request.offerAppLook ? { appLook: APP_LOOK_SCHEMA } : {}),
      ...(request.offerMinecraftIntent ? { minecraftIntent: MINECRAFT_INTENT_SCHEMA } : {}),
      // Last, so nothing before it changes for a turn that does not offer it.
      ...(request.offerReaction ? { reaction: REPLY_REACTION_SCHEMA } : {}),
    },
    required: ['reply', ...(request.offerReplyFeeling ? ['feeling'] : []), 'threadSummary', 'taskDecision', 'taskProposal', 'intentPlan', 'artifacts', ...(request.placeSearch ? ['places'] : []), ...(request.offerRoomLook ? ['roomLook'] : []), ...(request.offerAppLook ? ['appLook'] : []), ...(request.offerMinecraftIntent ? ['minecraftIntent'] : []), 'threadTitle', ...(request.offerReaction ? ['reaction'] : [])],
  };
}

/**
 * The blocks of one turn, in this order: its context (the shared state and everything else that changes, `turnContext`),
 * then what this turn alone asks for (attachments, a web or place search, the saved summary of the Talk, a title).
 */
export function chatTurnContextBlocks(request: ShannonChatModelRequest): string[] {
  return [
    ...(request.turnContext ? [request.turnContext] : []),
    ...(request.attachments?.length ? [ATTACHMENT_SAFETY_INSTRUCTIONS] : []),
    ...(request.useWebSearch || request.placeSearch ? [WEB_SEARCH_INSTRUCTIONS] : []),
    ...(request.placeSearch ? [placeSearchInstructions(request.placeSearch)] : []),
    ...(request.priorThreadSummary ? [priorThreadSummaryInstructions(request.priorThreadSummary)] : []),
    ...(request.generateThreadTitle ? [THREAD_TITLE_INSTRUCTIONS] : []),
  ];
}

/** The turn's blocks as the one developer message that follows the history; nothing when there are none. */
export function turnContextMessage(blocks: readonly string[]): Array<{ role: 'developer'; content: string }> {
  return blocks.length ? [{ role: 'developer', content: blocks.join('\n\n') }] : [];
}

/** Her words just before the owner's (`ShannonPrecedingReply`), directly before his message; nothing without them. */
export function precedingReplyMessage(request: { precedingReply?: string }): Array<{ role: 'assistant'; content: string }> {
  return request.precedingReply ? [{ role: 'assistant', content: request.precedingReply }] : [];
}

export type ParsedChatTurn = ReturnType<typeof parseStructuredTurn>;

/** The structured turn of a completed response envelope. Throws exactly as the adapter always did. */
export function parsedChatTurn(envelope: unknown): ParsedChatTurn {
  return parseStructuredTurn(extractOutputText(envelope));
}

export function chatTurnResult(
  model: string, request: ShannonChatModelRequest, envelope: unknown, structured: ParsedChatTurn,
): ShannonChatModelResult {
  const webSources = request.useWebSearch || request.placeSearch ? extractWebSources(envelope) : [];
  return {
    mode: 'openai',
    model,
    reply: structured.reply,
    ...(structured.threadSummary ? { threadSummary: structured.threadSummary } : {}),
    ...(webSources.length ? { webSources } : {}),
    ...(request.placeSearch && structured.places.length ? { places: structured.places } : {}),
    ...(request.offerRoomLook && structured.roomLook ? { roomLook: structured.roomLook } : {}), ...(request.offerAppLook && structured.appLook ? { appLook: structured.appLook } : {}),
    ...(request.offerReplyFeeling && structured.replyFeeling ? { replyFeeling: structured.replyFeeling } : {}),
    ...(request.offerMinecraftIntent && structured.minecraftIntent ? { minecraftIntent: structured.minecraftIntent } : {}),
    ...(request.offerReaction && structured.reaction ? { reaction: structured.reaction } : {}),
    ...(structured.artifacts.length ? { artifacts: structured.artifacts } : {}),
    ...(request.generateThreadTitle && structured.threadTitle ? { threadTitle: structured.threadTitle } : {}),
    taskDecision: structured.taskDecision,
    ...(structured.intentPlan ? { intentPlan: structured.intentPlan } : {}),
    ...(structured.taskProposal ? { taskProposal: structured.taskProposal } : {}),
  };
}

/** A turn offers her registry tools when it has a session with tools and does not force a web search. */
export function offersTools(request: Pick<ShannonChatModelRequest, 'tools' | 'useWebSearch' | 'placeSearch'>): boolean {
  return Boolean(request.tools?.definitions.length) && !request.useWebSearch && !request.placeSearch;
}

/** The fields a text turn may add to its structured reply (Syzygy ADR-0009 stage 1, M4: the cache plan's exception turns). */
export type TurnReplyField = 'feeling' | 'places' | 'roomLook' | 'appLook' | 'minecraftIntent' | 'webSearchNeedsInput' | 'reaction';

/** The fields this turn adds to its structured reply (the required web read's own field among them). */
export function offeredReplyFields(request: ShannonChatModelRequest): TurnReplyField[] {
  const offers: Array<[TurnReplyField, unknown]> = [['feeling', request.offerReplyFeeling], ['places', request.placeSearch],
    ['roomLook', request.offerRoomLook], ['appLook', request.offerAppLook], ['minecraftIntent', request.offerMinecraftIntent],
    ['webSearchNeedsInput', request.requireWebSearch], ['reaction', request.offerReaction]];
  return offers.filter(([, offered]) => Boolean(offered)).map(([field]) => field);
}

/** The instructions `chatTurnRequestBody` adds to the system for what this turn offers (the reply's feeling). */
export function offerInstructions(request: ShannonChatModelRequest): string[] {
  return request.offerReplyFeeling ? [replyFeelingInstructions()] : [];
}

/** The request whose instructions hold only what every turn has: no offer's instructions, no tools, no withheld line. */
export function withoutTurnInstructions(request: ShannonChatModelRequest): ShannonChatModelRequest {
  return { ...request, offerReplyFeeling: undefined, tools: undefined, toolsWithheld: undefined };
}

/** For a turn that offered her reply's feeling, whether the answer carried one; null for a turn that did not offer it. */
export function offeredFeelingAnswered(request: ShannonChatModelRequest, structured: ParsedChatTurn): boolean | null {
  return request.offerReplyFeeling ? Boolean(structured.replyFeeling) : null;
}

/**
 * The offers of the cache plan's common schema (ADR-0009 stage 1, M4 grammar fix): her reply's feeling and her reaction, as an
 * owner turn in the app's Talk has them.
 */
export function withCommonOffers(request: ShannonChatModelRequest): ShannonChatModelRequest {
  return { ...request, offerReplyFeeling: true, offerReaction: true };
}

/** The request the historical GPT adapter reads: her reaction is a Claude request's field only (`replyReaction.ts`). */
export function withoutReactionOffer(request: ShannonChatModelRequest): ShannonChatModelRequest {
  if (!request.offerReaction) return request;
  const { offerReaction: _offer, ...rest } = request;
  return rest;
}
