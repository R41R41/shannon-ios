import type Anthropic from '@anthropic-ai/sdk';
import { switchOn } from '@shannon/switches';
import { anthropicApiKey } from '../infra/models/anthropic/anthropicConfig.js';
import type { AnthropicFcaUsage } from '../infra/models/anthropic/anthropicFcaModel.js';
import { claudeClient } from '../infra/models/claude/claudeClient.js';
import { structuredBody } from '../infra/models/claude/claudeStructured.js';
import { closedUsage, estimatedAnthropicCostUsd, knownCount, unknownCostUpperBound } from '../infra/models/claude/claudeUsage.js';
import { ROUTE_SCHEMA } from '../surfaces/minecraft/minecraftRoutePlanner.js';

/** What the planner sends with: the native client's one call it uses. */
type RouteClient = { messages: { create(body: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal }): PromiseLike<Anthropic.Message> } };
/** The strong model of the route plan unless `SHANNON_MINECRAFT_ROUTE_MODEL` names another (owner 2026-10-20). */
export const MINECRAFT_ROUTE_MODEL = 'claude-opus-5-5';
/** Room for adaptive thinking at `medium` and the answer (the review: 2,000 was cut off by the thinking). */
const ROUTE_OUTPUT_TOKENS = 6_000;

/** Tokens a character of the planner's request is counted as, at most (Japanese is about one a character; run 21 sent 2.9k for under 5k characters). */
const TOKENS_PER_CHARACTER = 1;
/** The pace a model writes at, for the output of a request that was cut off: a safe upper side (tokens a second). */
const OUTPUT_TOKENS_PER_SECOND = 100;

/**
 * What a request of the route planner that got no answer (aborted, failed) may have cost, from what is known: the input as it was sent
 * and the output at the pace it is written over the seconds it ran, never more than its ceiling. Booked as an unconfirmed charge
 * (`usageComplete: false`), as before.
 */
export function abortedRouteUsage(model: string, characters: number, elapsedMilliseconds: number, maximumOutputTokens: number): AnthropicFcaUsage {
  const input = Math.max(0, Math.ceil(characters * TOKENS_PER_CHARACTER));
  const output = Math.min(Math.max(0, maximumOutputTokens), Math.max(0, Math.floor(elapsedMilliseconds / 1000 * OUTPUT_TOKENS_PER_SECOND)));
  const counts = { input, cacheWrite: 0, cacheRead: 0, output, searches: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  return { model, usageComplete: false, inputTokens: input, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: output,
    totalTokens: input + output, estimatedCostUsd: estimatedAnthropicCostUsd(model, counts) };
}

/**
 * The route planner of a Minecraft body task (`minecraftRoutePlanner.ts`), with `SHANNON_MINECRAFT_ROUTE_PLAN` on and an Anthropic
 * key: one native request with the answer's JSON schema and adaptive thinking at `medium`, its usage charged to the task's step like
 * the decisions' (`recordUsage`: the step's budget and the usage ledger), the answer's parsed JSON returned. No cache contract (the
 * request is one of its kind per task). Off, or without a key: none, and nothing is asked.
 */
export function configuredMinecraftRoutePlanner(values: Readonly<Record<string, string | undefined>>, parts: {
  recordUsage(usage: AnthropicFcaUsage): void; client?: RouteClient;
  /** Where the content-free line of how the request went goes (its seconds and tokens, so that a slow plan has a reason on record). */
  log?(line: string): void;
}): ((system: string, input: string, signal: AbortSignal) => Promise<unknown>) | undefined {
  if (!switchOn(values, 'SHANNON_MINECRAFT_ROUTE_PLAN')) return undefined;
  const apiKey = anthropicApiKey(values);
  if (!apiKey && !parts.client) return undefined;
  const model = values.SHANNON_MINECRAFT_ROUTE_MODEL?.trim() || MINECRAFT_ROUTE_MODEL;
  const client = parts.client ?? clientFor(apiKey!);
  return async (system, input, signal) => {
    const body = structuredBody(model, system, input, ROUTE_SCHEMA, 'medium', ROUTE_OUTPUT_TOKENS);
    let message: Anthropic.Message;
    const began = Date.now();
    const say = (line: string) => { try { parts.log?.(line); } catch { /* logging never fails a plan */ } };
    try { message = await client.messages.create(body, { signal }); } catch (error) {
      const elapsed = Date.now() - began;
      say(`Shannon Minecraft route model model=${model} ms=${elapsed} outcome=${signal.aborted ? 'aborted' : 'error'}`);
      // A request that got no answer may still be billed, so it is booked, but at what it can have cost (the input as sent, the output
      // at the pace it is written for the seconds it ran), never at the ceiling of an unknown request (run 21: three aborted requests
      // were booked at $20.3 each, an input of a million tokens at the one-hour cache write).
      parts.recordUsage(abortedRouteUsage(model, system.length + input.length, elapsed, body.max_tokens));
      throw error;
    }
    const usage = message.usage, complete = closedUsage(usage);
    const counts = { input: knownCount(usage?.input_tokens), cacheWrite: knownCount(usage?.cache_creation_input_tokens),
      cacheRead: knownCount(usage?.cache_read_input_tokens), output: knownCount(usage?.output_tokens), searches: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const cost = Math.max(estimatedAnthropicCostUsd(model, counts), complete ? 0 : unknownCostUpperBound(model, body.max_tokens, 0, null));
    const inputTokens = counts.input + counts.cacheWrite + counts.cacheRead;
    parts.recordUsage({ model, usageComplete: complete, inputTokens, cachedInputTokens: counts.cacheRead, cacheCreationInputTokens: counts.cacheWrite,
      outputTokens: counts.output, totalTokens: inputTokens + counts.output, estimatedCostUsd: cost });
    // Why a plan took the time it took: the request's seconds, the tokens in and out (the thinking is in the output), and how it ended.
    say(`Shannon Minecraft route model model=${model} ms=${Date.now() - began} inputTokens=${inputTokens} outputTokens=${counts.output}`
      + ` thinkingBlocks=${message.content.filter(block => block.type === 'thinking').length} stop=${message.stop_reason ?? 'none'}`);
    if (message.stop_reason !== 'end_turn') throw new Error('MINECRAFT_ROUTE_INCOMPLETE');
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim();
    return JSON.parse(text) as unknown;
  };
}

/** One client per key (the planner itself is made per step, with that step's usage port and the switch as it is then). */
const clients = new Map<string, RouteClient>();
function clientFor(apiKey: string): RouteClient {
  if (!clients.has(apiKey)) clients.set(apiKey, claudeClient({ apiKey, timeoutMilliseconds: 60_000 }));
  return clients.get(apiKey)!;
}
/** The body task's part (`routePlanner`): empty while off. */
export function minecraftRoutePlannerPart(values: Readonly<Record<string, string | undefined>>, recordUsage: (usage: AnthropicFcaUsage) => void)
  : { routePlanner?: NonNullable<ReturnType<typeof configuredMinecraftRoutePlanner>> } {
  const planner = configuredMinecraftRoutePlanner(values, { recordUsage, log: line => console.info(line) });
  return planner ? { routePlanner: planner } : {};
}