import type Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import { serverEnvironment } from '../../config/serverEnvironment.js';
import { SHORT_VOICE_REPLY_INSTRUCTIONS, VOICE_NATURAL_INSTRUCTIONS } from '../../../mind/action/respond/respondInstructions.js';
import type { ShannonVoiceModelRequest } from '../chatModel.js';
import { TOOLS_WITHHELD_INSTRUCTIONS, toolInstructions } from '../chatModelTools.js';
import { precedingReplyMessage, turnContextMessage } from '../chatModelTurn.js';
import type { SonnetSettings } from './anthropicConfig.js';
import { appendForegroundMenu } from './anthropicForegroundMenu.js';
import {
  cachedSystem, PLAN_NO_TOOLS_LINE, planned, planToolPair, splitCapabilityLines, splitSkillIndex, withTurnLines, type PlanEnvironment,
} from './anthropicCachePlan.js';
import { conversationEffort, SONNET_VOICE_LINES, sonnetMessages, sonnetTools } from './anthropicRequest.js';
import { isAppendOnlyAnthropicModel } from './haikuConfig.js';

/**
 * The cache plan of a voice turn (Syzygy ADR-0009 stage 1, M6; `SHANNON_CLAUDE_CACHE_PLAN_VOICE`, off by default, canaried apart
 * from text). Core: response path. The text plan's rules (`anthropicCachePlan.ts`) on the spoken request:
 *
 * - tools: always the fixed pair `tool_open` / `tool_call` with `tool_choice: auto`; a turn without tools says so after the words.
 * - system: her identity without the turn's capability lines, then the voice instructions exactly as without the plan (answer
 *   first, short spoken sentences, natural wording, `SONNET_VOICE_LINES`). What she knows of the owner is in a voice turn only
 *   when the turn's skills ask for it, so it moves after the words with the skill index, the capability lines and the tool line.
 * - no output schema (voice is spoken text), thinking and effort as configured: nothing that changes from turn to turn.
 * - breakpoints: the transport's, as for text (`cachePlanMarkers.ts`): BP1 the system, BP2 the words, BP3 (5m) the tool result.
 *
 * A turn with a native web search keeps its request without the plan: its server tool is not in the fixed pair, and offering it
 * on every turn would let any turn search. Building the body is local work: the plan adds no request before the first word.
 */
export function voicePlanApplies(model: string, environment: PlanEnvironment = serverEnvironment()): boolean {
  return isAppendOnlyAnthropicModel(model) && switchOn(environment, 'SHANNON_CLAUDE_CACHE_PLAN_VOICE');
}

/** Whether the plan takes this voice turn: every turn but one with a native web search. */
export function voicePlanCovers(request: Pick<ShannonVoiceModelRequest, 'useWebSearch'>): boolean {
  return !request.useWebSearch;
}

/** The cached system of every voice turn of a Talk. */
export function voiceStableSystem(systemPrompt: string): string {
  return [splitCapabilityLines(systemPrompt).stable, SHORT_VOICE_REPLY_INSTRUCTIONS, VOICE_NATURAL_INSTRUCTIONS, SONNET_VOICE_LINES].join('\n\n');
}

/** The voice turn's own lines, after its context: capability lines, what she knows of the owner, the skill index, the tool line. */
export function voiceTurnLines(request: ShannonVoiceModelRequest): string[] {
  const identity = splitCapabilityLines(request.systemPrompt);
  const profile = splitSkillIndex(request.profilePrompt);
  const capabilities = identity.lines.length ? [['[この返事で使える道具によるボクの能力]', ...identity.lines].join('\n')] : [];
  const offered = Boolean(request.tools?.definitions.length);
  const toolLine = offered ? '' : request.toolsWithheld ? TOOLS_WITHHELD_INSTRUCTIONS : PLAN_NO_TOOLS_LINE;
  return [...capabilities, profile.stable ?? '', profile.index, toolLine].filter(Boolean);
}

/**
 * The owner's words as the next turn's history will replay them (`voiceReplayRule`: whitespace runs become one space), so the
 * next request repeats this one up to its words. Spacing carries nothing in a transcript; the words themselves are unchanged.
 */
export function spokenWords(message: string): string {
  return message.trim().replace(/\s+/gu, ' ') || message;
}

/** The voice turn's request under the plan (non-streaming shape; the stream sends the same body). */
export function plannedVoiceBody(
  settings: SonnetSettings, request: ShannonVoiceModelRequest, maximumOutputTokens: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const input = [
    ...request.history.map(item => ({ role: item.role, content: item.content })),
    ...turnContextMessage(request.turnContext ? [request.turnContext] : []),
    ...precedingReplyMessage(request),
    { role: 'user', content: spokenWords(request.message) },
  ];
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: settings.model,
    // Thinking counts toward the ceiling, as without the plan (the ceiling is not part of the cached prefix).
    max_tokens: maximumOutputTokens + (settings.voiceThinking === 'adaptive' ? 4_000 : 1_000),
    system: cachedSystem(voiceStableSystem(request.systemPrompt)),
    messages: withTurnLines(sonnetMessages(input), voiceTurnLines(request)),
    tools: planToolPair(),
    tool_choice: { type: 'auto' },
    thinking: { type: settings.voiceThinking } as Anthropic.ThinkingConfigParam,
    output_config: { effort: conversationEffort(settings) },
  };
  const offered = request.tools?.definitions.length ? request.tools : undefined;
  if (!offered) return planned(body, 'common');
  // A native 5.5 session always carries the menu here (`boundedToolMenu`); without its opener this throws, as for text.
  return planned(appendForegroundMenu({ ...body, tools: sonnetTools(offered) }, toolInstructions(offered, true)), 'common');
}
