import { placeSearchInstructions, placeSearchSchema } from './placeDiscovery.js';
import type { ShannonChatModelRequest, ShannonChatModelResult } from './chatModel.js';
import {
  ATTACHMENT_SAFETY_INSTRUCTIONS,
  GENERATED_ARTIFACT_INSTRUCTIONS,
  INTENT_PLAN_INSTRUCTIONS,
  ROOM_LOOK_SCHEMA,
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
import { APP_LOOK_SCHEMA } from './appLookContract.js';

/**
 * The text-chat turn of the OpenAI Responses adapter: the request body and the reading of
 * the completed response. Moved out of `chatModel.ts` unchanged so the streaming call can
 * send the same body and read the same way (`chatModelGolden.test.ts` holds both to the
 * bytes recorded before the move). Key order is part of the request; do not reorder.
 */
export function chatTurnRequestBody(
  model: string, request: ShannonChatModelRequest, agentHostHint: string | undefined,
): Record<string, unknown> {
  return {
    model,
    instructions: [request.systemPrompt, SHANNON_RESPONSE_STYLE_INSTRUCTIONS,
      ...(request.attachments?.length ? [ATTACHMENT_SAFETY_INSTRUCTIONS] : []),
      ...(request.useWebSearch || request.placeSearch ? [WEB_SEARCH_INSTRUCTIONS] : []),
      ...(request.placeSearch ? [placeSearchInstructions(request.placeSearch)] : []),
      GENERATED_ARTIFACT_INSTRUCTIONS,
      INTENT_PLAN_INSTRUCTIONS,
      agentTaskInstructions(agentHostHint),
      ...(request.priorThreadSummary ? [priorThreadSummaryInstructions(request.priorThreadSummary)] : []),
      THREAD_SUMMARY_INSTRUCTIONS,
      ...(request.generateThreadTitle ? [THREAD_TITLE_INSTRUCTIONS] : []),
    ].join('\n\n'),
    input: [
      ...request.history.map(item => ({ role: item.role, content: item.content })),
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
    reasoning: { effort: 'none' },
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: 'shannon_chat_turn',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reply: { type: 'string', description: 'ユーザーに見せる自然な日本語の返答' },
            threadSummary: {
              type: ['string', 'null'],
              description: 'この返答までのトークの目的、決定、現在地、未決事項を短く表すナビゲーション要約',
            },
            ...(request.generateThreadTitle ? {
              threadTitle: { type: ['string', 'null'], description: '最初のユーザー発言とシャノン側のreplyの話題を表す短いトークタイトル' },
            } : {}),
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
          },
          required: ['reply', 'threadSummary', 'taskDecision', 'taskProposal', 'intentPlan', 'artifacts', ...(request.placeSearch ? ['places'] : []), ...(request.offerRoomLook ? ['roomLook'] : []), ...(request.offerAppLook ? ['appLook'] : []), ...(request.generateThreadTitle ? ['threadTitle'] : [])],
        },
      },
    },
    max_output_tokens: 2_200,
    ...(request.useWebSearch || request.placeSearch ? {
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      tool_choice: { type: 'web_search' },
      include: ['web_search_call.action.sources'],
      max_tool_calls: 3,
    } : {}),
    store: false,
    prompt_cache_key: stableScopeIdentifier(request.scopeKey),
    safety_identifier: stableScopeIdentifier(request.scopeKey),
  };
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
    ...(structured.places.length ? { places: structured.places } : {}),
    ...(request.offerRoomLook && structured.roomLook ? { roomLook: structured.roomLook } : {}), ...(request.offerAppLook && structured.appLook ? { appLook: structured.appLook } : {}),
    ...(structured.artifacts.length ? { artifacts: structured.artifacts } : {}),
    ...(request.generateThreadTitle && structured.threadTitle ? { threadTitle: structured.threadTitle } : {}),
    taskDecision: structured.taskDecision,
    ...(structured.intentPlan ? { intentPlan: structured.intentPlan } : {}),
    ...(structured.taskProposal ? { taskProposal: structured.taskProposal } : {}),
  };
}
