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
