import type Anthropic from '@anthropic-ai/sdk';
import type { CompactionMessage } from '@shannon/mind';
import type { FcaHistoryCodec } from '../../../mind/action/fca/fcaHistoryPorts.js';
import { isFcaToolChangeMessage } from './anthropicFcaTools.js';

/** Public projection for a new replay epoch only. The original signed round is never edited or partly replayed. */
export const anthropicFcaHistoryCodec: FcaHistoryCodec = {
  bootstrap(text) { return [{ role: 'user', content: text }]; },
  // Inline tool additions/removals restate catalog definitions; `nativeFcaTools` re-adds whatever a new epoch lacks.
  reproducible(entry) {
    const message = object(entry);
    return !!message && isFcaToolChangeMessage(message);
  },
  // A decision message counts against the native budget without the parts each decision restates (`publicDecision`); the token
  // bound of the whole replay still counts them.
  measured(entry) {
    const message = object(entry);
    return message?.role === 'user' && typeof message.content === 'string' ? { ...message, content: publicDecision(message.content) } : entry;
  },
  tokens: entries => estimatedAnthropicTokens(entries),
  project(round) {
    const result: CompactionMessage[] = [];
    const calls = new Set<string>(), pending = new Set<string>();
    let sawAssistant = false;
    for (const [messageIndex, entry] of round.entries.entries()) {
      const message = object(entry);
      if (!message) return null;
      const id = `${round.stepId}:${messageIndex}`;
      if (isFcaToolChangeMessage(message)) {
        if (pending.size) return null;
        const changes = (message.content as Array<{ type: string; tool: { name?: string; definition?: { name: string } } }>)
          .map(change => ({ operation: change.type, name: change.tool.definition?.name ?? change.tool.name }));
        result.push({ id, role: 'user', content: `[Tool definitions changed] ${JSON.stringify(changes)}` });
        continue;
      }
      if (message.role !== 'user' && message.role !== 'assistant') return null;
      if (message.role === 'assistant' && pending.size) return null;
      if (message.role === 'assistant') sawAssistant = true;
      if (typeof message.content === 'string') {
        if (pending.size) return null;
        result.push({ id, role: message.role, content: message.role === 'user' ? publicDecision(message.content) : message.content });
        continue;
      }
      if (!Array.isArray(message.content) || !message.content.length) return null;
      for (const [blockIndex, value] of message.content.entries()) {
        const block = object(value), blockId = `${id}:${blockIndex}`;
        if (!block) return null;
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          if (message.role !== 'assistant') return null;
          continue;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          if (message.role === 'user' && pending.size) return null;
          result.push({ id: blockId, role: message.role, content: block.text });
        } else if (block.type === 'tool_use' && message.role === 'assistant' && typeof block.id === 'string' && block.id
          && typeof block.name === 'string' && object(block.input)) {
          if (calls.has(block.id)) return null;
          calls.add(block.id); pending.add(block.id);
          result.push({ id: blockId, role: 'tool_call', callId: block.id, content: JSON.stringify({ name: block.name, input: block.input }) });
        } else if (block.type === 'tool_result' && message.role === 'user' && typeof block.tool_use_id === 'string') {
          if (!pending.delete(block.tool_use_id)) return null;
          const content = resultText(block.content);
          if (content === null) return null;
          result.push({ id: blockId, role: 'tool_result', callId: block.tool_use_id,
            content: JSON.stringify({ ok: block.is_error !== true, result: content }) });
        } else return null;
      }
      if (message.role === 'user' && pending.size) return null;
    }
    return sawAssistant && calls.size > 0 && !pending.size ? result : null;
  },
};

/**
 * Parts of a decision message (`AnthropicFcaModel.decide`) that each decision states again from the current catalog, recall and
 * fixed instructions. Minebot lane run 2 (2026-10-14): of a first round's 97,282 characters, 47,487 were its decision message, the
 * catalog 19,803 and the recall packet 21,230 of them; the summary input (32,000) was spent on them, cut, before the round's calls.
 */
const RESTATED_EACH_DECISION = ['catalog', 'recall', 'skillIndex', 'contextInstructions', 'progressInstructions'] as const;
const RULE_HOLDERS = ['ownerClock', 'waiting'] as const;
/**
 * The public projection of a decision message keeps what the step was given to work on (task, messages, children, progress, the
 * body and observations) and names, without their text, the parts restated each decision; a fixed rule text is left out of its
 * holder. Other user text (a bootstrap, a tool change) is kept as it is. The stored native message is never changed.
 */
function publicDecision(text: string): string {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return text; }
  const row = object(value);
  if (!row || !object(row.task) || !RESTATED_EACH_DECISION.some(key => key in row)) return text;
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(row)) {
    if ((RESTATED_EACH_DECISION as readonly string[]).includes(key)) continue;
    const holder = (RULE_HOLDERS as readonly string[]).includes(key) ? object(item) : null;
    kept[key] = holder && 'rule' in holder ? Object.fromEntries(Object.entries(holder).filter(([name]) => name !== 'rule')) : item;
  }
  return JSON.stringify({ ...kept, restatedEachDecision: RESTATED_EACH_DECISION.filter(key => key in row) });
}

