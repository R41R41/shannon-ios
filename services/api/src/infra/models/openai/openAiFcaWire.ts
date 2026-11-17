import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { isFcaClearAtMessage } from '../anthropic/anthropicFcaTransient.js';
import { knownCount, tokenCount } from '../claude/claudeUsage.js';
import { estimatedOpenAICostWithCacheUsd } from '../llmUsage.js';
import type { OpenAiEffort } from './openAiModels.js';

/**
 * The wire of one FCA decision on OpenAI's Responses API.
 *
 * The task's stored history keeps the shape the runtime already holds (`anthropicFcaHistoryCodecV2` reads it, the stored state and
 * the cuts read it): user and assistant messages of blocks. What OpenAI answered is stored as blocks that say what they are:
 * - a `function_call` item is a `tool_use` block (`id` is the item's `call_id`; `openai_arguments` the arguments as the model wrote them,
 *   `openai_id` the item's id);
 * - a `reasoning` item is a `redacted_thinking` block that carries the item whole (`openai_item`, with its `encrypted_content`);
 * - a `message` item's text is a `text` block.
 * A request turns these back into `input` items, in the same order and the same bytes every time, so that the prefix is the cache's
 * (`prompt_cache_key` is fixed for the task). A thinking block that another maker signed is left out. The turn-scoped live state is
 * the one `role: system` message with `clear_at` of the request: only the newest goes out, as the last `developer` item.
 */
type Block = Record<string, unknown>;
export interface ResponsesParts { model: string; effort: OpenAiEffort; taskKey: string; maximumOutputTokens: number; replayReasoning: boolean }

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The key a task's requests share, so that they reach the cache that holds its prefix. */
export function promptCacheKey(taskId: string): string {
  return `fca-${createHash('sha256').update(taskId).digest('hex').slice(0, 24)}`;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => object(part)?.type === 'text' ? String(object(part)!.text ?? '') : '').join('\n') : '';
}

/** The `input` items of the request's messages (see the module's note), and the tool definitions its inline additions declare. */
export function inputItems(messages: readonly Anthropic.MessageParam[], replayReasoning: boolean): { items: unknown[]; additions: Anthropic.Tool[] } {
  const items: unknown[] = [], additions = new Map<string, Anthropic.Tool>();
  const lastLive = messages.map(message => isFcaClearAtMessage(message)).lastIndexOf(true);
  messages.forEach((message, index) => {
    if (isFcaClearAtMessage(message)) {
      if (index === lastLive) items.push({ role: 'developer', content: textOf(message.content) });
      return;
    }
    if ((message.role as string) === 'system') {
      for (const change of Array.isArray(message.content) ? message.content as unknown as Block[] : []) {
        const tool = object(change.tool);
        if (change.type === 'tool_addition' && tool?.type === 'tool_definition' && object(tool.definition)?.name) {
          additions.set(String(object(tool.definition)!.name), tool.definition as Anthropic.Tool);
        } else if (change.type === 'tool_removal' && typeof tool?.name === 'string') additions.delete(tool.name);
      }
      return;
    }
    if (typeof message.content === 'string') {
      items.push(message.role === 'user' ? { role: 'user', content: message.content }
        : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      return;
    }
    let texts: string[] = [];
    const flush = () => {
      if (texts.length) items.push({ role: 'user', content: texts.join('\n\n') });
      texts = [];
    };
    for (const raw of message.content) {
      const block = raw as unknown as Block;
      if (message.role === 'user') {
        if (block.type === 'text') texts.push(String(block.text ?? ''));
        else if (block.type === 'tool_result') {
          flush();
          items.push({ type: 'function_call_output', call_id: block.tool_use_id, output: `${block.is_error === true ? '[tool error]\n' : ''}${textOf(block.content)}` });
        }
        continue;
      }
      if (block.type === 'redacted_thinking') {
        const item = object(block.openai_item);
        if (item && replayReasoning) items.push(item);
      } else if (block.type === 'text') {
        const id = typeof block.openai_id === 'string' ? { id: block.openai_id } : {};
        items.push({ type: 'message', ...id, role: 'assistant', content: [{ type: 'output_text', text: String(block.text ?? '') }] });
      } else if (block.type === 'tool_use') {
        const id = typeof block.openai_id === 'string' ? { id: block.openai_id } : {};
        items.push({ type: 'function_call', ...id, call_id: block.id, name: block.name,
          arguments: typeof block.openai_arguments === 'string' ? block.openai_arguments : JSON.stringify(block.input ?? {}) });
      }
    }
    flush();
  });
  return { items, additions: [...additions.values()] };
}

/** A tool as a Responses function: not strict (the catalog's schemas are not the strict subset; the executor checks every input). */
export function functionTool(tool: Anthropic.Tool): Record<string, unknown> {
  return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.input_schema, strict: false };
}

export function instructionsOf(system: Anthropic.MessageCreateParamsNonStreaming['system'], protocol: string | undefined): string {
  const text = typeof system === 'string' ? system : (system ?? []).map(block => block.text).join('\n\n');
  return protocol && !text.startsWith(protocol) ? `${protocol}\n\n${text}` : text;
}

