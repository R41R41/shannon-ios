import type Anthropic from '@anthropic-ai/sdk';
import { record, type Usage } from './ledger.js';

/** One decision request, streamed so that the time to the first token is known. */
export interface CallResult {
  ok: boolean; error?: string; status?: number;
  content: Array<Record<string, any>>; stopReason: string | null;
  usage: Usage; costUsd: number;
  /** ms from the send to the first event / the first content block / the first tool input / the end. */
  tMessageStart: number | null; tFirstBlock: number | null; tFirstToolInput: number | null; tEnd: number;
  inputTransformations: unknown[];
}

export async function callDecision(client: Anthropic, body: Record<string, any>, headers: Record<string, string>, model: string, kind: string, note?: string): Promise<CallResult> {
  const began = performance.now();
  const result: CallResult = { ok: false, content: [], stopReason: null, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, costUsd: 0,
    tMessageStart: null, tFirstBlock: null, tFirstToolInput: null, tEnd: 0, inputTransformations: [] };
  const blocks: Array<Record<string, any>> = [], partial = new Map<number, string>();
  try {
    const stream = await client.messages.create({ ...body, stream: true } as never, { headers }) as unknown as AsyncIterable<Record<string, any>>;
    for await (const event of stream) {
      const now = performance.now() - began;
      if (event.type === 'message_start') {
        result.tMessageStart = now;
        const u = event.message?.usage ?? {};
        result.usage.input = u.input_tokens ?? 0; result.usage.cacheRead = u.cache_read_input_tokens ?? 0; result.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
        if (u.cache_creation) { result.usage.cacheWrite5m = u.cache_creation.ephemeral_5m_input_tokens ?? 0; result.usage.cacheWrite1h = u.cache_creation.ephemeral_1h_input_tokens ?? 0; }
        result.usage.output = u.output_tokens ?? 0;
        if (Array.isArray(event.message?.input_transformations)) result.inputTransformations.push(...event.message.input_transformations);
      } else if (event.type === 'content_block_start') {
        result.tFirstBlock ??= now;
        blocks[event.index] = { ...event.content_block };
        if (event.content_block.type === 'tool_use') partial.set(event.index, '');
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta ?? {};
        if (delta.type === 'input_json_delta') { result.tFirstToolInput ??= now; partial.set(event.index, (partial.get(event.index) ?? '') + delta.partial_json); }
        else if (delta.type === 'text_delta') blocks[event.index]!.text = (blocks[event.index]!.text ?? '') + delta.text;
        else if (delta.type === 'thinking_delta') blocks[event.index]!.thinking = (blocks[event.index]!.thinking ?? '') + delta.thinking;
        else if (delta.type === 'signature_delta') blocks[event.index]!.signature = delta.signature;
      } else if (event.type === 'message_delta') {
        result.stopReason = event.delta?.stop_reason ?? null;
        if (typeof event.usage?.output_tokens === 'number') result.usage.output = event.usage.output_tokens;
        if (typeof event.usage?.input_tokens === 'number' && event.usage.input_tokens > 0) result.usage.input = event.usage.input_tokens;
        if (typeof event.usage?.cache_read_input_tokens === 'number') result.usage.cacheRead = event.usage.cache_read_input_tokens;
        if (typeof event.usage?.cache_creation_input_tokens === 'number') result.usage.cacheWrite = event.usage.cache_creation_input_tokens;
        if (Array.isArray(event.delta?.input_transformations)) result.inputTransformations.push(...event.delta.input_transformations);
      } else if (event.type === 'error') { result.error = JSON.stringify(event.error).slice(0, 300); }
    }
    for (const [index, text] of partial) { try { blocks[index]!.input = text ? JSON.parse(text) : {}; } catch { blocks[index]!.input = { _unparsed: text.slice(0, 300) }; } }
    result.content = blocks.filter(Boolean);
    result.ok = !result.error && result.stopReason === 'tool_use';
    if (!result.ok && !result.error) result.error = `stop_reason ${result.stopReason}`;
  } catch (error) {
    const e = error as { status?: number; message?: string };
    result.error = String(e.message ?? error).slice(0, 300); result.status = e.status;
  }
  result.tEnd = performance.now() - began;
  result.costUsd = record(kind, model, result.usage, note);
  return result;
}