function resultText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const blocks = value.map(object);
  return blocks.every(block => block?.type === 'text' && typeof block.text === 'string') ? blocks.map(block => block!.text).join('\n') : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * What a decision message restates only when it changed within one replay epoch (Minebot lane, 2026-10-14, task 788da00a: of each
 * stored decision message's 62–77k characters, the recall packet was 32–40k and the catalog 19k; the catalog was the same on every
 * step and six to eight of the eight recalled memories were the same as the step before, byte for byte). Each native round stores
 * the message exactly as it was sent, so the replay stays append-only and every signed block keeps its original prefix; only what
 * the next message says changes. The epoch is the replay itself: a new public epoch (a summary, a clipped or fallback replay)
 * starts from a bootstrap that names these parts without their text (`publicDecision` above), so its first
 * decision states them all again.
 */
export const UNCHANGED = Object.freeze({ unchanged: true as const });
const ELIDED = ['catalog', 'skillIndex', 'contextInstructions', 'progressInstructions', 'bodyInstructions'] as const;

/** The fixed rule for reading an elided decision message; it belongs to the cached instructions, never to a message. */
export const FCA_RESTATED_RULE = 'Within this conversation a decision message restates only what changed since an earlier decision message: '
  + 'a part given as {"unchanged":true} (catalog, skillIndex, contextInstructions, progressInstructions, bodyInstructions) '
  + 'is exactly its latest full value in an earlier decision message. '
  + 'recall.items holds memories in full; recall.knownItemIds names memories that are current '
  + 'and unchanged since their latest full appearance earlier in this conversation. '
  + 'Only the memories in the latest recall.items and recall.knownItemIds are current recall: '
  + 'an earlier memory the latest decision message does not name is no longer available, so do not rely on it or repeat it.';

export interface RestatedKnowledge {
  /** The latest full value of each elidable part, as JSON. */
  parts: ReadonlyMap<string, string>;
  /** The latest full text of each memory the replay showed, as JSON, by memory id. */
  memories: ReadonlyMap<string, string>;
}

/** What the replayed decision messages of this epoch already showed in full. Anything that is not a decision message is ignored. */
export function restatedKnowledge(history: readonly Anthropic.MessageParam[]): RestatedKnowledge {
  const parts = new Map<string, string>(), memories = new Map<string, string>();
  for (const message of history) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    const row = decisionRow(message.content);
    if (!row) continue;
    for (const key of ELIDED) if (key in row && !unchanged(row[key])) parts.set(key, JSON.stringify(row[key]));
    const recall = object(row.recall);
    for (const item of Array.isArray(recall?.items) ? recall.items : []) {
      const memory = object(item);
      if (memory && typeof memory.id === 'string') memories.set(memory.id, JSON.stringify(memory));
    }
  }
  return { parts, memories };
}

/**
 * The decision message's fields with every unchanged part replaced by `UNCHANGED`. A memory is referenced by id only when it is in
 * the current packet, which the recall port has just read through the current forgetting and audience controls
 * (`taskRecall.ts`, `packet`), and its text equals its latest full appearance in this epoch; a memory withheld or forgotten since
 * is not in the packet, so it is never named as current. Field order is kept.
 */
export function elidedDecision(fields: Record<string, unknown>, knowledge: RestatedKnowledge): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((ELIDED as readonly string[]).includes(key)) result[key] = knowledge.parts.get(key) === JSON.stringify(value) ? UNCHANGED : value;
    else if (key === 'recall') result[key] = elidedRecall(value as RecallFields, knowledge);
    else result[key] = value;
  }
  return result;
}

/** The names of the parts an elided decision message gives as unchanged (content-free; fixed names from `ELIDED`). */
export function unchangedParts(fields: Record<string, unknown>): string[] {
  return ELIDED.filter(key => key in fields && fields[key] === UNCHANGED);
}

/** A recall packet as a decision message gives it (`modelRecall` in `anthropicFcaModel.ts`). */
type RecallFields = Record<string, unknown> & { items: readonly ({ id: string } & Record<string, unknown>)[] };
function elidedRecall(packet: RecallFields, knowledge: RestatedKnowledge): Record<string, unknown> {
  const items: unknown[] = [], known: string[] = [];
  for (const item of packet.items) {
    if (knowledge.memories.get(item.id) === JSON.stringify(item) && !known.includes(item.id)) known.push(item.id);
    else items.push(item);
  }
  return { ...packet, items, ...(known.length ? { knownItemIds: known } : {}) };
}

/** A decision message's fields (`AnthropicFcaModel.decide`): a JSON object with its task. A bootstrap or a tool result is not one. */
function decisionRow(text: string): Record<string, unknown> | null {
  if (!text.startsWith('{')) return null;
  try {
    const row = object(JSON.parse(text));
    return row && object(row.task) ? row : null;
  } catch { return null; }
}
const unchanged = (value: unknown) => object(value)?.unchanged === true && Object.keys(value as object).length === 1;

/**
 * A conservative estimate of Claude's input tokens for a request or part of one, from its JSON: 1.1 tokens a non-ASCII character
 * and one per 2.2 others (quotes, keys, escapes and English). Minebot lane task 788da00a (2026-10-14): a first decision of 66,072
 * tokens held about 24,000 non-ASCII and 90,000 other characters, which this puts at about 68,000 before its JSON escapes, and
 * higher with them. It bounds the replay below the 100k-token price step (`maximumReplayTokens`); provider usage stays the record.
 */
export function estimatedAnthropicTokens(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  const wide = text.match(/[^\u0000-\u007f]/gu)?.length ?? 0;
  const narrow = text.length - wide;
  return Math.ceil(wide * 1.1 + narrow / 2.2);
}
