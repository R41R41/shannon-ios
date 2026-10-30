import Anthropic from '@anthropic-ai/sdk';
import { SHANNON_FCA_PROGRESS_CAPABILITY } from '@shannon/cognition';
import type { FcaModelInput } from '../../../mind/action/fca/fcaPorts.js';
import type { TaskRecallPacket } from '../../../mind/recall/taskRecallPorts.js';
import { providerToolName } from '../../../mind/tools/toolRegistryPorts.js';
import { FCA_WAIT_RULE as WAIT_RULE } from './anthropicFcaControl.js';
import { observedAnthropicResponse, observedToolName } from './observerProjection.js';
import { isFcaToolChangeMessage } from './anthropicFcaTools.js';
import { bodyRecallView, bodySharedContext, FCA_CONTEXT_INSTRUCTIONS, FCA_CONTEXT_NAME } from './anthropicFcaContext.js';
import { estimatedAnthropicTokens } from './anthropicFcaHistory.js';
import { BODY_RULE } from './anthropicFcaInstructions.js';
import { type CutStages } from './anthropicFcaTransientRequest.js';
import { MINECRAFT_V2_TOOLS, V2_CONTROL_WORDS } from './anthropicFcaMinecraftSystem.js';
import { isFcaClearAtMessage, planField, renderedRequest } from './anthropicFcaTransient.js';

export const controlTool = (name: string, description: string, summary: string): Anthropic.Tool => ({
  name,
  description,
  strict: true,
  input_schema: {
    type: 'object',
    properties: { summary: { type: 'string', description: summary } },
    required: ['summary'],
    additionalProperties: false,
  },
});

export const CONTROL_TOOLS: Anthropic.Tool[] = [
  ['fca_wait', 'Wait for another task or new information. Summarize the concrete dependency; this does not finish the task.'],
  ['fca_complete', 'Finish this task only when its completion criteria are satisfied. Summarize the result using observed ' + 'evidence.'],
].map(([name, description]) => controlTool(name!, description!, 'A nonempty, public summary, at most 2000 characters.'));

/** The controls and tool names of a request by whether the mode (V2_CONTROL_WORDS: its Japanese controls) is on ('true'). */
export const MENUS: Readonly<Record<string, { controls: Anthropic.Tool[]; names: readonly string[] | undefined }>> = {
  true: {
    controls: V2_CONTROL_WORDS.map(([name, description, summary]) => controlTool(name, description, summary)),
    names: MINECRAFT_V2_TOOLS,
  },
  false: { controls: CONTROL_TOOLS, names: undefined },
};

export const ONE_HOUR = { type: 'ephemeral' as const, ttl: '1h' as const };

/** Amendment A-10: a request as it went out, kept so that one of its calls can be asked again (`AnthropicFcaModel.redecide`). */
export interface SentRequest {
  body: Anthropic.MessageCreateParamsNonStreaming;
  headers: Record<string, string> | undefined;
  names: Map<string, string>;
  history: readonly Anthropic.MessageParam[];
  requestTokens: number;
}

/** A signal that aborts `milliseconds` after `signal` does (never before it). */
export function graceAfter(signal: AbortSignal, milliseconds: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    timer = setTimeout(() => controller.abort(signal.reason), milliseconds);
    timer.unref?.();
  };
  if (signal.aborted) start();
  else signal.addEventListener('abort', start, { once: true });
  const dispose = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', start);
  };
  return { signal: controller.signal, dispose };
}

export function observedFcaToolName(name: string): string {
  return CONTROL_TOOLS.some((tool) => tool.name === name) || name === FCA_CONTEXT_NAME ? name : observedToolName(name);
}

export function observedFcaRequest(body: Anthropic.MessageCreateParamsNonStreaming) {
  return {
    model: body.model,
    messageCount: body.messages.length,
    maximumOutputTokens: body.max_tokens,
    offeredTools: (body.tools ?? []).map((tool) => ('name' in tool ? observedFcaToolName(tool.name) : 'unknown')),
  };
}

export function observedFcaResponse(message: Anthropic.Message) {
  const { stopReason, usage } = observedAnthropicResponse(message);
  return {
    stopReason,
    usage,
    selectedTools: message.content.flatMap((block) => (block.type === 'tool_use' ? [observedFcaToolName(block.name)] : [])),
  };
}

/**
 * The sizes of each FCA request, content-free, so that history plus tool definitions cannot pass the provider's next price step
 * unnoticed (review P3-1): characters of the replayed history, of its inline tool definitions, and of the whole request.
 */
