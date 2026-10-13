import Anthropic from '@anthropic-ai/sdk';
import { offerRefusal, reportRejection } from '../anthropic/anthropicRejection.js';

/** The pure parts of the one tool loop (`claudeToolLoop.ts`, Syzygy ADR-0009 stage 1, M7): its notes, results and refusals. */

/**
 * A refusal before any word and before any tool ran: the tiered model answers with Haiku instead. Its name and message are
 * part of the recorded request goldens and the logs, so they keep the tier they were introduced for.
 */
export class SonnetRefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`SONNET_REFUSAL${category ? `:${category}` : ''}`);
    this.name = 'SonnetRefusalError';
  }
}

/**
 * The bounded read recovery is the owner's side of the turn: a user message after her end_turn (a mid-conversation system
 * message may not follow an assistant end_turn; ADR-0009 stage 1, quick fix 1).
 */
export const READ_RECOVERY_NOTE = '依頼されたWeb検索はまだ実行されていない。調べる約束だけでは完了しない。'
  + '必要な地域や対象が分かっているならweb_searchを使ってから答える。不明なら必要なことだけを短く聞く。';

export const NOT_OFFERED_IN_TURN = JSON.stringify({ ok: false, text: 'この返事では道具を出していないので、何も実行していない。道具なしで答える。',
  failure: 'not_offered', retryable: false });

/** The model's calls in a turn that offers no tool, and their answer: nothing ran, the name is not offered. */
export function declinedCalls(message: Anthropic.Message): Anthropic.MessageParam[] {
  const results = toolUses(message).map(use => ({ type: 'tool_result' as const, tool_use_id: use.id, content: NOT_OFFERED_IN_TURN, is_error: true }));
  return [{ role: 'assistant', content: message.content }, { role: 'user', content: results }];
}

export function toolUses(message: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
}

/** The step's outputs as one user message of tool results; a closed failure (not a refusal of the name) is an error result. */
export function toolResults(ran: readonly unknown[]): Anthropic.ToolResultBlockParam[] {
  return ran.flatMap(item => {
    const value = item as { type?: string; call_id?: string; output?: string };
    if (value.type !== 'function_call_output' || !value.call_id) return [];
    return [{ type: 'tool_result' as const, tool_use_id: value.call_id, content: value.output ?? '', ...(failed(value.output) ? { is_error: true } : {}) }];
  });
}

function failed(output: string | undefined): boolean {
  try {
    const value = JSON.parse(output ?? '{}') as { ok?: unknown; failure?: unknown };
    return value.ok === false && value.failure !== 'not_offered';
  } catch {
    return false;
  }
}

/** Keep original results as quoted data while removing tool references that a plain request cannot declare. */
export function plainMessages(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.flatMap(message => {
    if (!Array.isArray(message.content)) return [message];
    const content = message.content.flatMap<Anthropic.ContentBlockParam>(plainBlock);
    return content.length ? [{ ...message, content }] : [];
  });
}

function plainBlock(block: Anthropic.ContentBlockParam): Anthropic.ContentBlockParam[] {
  if (block.type === 'tool_use') return [];
  if (block.type !== 'tool_result') return [block];
  const text = typeof block.content === 'string' ? block.content.slice(0, 8_000) : JSON.stringify(block.content ?? []).slice(0, 8_000);
  return [{ type: 'text' as const, text: `[道具の結果] ${text}` }];
}

/** Whether a refused first request of a plan turn without tools is asked again in the shape without the plan (logged, counted). */
export function fellBack(error: unknown, options: { planFallback?: unknown; onPlanEvent?: (event: 'fallback') => void }): boolean {
  const refusal = offerRefusal(error);
  if (!options.planFallback || refusal === null) return false;
  reportRejection(error, true);
  const status = error instanceof Anthropic.APIError ? error.status : null;
  console.warn(JSON.stringify({ event: 'cache_plan_fallback', status, class: refusal }));
  options.onPlanEvent?.('fallback');
  return true;
}