/** The Responses request of a decision built as a Messages-shaped body (`transientRequest`). */
export function responsesRequest(body: Anthropic.MessageCreateParamsNonStreaming, parts: ResponsesParts, protocol?: string): Record<string, unknown> {
  const { items, additions } = inputItems(body.messages, parts.replayReasoning);
  const declared = new Set((body.tools ?? []).map(tool => ('name' in tool ? tool.name : '')));
  const tools = [...(body.tools ?? []).filter(tool => !('type' in tool) || tool.type === undefined || tool.type === 'custom'),
    ...additions.filter(tool => !declared.has(tool.name))];
  return {
    model: parts.model, instructions: instructionsOf(body.system, protocol), input: items,
    tools: tools.map(tool => functionTool(tool as Anthropic.Tool)), tool_choice: 'auto', store: false,
    max_output_tokens: parts.maximumOutputTokens, prompt_cache_key: promptCacheKey(parts.taskKey), reasoning: { effort: parts.effort },
    ...(parts.replayReasoning ? { include: ['reasoning.encrypted_content'] } : {}),
  };
}

export type RoundStop = 'tool_use' | 'end_turn' | 'max_tokens' | 'refusal';
export interface ParsedRound { blocks: Anthropic.ContentBlock[]; stop: RoundStop; id: string }

/** What a Responses answer holds, as the blocks the history keeps. Throws `FCA_MODEL_OUTPUT_INVALID` for an answer that is not one. */
export function parsedRound(json: unknown, replayReasoning: boolean): ParsedRound {
  const response = object(json);
  const output = response?.output;
  if (!response || !Array.isArray(output)) throw new Error('FCA_MODEL_OUTPUT_INVALID');
  const blocks: Block[] = [];
  let refused = false;
  for (const raw of output) {
    const item = object(raw);
    if (!item) throw new Error('FCA_MODEL_OUTPUT_INVALID');
    if (item.type === 'reasoning') {
      if (replayReasoning && typeof item.encrypted_content === 'string') blocks.push({ type: 'redacted_thinking', data: '', openai_item: item });
    } else if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const piece = object(part);
        if (piece?.type === 'output_text' && typeof piece.text === 'string') {
          blocks.push({ type: 'text', text: piece.text, ...(typeof item.id === 'string' ? { openai_id: item.id } : {}) });
        } else if (piece?.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new Error('FCA_MODEL_OUTPUT_INVALID');
      let input: unknown = null;
      try { input = JSON.parse(item.arguments); } catch { input = null; }
      blocks.push({ type: 'tool_use', id: item.call_id, name: item.name, input, openai_arguments: item.arguments,
        ...(typeof item.id === 'string' ? { openai_id: item.id } : {}) });
    }
  }
  const incomplete = response.status === 'incomplete' ? object(response.incomplete_details)?.reason : undefined;
  const calls = blocks.some(block => block.type === 'tool_use');
  const stop: RoundStop = incomplete === 'content_filter' ? 'refusal' : incomplete ? 'max_tokens' : calls ? 'tool_use' : refused ? 'refusal' : 'end_turn';
  return { blocks: blocks as unknown as Anthropic.ContentBlock[], stop, id: typeof response.id === 'string' ? response.id : '' };
}

/** A failed answer (`status: failed` with an error body) as the closed word of its code, or null for any other answer. */
export function failedAnswer(json: unknown): { code: string | null } | null {
  const response = object(json);
  if (response?.status !== 'failed') return null;
  const code = object(response.error)?.code;
  return { code: typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(code) ? code : null };
}

/** The counts of an answer's usage; a missing count is zero, and `complete` says that the bill is known. */
export interface OpenAiCounts { input: number; cached: number; cacheWrite: number; output: number; complete: boolean }
export function openAiCounts(raw: unknown): OpenAiCounts {
  const usage = object(raw), details = object(usage?.input_tokens_details);
  const input = knownCount(usage?.input_tokens), output = knownCount(usage?.output_tokens);
  // `output_tokens` already holds the reasoning tokens (`output_tokens_details.reasoning_tokens`): they are paid as output.
  const written = details?.cache_write_tokens ?? details?.cache_creation_tokens ?? usage?.cache_creation_input_tokens;
  return { input, cached: Math.min(input, knownCount(details?.cached_tokens)), cacheWrite: knownCount(written), output,
    complete: tokenCount(usage?.input_tokens) && tokenCount(usage?.output_tokens) };
}

/** The USD of counts, at the ledger's prices for the model (`llmUsage.ts`: an unknown name is priced high). */
export function openAiCostUsd(model: string, counts: Pick<OpenAiCounts, 'input' | 'cached' | 'cacheWrite' | 'output'>): number {
  return estimatedOpenAICostWithCacheUsd(model, { inputTokens: counts.input, cachedInputTokens: counts.cached, outputTokens: counts.output,
    totalTokens: counts.input + counts.output, ...(counts.cacheWrite ? { cacheCreationInputTokens: counts.cacheWrite } : {}) });
}

/** What a request whose bill is unknown may have cost: the estimate of its input with a quarter more, all at the full input price, and its output ceiling. */
export function openAiUnknownCostUsd(model: string, requestTokens: number, maximumOutputTokens: number): number {
  return openAiCostUsd(model, { input: Math.ceil(requestTokens * 1.25), cached: 0, cacheWrite: 0, output: maximumOutputTokens });
}

/** The answer as a Messages object, for the observer's and the decision records' readers (never sent anywhere). */
export function messageShaped(model: string, round: ParsedRound, counts: OpenAiCounts): Anthropic.Message {
  return { id: round.id, type: 'message', role: 'assistant', model, content: round.blocks, stop_reason: round.stop, stop_sequence: null,
    usage: { input_tokens: Math.max(0, counts.input - counts.cached - counts.cacheWrite), output_tokens: counts.output,
      cache_creation_input_tokens: counts.cacheWrite, cache_read_input_tokens: counts.cached } } as unknown as Anthropic.Message;
}
