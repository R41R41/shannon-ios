import { createHash } from 'node:crypto';
import { AUTONOMY_DEFAULT_MODEL, AUTONOMY_MODELS, autonomyModel, autonomyModelAllowedFor, type AutonomyModel, type AutonomyModelPurpose } from './autonomyModels.js';
import { responseUsage } from './llmUsage.js';

/**
 * The model adapters of Shannon's own activity, behind one interface.
 *
 * The credential comes only from the variables named here, which the owner sets to a
 * dedicated key with a provider-side spending cap. The conversation keys
 * (`OPENAI_API_KEY`, `GEMINI_API_KEY`) are never read as a fallback, and a dedicated
 * variable that merely repeats a conversation key counts as not configured, because the
 * provider-side cap would then not separate her spending from conversation.
 */
export const AUTONOMY_CREDENTIAL_VARIABLES = Object.freeze({
  google: 'SHANNON_AUTONOMY_GEMINI_API_KEY',
  openai: 'SHANNON_AUTONOMY_OPENAI_API_KEY',
} as const);

const CONVERSATION_CREDENTIAL_VARIABLES = Object.freeze({ google: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' } as const);

export type AutonomyModelProvider = AutonomyModel['provider'];

export interface AutonomyTextRequest {
  /** A model id of the autonomy registry. */
  model: string;
  system: string;
  prompt: string;
  maximumOutputTokens: number;
  /**
   * `low`: ask the provider to spend little of the output ceiling on its own reasoning (a planning call, whose reply
   * must fit). The field is sent per provider; one that refuses it is asked again without it, once, and not sent it again.
   */
  reasoning?: 'low';
  signal?: AbortSignal;
}

export interface AutonomyTextResult {
  text: string;
  /**
   * What the provider reported for this call. Output includes the model's own reasoning tokens. `cachedInputTokens`, the
   * part of the input the provider read from its prompt cache, is recorded only (absent when none): every charge still
   * prices the whole input at the full rate.
   */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** The provider stopped at the output ceiling: the text is cut off. Reasoning tokens count against that ceiling. */
  truncated?: true;
}

export interface AutonomyTextModel {
  /** Whether a dedicated credential exists for the provider of this model. */
  canUse(modelId: string): boolean;
  generate(request: AutonomyTextRequest): Promise<AutonomyTextResult>;
}

/** A failure that says nothing about the request or the credential. `usage` is set when the provider had already counted tokens. */
export class AutonomyModelError extends Error {
  constructor(readonly code: string, readonly usage?: AutonomyTextResult['usage']) {
    super(code);
  }
}

interface ProviderOptions {
  /** A fixed line for the service log; never anything of a request or a reply. */
  log?: (line: string) => void;
  apiKey: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
}

const MODEL_ID = /^[A-Za-z0-9._-]{1,100}$/u;

/**
 * Sends a request with the reasoning field when asked to, and once more without it when the provider refuses the
 * request as malformed (400 or 422): that field is the only thing the second request lacks. When the second request is
 * accepted the model is remembered for the life of the process, so the refused request is made once. A refused request
 * generates nothing and costs nothing.
 */
async function sendWithReasoning(
  refused: Set<string>, request: AutonomyTextRequest, provider: string, log: ProviderOptions['log'], send: (reasoning: boolean) => Promise<Response>,
): Promise<Response> {
  const reasoning = request.reasoning === 'low' && !refused.has(request.model);
  const response = await send(reasoning);
  const malformed = (status: number) => status === 400 || status === 422;
  if (!reasoning || !malformed(response.status)) return response;
  // The refusal is not read: it may quote the request.
  try { await response.body?.cancel(); } catch { /* nothing to release */ }
  const second = await send(false);
  // Only when the same request is accepted without the field was the field the cause. A request that is refused either
  // way (too long, say) leaves the field in use.
  if (!malformed(second.status)) {
    refused.add(request.model);
    try { log?.(`Shannon autonomy model: ${provider} ${request.model} refused the reasoning field; sending without it from now on`); } catch { /* the log is optional */ }
  }
  return second;
}

export class GeminiAutonomyTextModel {
  private readonly reasoningRefused = new Set<string>();
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: ProviderOptions) {
    this.endpoint = (options.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/u, '');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000;
  }

  async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    if (!MODEL_ID.test(request.model)) throw new AutonomyModelError('AUTONOMY_MODEL_INVALID');
    const response = await sendWithReasoning(this.reasoningRefused, request, 'google', this.options.log, reasoning => this.fetcher(`${this.endpoint}/${request.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          maxOutputTokens: request.maximumOutputTokens, responseMimeType: 'application/json',
          // Reasoning tokens count against maxOutputTokens: a planning call asks for little of it.
          ...(reasoning ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        },
      }),
      signal: signalFor(request.signal, this.timeoutMilliseconds),
    }));
    const json = await jsonBody(response);
    if (!response.ok) throw new AutonomyModelError(`AUTONOMY_MODEL_HTTP_${response.status}`);
    const metadata = object(object(json)?.usageMetadata);
    // Reasoning tokens are billed as output.
    const inputTokens = count(metadata?.promptTokenCount);
    const cachedInputTokens = Math.min(inputTokens, count(metadata?.cachedContentTokenCount));
    const usage = {
      inputTokens,
      outputTokens: count(metadata?.candidatesTokenCount) + count(metadata?.thoughtsTokenCount),
      ...(cachedInputTokens ? { cachedInputTokens } : {}),
    };
    const candidates = object(json)?.candidates;
    const parts = Array.isArray(candidates) ? object(object(candidates[0])?.content)?.parts : undefined;
    const text = Array.isArray(parts)
      ? parts.map(part => (object(part)?.thought === true ? '' : object(part)?.text)).filter((value): value is string => typeof value === 'string').join('')
      : '';
    const truncated = Array.isArray(candidates) && object(candidates[0])?.finishReason === 'MAX_TOKENS';
    // The whole ceiling went to reasoning: nothing was written, and the call is still charged.
    if (!text.trim()) throw new AutonomyModelError(truncated ? 'AUTONOMY_MODEL_TRUNCATED' : 'AUTONOMY_MODEL_EMPTY', usage);
    return { text, usage, ...(truncated ? { truncated: true as const } : {}) };
  }
}

export class OpenAIAutonomyTextModel {
  private readonly reasoningRefused = new Set<string>();
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: ProviderOptions) {
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 90_000;
  }

  async generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    if (!MODEL_ID.test(request.model)) throw new AutonomyModelError('AUTONOMY_MODEL_INVALID');
    const response = await sendWithReasoning(this.reasoningRefused, request, 'openai', this.options.log, reasoning => this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        instructions: request.system,
        input: request.prompt,
        text: { format: { type: 'json_object' } },
        max_output_tokens: request.maximumOutputTokens,
        // As the conversation's own calls to these models set it (`chatModel.ts`).
        ...(reasoning ? { reasoning: { effort: 'low' } } : {}),
        store: false,
        prompt_cache_key: autonomyPromptCacheKey(request.system),
      }),
      signal: signalFor(request.signal, this.timeoutMilliseconds),
    }));
    const json = await jsonBody(response);
    if (!response.ok) throw new AutonomyModelError(`AUTONOMY_MODEL_HTTP_${response.status}`);
    const reported = responseUsage(json);
    const usage = { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, ...(reported.cachedInputTokens ? { cachedInputTokens: reported.cachedInputTokens } : {}) };
    const text = openAIOutputText(json);
    const truncated = object(json)?.status === 'incomplete' && object(object(json)?.incomplete_details)?.reason === 'max_output_tokens';
    if (!text.trim()) throw new AutonomyModelError(truncated ? 'AUTONOMY_MODEL_TRUNCATED' : 'AUTONOMY_MODEL_EMPTY', usage);
    return { text, usage, ...(truncated ? { truncated: true as const } : {}) };
  }
}

/**
 * The provider's cache routing key of one of her calls. The conversation keys it by scope (`stableScopeIdentifier`); her
 * calls carry no scope, so it is keyed by what makes a prefix shareable, the system text: calls of one kind of step share
 * it and go to the same cache. Only a digest is sent, never the text.
 */
export function autonomyPromptCacheKey(system: string): string {
  return `shannon_autonomy_${createHash('sha256').update(system).digest('hex').slice(0, 32)}`;
}

/** Routes a registry model to the adapter of its provider. A model whose provider has no dedicated credential cannot be used. */
export class AutonomyModelRouter implements AutonomyTextModel {
  constructor(private readonly providers: Partial<Record<AutonomyModelProvider, Pick<AutonomyTextModel, 'generate'>>>) {}

  canUse(modelId: string): boolean {
    const model = autonomyModel(modelId);
    return model !== null && this.providers[model.provider] !== undefined;
  }

  generate(request: AutonomyTextRequest): Promise<AutonomyTextResult> {
    const model = autonomyModel(request.model);
    const provider = model ? this.providers[model.provider] : undefined;
    if (!provider) return Promise.reject(new AutonomyModelError('AUTONOMY_MODEL_NOT_CONFIGURED'));
    return provider.generate(request);
  }

  get configuredProviders(): readonly AutonomyModelProvider[] {
    return (Object.keys(this.providers) as AutonomyModelProvider[]).filter(provider => this.providers[provider] !== undefined).sort();
  }
}

/** The dedicated key of a provider, or null. Never the conversation key, and never a copy of it. */
export function dedicatedAutonomyCredential(
  provider: AutonomyModelProvider,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const key = environment[AUTONOMY_CREDENTIAL_VARIABLES[provider]]?.trim();
  if (!key) return null;
  const conversationKey = environment[CONVERSATION_CREDENTIAL_VARIABLES[provider]]?.trim();
  return conversationKey && conversationKey === key ? null : key;
}

export function configuredAutonomyTextModel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher?: typeof fetch,
  log?: (line: string) => void,
): AutonomyModelRouter {
  const google = dedicatedAutonomyCredential('google', environment);
  const openai = dedicatedAutonomyCredential('openai', environment);
  const timeoutMilliseconds = boundedInteger(environment.SHANNON_AUTONOMY_MODEL_TIMEOUT_MS, 5_000, 180_000, 90_000);
  return new AutonomyModelRouter({
    ...(google ? { google: new GeminiAutonomyTextModel({ apiKey: google, endpoint: environment.SHANNON_AUTONOMY_GEMINI_ENDPOINT?.trim() || undefined, fetcher, timeoutMilliseconds, log }) } : {}),
    ...(openai ? { openai: new OpenAIAutonomyTextModel({ apiKey: openai, endpoint: environment.SHANNON_AUTONOMY_OPENAI_ENDPOINT?.trim() || undefined, fetcher, timeoutMilliseconds, log }) } : {}),
  });
}

/**
 * The model for a purpose: her stored preference, else the default, else any registry
 * model for that purpose whose provider has a dedicated credential. Null when none has.
 */
export function resolveAutonomyModel(
  purpose: AutonomyModelPurpose,
  preferences: readonly { purpose: string; modelId: string }[],
  canUse: (modelId: string) => boolean,
): string | null {
  const preferred = preferences.find(item => item.purpose === purpose && autonomyModelAllowedFor(item.modelId, purpose))?.modelId;
  const candidates = [preferred, AUTONOMY_DEFAULT_MODEL[purpose], ...AUTONOMY_MODELS.filter(model => model.purposes.includes(purpose)).map(model => model.id)];
  return candidates.find((id): id is string => typeof id === 'string' && canUse(id)) ?? null;
}

function signalFor(signal: AbortSignal | undefined, timeoutMilliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMilliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function jsonBody(response: Response): Promise<unknown> {
  try { return JSON.parse(await response.text()) as unknown; } catch { return null; }
}

function openAIOutputText(value: unknown): string {
  const direct = object(value)?.output_text;
  if (typeof direct === 'string') return direct;
  const output = object(value)?.output;
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => {
    const content = object(item)?.content;
    return Array.isArray(content) ? content.map(part => object(part)?.text).filter((text): text is string => typeof text === 'string') : [];
  }).join('');
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
