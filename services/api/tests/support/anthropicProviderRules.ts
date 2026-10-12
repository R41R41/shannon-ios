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
  const messages = request.messages as Array<{ role: string }>;
  if (messages[0]?.role === 'system') return 'messages.0: a system message that holds tool blocks cannot be the first message';
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