export function logRequestSize(
  model: string,
  history: readonly Anthropic.MessageParam[],
  body: Anthropic.MessageCreateParamsNonStreaming,
  turn: readonly Anthropic.MessageParam[],
  built: RequestBuilt,
): number {
  const definitional = (message: Anthropic.MessageParam) => isFcaToolChangeMessage(message as unknown as Record<string, unknown>);
  const definitions = history.filter(definitional);
  // `historyCharacters` is the whole replay, its inline definitions included; `nativeHistoryCharacters` is the part the 64k
  // history budget measures (`FCA_HISTORY_POLICY`), the definitions having their own bound (Minebot lane run 1, 2026-10-14).
  const estimatedInputTokens = estimatedAnthropicTokens(renderedRequest(body));
  console.info(
    JSON.stringify({
      event: 'fca_request_size',
      model,
      historyCharacters: JSON.stringify(history).length,
      nativeHistoryCharacters: JSON.stringify(history.filter((message) => !definitional(message))).length,
      toolDefinitionCharacters: JSON.stringify(definitions).length,
      requestCharacters: JSON.stringify(body).length,
      estimatedInputTokens,
      skillGists: (built.sent ?? sentCounts(turn)).gists,
      ...sentGistFields(turn, built),
    }),
  );
  // The replay is bounded below the step (`maximumReplayTokens`); a request that still passes it is sent and priced as it is.
  if (estimatedInputTokens > PRICE_STEP_TOKENS)
    console.warn(JSON.stringify({ event: 'fca_request_price_step', model, estimatedInputTokens }));
  return estimatedInputTokens;
}

/** What the caller handed this decision before the message was elided and shortened (content-free): see `sentGistFields`. */
export interface RequestBuilt {
  taskId: string;
  bodyAttached: boolean;
  level: number | null;
  pointers: number;
  gists: number;
  elidedParts: readonly string[];
  /** A transient request: the pointers and gists its live state names (the stored text carries none) and the stored
   * parts it states. */
  sent?: { pointers: number; gists: number; parts: readonly string[]; cut: boolean; stages?: CutStages };
}

/** The skill pointers and gists of a body context, as counts (0 when none or not a list). */
export function skillCounts(body: unknown): { pointers: number; gists: number } {
  const fields = body && typeof body === 'object' ? (body as { skillPointers?: unknown; skillGists?: unknown }) : {};
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return { pointers: count(fields.skillPointers), gists: count(fields.skillGists) };
}

/**
 * The pointers and gists the decision message carries in its `body`, as counts only, never a gist. The message
 * is the first of the
 * turn, as sent (after any shortening); a message that cannot be read counts none.
 */
export function sentCounts(turn: readonly Anthropic.MessageParam[]): { pointers: number; gists: number } {
  const content = turn[0]?.content;
  if (typeof content !== 'string' || (!content.includes('"skillGists"') && !content.includes('"skillPointers"')))
    return { pointers: 0, gists: 0 };
  try {
    return skillCounts((JSON.parse(content) as { body?: unknown }).body);
  } catch {
    return { pointers: 0, gists: 0 };
  }
}

/**
 * Why a request's `skillGists` is what it is (Minecraft run 13: gists offered, yet `skillGists:0`): the task
 * (the line is otherwise
 * anonymous, and a research or chat task has no body), whether a body context was attached, the pointers and gists as sent and as
 * built, and `skillGistsElided` (built but not sent, by elision or shortening: today only a part of `ELIDED` is
 * ever left out, and
 * `body` is not one, so it stays false), the parts named as unchanged, and the shortening level. Content-free.
 */
export function sentGistFields(turn: readonly Anthropic.MessageParam[], built: RequestBuilt): Record<string, unknown> {
  const sent = built.sent ?? sentCounts(turn);
  return {
    taskId: built.taskId,
    bodyAttached: built.bodyAttached,
    skillPointers: sent.pointers,
    skillGistsBuilt: built.gists,
    skillGistsElided: built.gists > sent.gists,
    elidedParts: built.elidedParts,
    compactedLevel: built.level,
  };
}

/** Haiku 5.5 prices a prompt above 100,000 input tokens at five times the rate (`claudeUsage.ts`, `HAIKU_LONG_PRICES`). */
export const PRICE_STEP_TOKENS = 100_000;

