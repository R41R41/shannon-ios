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
        result.push({ id, role: message.role, content: message.content });
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

function resultText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  const blocks = value.map(object);
  return blocks.every(block => block?.type === 'text' && typeof block.text === 'string') ? blocks.map(block => block!.text).join('\n') : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
