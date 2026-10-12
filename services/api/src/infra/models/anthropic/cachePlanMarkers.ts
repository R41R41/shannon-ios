import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicUsageEvidenceError, HAIKU_PROTOCOL_PREFIX } from './haikuCache.js';

/**
 * The breakpoints of a foreground text request under the cache plan (Syzygy ADR-0009 stage 1, M4; `anthropicCachePlan.ts`).
 * Applied by the transport to each request as it leaves, so the tool rounds keep handing it unmarked bodies:
 *
 * - BP1, 1h: the end of the static system (the protocol prefix, then her fixed system), with the fixed tool pair before it.
 * - BP2, 1h: the last block of the turn's latest user message (her words, not a tool result). The next turn's history
 *   repeats everything up to it byte for byte, so its request reads what this one wrote.
 * - BP3, 5m: the latest tool result after it, so each later round of the turn reads the round before. The rounds of a turn
 *   follow each other within seconds and no later turn repeats a tool result, so the cheaper five-minute write is enough; the
 *   one-hour entries come first, as the provider requires, and the usage check accepts a five-minute share of the creation.
 *
 * No top-level automatic marker: it would write the turn's own tail (its context, its menu) at the one-hour price on every
 * request, and that tail is never repeated. BP1 is present on every request, so every response still reports a cache write
 * or read (the cache-evidence rule). At most three breakpoints of the provider's four are used.
 */
type Body = Anthropic.MessageCreateParamsNonStreaming;
type Block = Anthropic.ContentBlockParam;

export const CACHE_PLAN_BREAKPOINTS = 3;
const HOUR = Object.freeze({ type: 'ephemeral' as const, ttl: '1h' as const });
const FIVE_MINUTES = Object.freeze({ type: 'ephemeral' as const, ttl: '5m' as const });

function marked(block: Block, ttl: typeof HOUR | typeof FIVE_MINUTES): Block {
  return { ...block, cache_control: { ...ttl } } as Block;
}

function blocksOf(message: Anthropic.MessageParam): readonly Block[] {
  return Array.isArray(message.content) ? message.content : [];
}

function isWords(message: Anthropic.MessageParam): boolean {
  const blocks = blocksOf(message);
  return message.role === 'user' && blocks.some(block => block.type === 'text') && !blocks.some(block => block.type === 'tool_result');
}

function hasResults(message: Anthropic.MessageParam): boolean {
  return message.role === 'user' && blocksOf(message).some(block => block.type === 'tool_result');
}

function lastIndex(messages: readonly Anthropic.MessageParam[], test: (message: Anthropic.MessageParam) => boolean, after = -1): number {
  for (let index = messages.length - 1; index > after; index--) if (test(messages[index]!)) return index;
  return -1;
}

/** The message with its last block (or its last tool result) marked. */
function withMarker(message: Anthropic.MessageParam, results: boolean): Anthropic.MessageParam {
  const blocks = [...blocksOf(message)];
  const at = results ? blocks.map(block => block.type).lastIndexOf('tool_result') : blocks.length - 1;
  blocks[at] = marked(blocks[at]!, results ? FIVE_MINUTES : HOUR);
  return { ...message, content: blocks };
}

/** Where the turn's latest words are (BP2): also the number of history messages before them. -1 without words. */
export function wordsIndex(messages: readonly Anthropic.MessageParam[]): number {
  return lastIndex(messages, isWords);
}

/** BP2 and BP3 placed on copies; the caller's messages are never changed. */
export function markedMessages(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const words = wordsIndex(messages);
  const results = words < 0 ? -1 : lastIndex(messages, hasResults, words);
  return messages.map((message, index) => {
    if (index === words) return withMarker(message, false);
    return index === results ? withMarker(message, true) : message;
  });
}

function systemBlocks(body: Body): Anthropic.TextBlockParam[] {
  return typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : [...(body.system ?? [])];
}

/** The protocol prefix first (no marker of its own), and BP1 on the last system block. */
function plannedSystem(body: Body): Anthropic.TextBlockParam[] {
  const system = systemBlocks(body).filter(block => block.text !== HAIKU_PROTOCOL_PREFIX);
  const last = system.at(-1);
  if (!last) throw new AnthropicUsageEvidenceError('HAIKU_CACHE_PROTOCOL_INVALID');
  const ttl = last.cache_control?.ttl;
  if (last.cache_control && ttl !== '1h') throw new AnthropicUsageEvidenceError('HAIKU_CACHE_TTL_CONFLICT');
  return [{ type: 'text', text: HAIKU_PROTOCOL_PREFIX }, ...system.slice(0, -1), { ...last, cache_control: { ...HOUR } }];
}

function countMarkers(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum: number, child) => sum + countMarkers(child), 0);
  return Object.entries(value).reduce((sum, [key, child]) => sum + (key === 'cache_control' && child ? 1 : countMarkers(child)), 0);
}

/** The request as it is sent under the plan: its breakpoints placed, every other byte as the builder made it. */
export function cachePlanRequest<T extends Body>(body: T): T {
  if (body.cache_control) throw new AnthropicUsageEvidenceError('HAIKU_CACHE_PROTOCOL_INVALID');
  const prepared = { ...body, system: plannedSystem(body), messages: markedMessages(body.messages) };
  if (countMarkers([prepared.tools, prepared.system, prepared.messages]) > CACHE_PLAN_BREAKPOINTS) {
    throw new AnthropicUsageEvidenceError('HAIKU_CACHE_BREAKPOINT_LIMIT');
  }
  return prepared;
}