/** The decision message's fields, before the parts this epoch already showed are left out (`elidedDecision`). */
export function decisionFields(
  input: FcaModelInput,
  ownerClock: Record<string, unknown> | undefined,
  transient = false,
): Record<string, unknown> {
  // Transient mode lists only the tools that are not core: the core definitions are loaded at the top level.
  const core = new Set(transient ? (input.coreTools ?? []).flatMap((tool) => [tool.name, providerToolName(tool.name)]) : []);
  return {
    ...(ownerClock ? { ownerClock } : {}),
    task: input.task,
    children: input.children ?? [],
    messages: input.messages,
    ...(input.catalog
      ? {
          catalog: input.catalog
            .filter((tool) => !core.has(tool.name) && !core.has(providerToolName(tool.name)))
            .map((tool) => ({ name: providerToolName(tool.name), description: tool.description })),
        }
      : {}),
    ...(input.sharedContext
      ? {
          sharedContext: input.body !== undefined ? bodySharedContext(input.sharedContext, input.task.id) : input.sharedContext,
          contextInstructions: FCA_CONTEXT_INSTRUCTIONS,
        }
      : {}),
    ...planField(input),
    ...(input.recall ? { recall: input.body !== undefined ? bodyRecallView(input.recall) : modelRecall(input.recall) } : {}),
    ...(input.progress ? { progress: input.progress, progressInstructions: SHANNON_FCA_PROGRESS_CAPABILITY.text } : {}),
    ...(input.observations ? { observations: input.observations } : {}),
    ...(input.body ? { body: input.body, bodyInstructions: BODY_RULE } : {}),
    ...(input.waiting ? { waiting: { ...input.waiting, rule: WAIT_RULE } } : {}),
    ...(input.skillIndex ? { skillIndex: input.skillIndex } : {}),
  };
}

/**
 * The recall packet as the model reads it: each memory's text whole, its provenance as its kind and counts. The source id lists
 * (Minebot lane task 788da00a, 2026-10-14: 3,000–4,600 of each memory's 3,900–5,400 characters, and 2,600 more for the packet)
 * are server evidence the runner has already pinned (`observeMemory`) and rechecks; no tool takes them, and `detailRef` still
 * names the memory for `memory.read`.
 */
export function modelRecall(packet: TaskRecallPacket): Record<string, unknown> & { items: readonly { id: string }[] } {
  const { sourceIds, ...rest } = packet;
  return {
    ...rest,
    sourceCount: sourceIds.length,
    items: packet.items.map((item) =>
      item.provenance
        ? {
            ...item,
            provenance: {
              kind: item.provenance.kind,
              sourceCount: item.provenance.sourceIds.length,
              readSourceCount: item.provenance.readSourceIds.length,
            },
          }
        : item,
    ),
  };
}

/**
 * The replay with a breakpoint on its last block, when that is a tool result or a text of a user turn: the end of the previous
 * request's answer and results, a few blocks after the previous request's own last breakpoint. The automatic
 * breakpoint at the end
 * of the request looks back only about 20 blocks for a cached prefix, and an inline definitions message alone holds one block per
 * tool (52–77 in Minebot lane task 788da00a), so after a selection change the end of the request could not reach the history
 * already written. This one always can, and the request stays within four breakpoints (protocol, instructions, this, automatic).
 * Only the request's copy carries the marker; the stored history never does, and a marker is not part of the cached content.
 */
export function markedHistory(history: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = history.at(-1);
  if (last?.role !== 'user' || !Array.isArray(last.content) || !last.content.length) return [...history];
  const blocks = [...last.content],
    tail = blocks.at(-1)!;
  if (tail.type !== 'tool_result' && tail.type !== 'text') return [...history];
  blocks[blocks.length - 1] = { ...tail, cache_control: ONE_HOUR };
  return [...history.slice(0, -1), { ...last, content: blocks }];
}

export function nativeHistory(history: readonly unknown[]): Anthropic.MessageParam[] {
  return history.map((item) => {
    const message = object(item);
    if (
      !message ||
      (!['user', 'assistant'].includes(String(message.role)) && !isFcaToolChangeMessage(message) && !isFcaClearAtMessage(message)) ||
      !(typeof message.content === 'string' || Array.isArray(message.content))
    ) {
      throw new Error('FCA_MODEL_HISTORY_INVALID');
    }
    // Preserve signed, redacted and future native blocks verbatim. Never normalize or summarize this prefix.
    return item as Anthropic.MessageParam;
  });
}

export function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
