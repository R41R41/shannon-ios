import { ANTHROPIC_STRICT_LIMITS, requestStrictTools, schemaComplexity } from '../../src/infra/models/anthropic/anthropicToolCapacity.js';

/**
 * The request rules the Messages API enforced on the FCA decision request in production (live 400s, 2026-10-12), checked in
 * the order the API reported them. A fixture answers a violating request with the same 400 the API returned, so a request
 * shape the provider refuses cannot pass a model-free test again.
 */
const UNSUPPORTED_STRICT_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems'];

export function anthropicRequestViolation(body: Record<string, unknown>): string | null {
  const request = body as unknown as Parameters<typeof requestStrictTools>[0];
  const strict = requestStrictTools(request);
  for (const tool of strict) {
    const keyword = unsupportedKeyword(tool.input_schema);
    if (keyword) return `${tool.name}: property '${keyword}' is not supported`;
  }
  const messages = request.messages as Array<{ role: string; content: unknown }>;
  if (messages[0]?.role === 'system') return 'messages.0: a system message that holds tool blocks cannot be the first message';
  const placement = systemPlacementViolation(messages) ?? toolPairingViolation(messages);
  if (placement) return placement;
  if (strict.length > ANTHROPIC_STRICT_LIMITS.tools) return `Too many strict tools (${strict.length})`;
  const complexity = schemaComplexity(strict.map(tool => tool.input_schema));
  if (complexity.optional > ANTHROPIC_STRICT_LIMITS.optional) return `Schemas contains too many optional parameters (${complexity.optional})`;
  if (complexity.unions > ANTHROPIC_STRICT_LIMITS.unions) return `Schemas contains too many parameters with union types (${complexity.unions})`;
  return null;
}

/** The provider's 400 for a violating request, as the SDK receives it. */
export function anthropicRejection(message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
    { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_rejected' } });
}

function unsupportedKeyword(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const found = unsupportedKeyword(child); if (found) return found; } return null; }
  const schema = node as Record<string, unknown>;
  for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) if (keyword in schema && typeof schema[keyword] === 'number') return keyword;
  if (typeof schema.minItems === 'number' && schema.minItems > 1) return 'minItems';
  for (const [key, child] of Object.entries(schema)) {
    if (key === 'properties' && child && typeof child === 'object') {
      for (const property of Object.values(child)) { const found = unsupportedKeyword(property); if (found) return found; }
    } else if (typeof child === 'object') { const found = unsupportedKeyword(child); if (found) return found; }
  }
  return null;
}

type RuleMessage = { role: string; content: unknown };
const blocks = (message: RuleMessage | undefined): Array<Record<string, unknown>> =>
  message && Array.isArray(message.content) ? message.content.filter(block => block && typeof block === 'object') as Array<Record<string, unknown>> : [];
const carriesContent = (message: RuleMessage) => typeof message.content === 'string' ? message.content.length > 0
  : Array.isArray(message.content) && message.content.length > 0;

/**
 * Mid-conversation system messages (live 400, 2026-10-14, Minebot lane run 3: [bootstrap, tool changes, decision]): one that
 * carries content (text, tool_addition, tool_removal) must immediately follow a user turn (or an assistant turn ending in a server
 * tool result) and must either end `messages` or be immediately followed by an assistant turn. Consecutive system messages are
 * judged together.
 */
function systemPlacementViolation(messages: readonly RuleMessage[]): string | null {
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.role !== 'system') continue;
    let end = index;
    while (messages[end + 1]?.role === 'system') end += 1;
    const run = messages.slice(index, end + 1);
    if (run.some(carriesContent)) {
      const before = messages[index - 1], after = messages[end + 1];
      const lastBefore = blocks(before).at(-1);
      const follows = before?.role === 'user' || (before?.role === 'assistant' && typeof lastBefore?.type === 'string'
        && lastBefore.type.endsWith('_tool_result') && lastBefore.type !== 'tool_result');
      if (!follows) return `messages.${index}: a system message that carries content must immediately follow a user turn`;
      if (after && after.role !== 'assistant') {
        return `messages.${index}: a system message that carries content must be the last message or be immediately followed by an assistant turn`;
      }
    }
    index = end;
  }
  return null;
}

/** Every tool_result answers a tool_use of the assistant turn right before it, and every tool_use is answered in the next turn. */
function toolPairingViolation(messages: readonly RuleMessage[]): string | null {
  for (const [index, message] of messages.entries()) {
    const results = blocks(message).filter(block => block.type === 'tool_result').map(block => String(block.tool_use_id));
    if (results.length) {
      const previous = messages[index - 1];
      const calls = new Set(previous?.role === 'assistant' ? blocks(previous).filter(block => block.type === 'tool_use').map(block => String(block.id)) : []);
      const missing = results.find(id => !calls.has(id));
      if (missing !== undefined) return `messages.${index}.content: unexpected tool_use_id found in tool_result blocks: ${missing}`;
    }
    if (message.role === 'assistant' && index < messages.length - 1) {
      const calls = blocks(message).filter(block => block.type === 'tool_use').map(block => String(block.id));
      const next = messages[index + 1]!;
      const answered = new Set(next.role === 'user' ? blocks(next).filter(block => block.type === 'tool_result').map(block => String(block.tool_use_id)) : []);
      const open = calls.find(id => !answered.has(id));
      if (open !== undefined) return `messages.${index + 1}: tool_use ids were found without tool_result blocks immediately after: ${open}`;
    }
  }
  return null;
}
