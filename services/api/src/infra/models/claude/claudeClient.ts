import Anthropic from '@anthropic-ai/sdk';

/**
 * The official SDK clients Shannon talks to Claude through (Syzygy ADR-0009 stage 1, M3; `docs/haiku-model-cache-contract.md`).
 * One client per credential lane (conversation, FCA, own time, background, skill proposer), each built by its caller with the
 * key that lane's policy selected. Nothing here reads the environment.
 *
 * A pinned client selects the official API origin, `authToken: null`, `webhookKey: null`, `logLevel: off` and `maxRetries: 0`,
 * so ambient SDK settings (bearer token, base URL, log level) never change the credential or the transport. The only retry
 * is the conversation's one bounded transient retry (`claudeTransport.ts`).
 */
export const CLAUDE_API_ORIGIN = 'https://api.anthropic.com';

export interface ClaudeClientOptions {
  apiKey: string;
  /** The SDK's own deadline of one request. */
  timeoutMilliseconds: number;
  /** The client's fetch (tests: recorded responses; the background bridge: its endpoint override). */
  fetch?: typeof fetch;
}

export function claudeClient(options: ClaudeClientOptions): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey, authToken: null, webhookKey: null, baseURL: CLAUDE_API_ORIGIN, logLevel: 'off',
    maxRetries: 0, timeout: options.timeoutMilliseconds, ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/**
 * The Sonnet skill proposer's client exactly as it has been: no SDK retries and its own deadline, but not pinned, so the
 * SDK's ambient settings still apply to it. Kept apart so the stage that may change requests can pin it deliberately.
 */
export function ambientClaudeClient(options: ClaudeClientOptions): Anthropic {
  return new Anthropic({ apiKey: options.apiKey, maxRetries: 0, timeout: options.timeoutMilliseconds, ...(options.fetch ? { fetch: options.fetch } : {}) });
}
