import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicUsageEvidenceError, HAIKU_PROTOCOL_PREFIX } from './haikuCache.js';
import { usesOneHourAnthropicCache } from './haikuConfig.js';

/**
 * The cache plan of a transient body task's request (observation redesign P3, `SHANNON_FCA_OBS_MODE=transient`). `cacheHaikuRequest` also
 * sets the automatic breakpoint at the end of the request, and that end is a turn-scoped system message (`clear_at`), which may carry no
 * `cache_control` (the provider answers 400) and is not cached; where an automatic breakpoint would land is not known. This plan uses
 * explicit 1h breakpoints only (P0 probe, 2026-10-17: they work, and a cleared message never shows in a cache write):
 *   1. the transport protocol prefix (system[0]);  2. the task's fixed instructions (system[1], marked by the caller);
 *   3. the last stored block: the last block of the last user message, which is the decision's stored state text or the tool results
 *      before it (a system message after it, a tool change or a turn-scoped message, is skipped).
 * No top-level `cache_control`, at most four breakpoints in all, none on a system message of the history.
 */
const ONE_HOUR = { type: 'ephemeral' as const, ttl: '1h' as const };
export const FCA_BODY_BREAKPOINT_LIMIT = 4;
const WALKED = new Set(['content', 'system', 'tools', 'messages']);

/** How many `cache_control` markers a request holds (system, tools and message blocks, and the tool results' own content). */
export function breakpointCount(body: Anthropic.MessageCreateParamsNonStreaming): number {
  let count = 0;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const children = Array.isArray(value) ? value.map(child => [null, child] as const) : Object.entries(value);
    for (const [key, child] of children) {
      if (key === 'cache_control' && child !== null && child !== undefined) {
        const marker = child as { type?: unknown; ttl?: unknown };
        if (marker.type !== 'ephemeral' || marker.ttl !== '1h') throw new AnthropicUsageEvidenceError('HAIKU_CACHE_TTL_CONFLICT');
        count += 1;
      } else if (key === null || WALKED.has(key)) inspect(child);
    }
  };
  inspect({ tools: body.tools, system: body.system, messages: body.messages });
  return count;
}

/** The messages with a 1h marker on the last block of the last user message (system messages are skipped), when that block can hold one. */
function markedLastStored(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const result = [...messages];
  let index = result.length - 1;
  while (index >= 0 && (result[index]!.role as string) === 'system') index -= 1;
  const message = result[index];
  const blocks = message?.role === 'user' && Array.isArray(message.content) ? [...message.content] : null;
  const tail = blocks?.at(-1);
  if (message && blocks && tail && (tail.type === 'tool_result' || tail.type === 'text')) {
    blocks[blocks.length - 1] = { ...tail, cache_control: ONE_HOUR };
    result[index] = { ...message, content: blocks };
  }
  return result;
}

export function cacheFcaBodyRequest<T extends Anthropic.MessageCreateParamsNonStreaming>(body: T, prefix: string = HAIKU_PROTOCOL_PREFIX): T {
  if (!usesOneHourAnthropicCache(body.model)) return body;
  if (body.cache_control) throw new AnthropicUsageEvidenceError('HAIKU_CACHE_PROTOCOL_INVALID');
  const system = typeof body.system === 'string' ? [{ type: 'text' as const, text: body.system }] : [...(body.system ?? [])];
  // `prefix`: the transport block of system[0]; a Minecraft body task's own (SHANNON_MINECRAFT_OWN_PROMPT, `anthropicFcaMinecraftSystem.ts`).
  const installed = system[0]?.type === 'text' && system[0].text === prefix;
  const request = { ...body, messages: markedLastStored(body.messages), system: installed ? system
    : [{ type: 'text' as const, text: prefix, cache_control: ONE_HOUR }, ...system] } as T;
  if (breakpointCount(request) > FCA_BODY_BREAKPOINT_LIMIT) throw new AnthropicUsageEvidenceError('HAIKU_CACHE_BREAKPOINT_LIMIT');
  return request;
}
