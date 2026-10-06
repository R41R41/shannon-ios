import { BODY_REACTION_SCHEMA, BODY_REACTION_SCHEMA_WITH_STANCE, parsedBodyReaction, type BodyReactionDecision } from './bodyReactionPrompt.js';
import { extractOutputText, parseJson, stableScopeIdentifier, validModel } from '../../infra/models/chatModelSupport.js';
import { estimatedOpenAICostUsd, responseUsage, type LlmUsageEvent } from '../../infra/models/llmUsage.js';

/**
 * Deciding and speaking, fast: the one model call of a reaction. It uses the provider, the
 * model and the settings of the spoken reply (`OpenAIResponsesChatModel.generateVoice`: no
 * reasoning effort, low verbosity, nothing stored at the provider) with a small prompt and a
 * small structured answer. It is the owner acting on her, so its tokens are recorded in the
 * conversation's `chat` lane, like a voice reply, and never against her own day's budget.
 */
export interface BodyReactionSpeakRequest {
  scopeKey: string;
  prompt: string;
  /** Aborted when the answer is given up at the deadline. */
  signal: AbortSignal;
  /** True for a touch that names its part: she is also asked how she took it (`stance`). Absent: the answer of before. */
  stance?: boolean;
}

export interface BodyReactionSpeaker {
  /** Her decision. Throws when the provider gives nothing usable; the caller then stays quiet. */
  decide(request: BodyReactionSpeakRequest): Promise<BodyReactionDecision>;
}

export interface OpenAIBodyReactionSpeakerOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  usageStore?: { recordLlmUsage(event: LlmUsageEvent): void };
  now?: () => string;
}

export class OpenAIBodyReactionSpeaker implements BodyReactionSpeaker {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIBodyReactionSpeakerOptions) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.model = validModel(options.model ?? 'gpt-5.6-luna');
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.fetcher = options.fetcher ?? fetch;
  }

  async decide(request: BodyReactionSpeakRequest): Promise<BodyReactionDecision> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          instructions: request.prompt,
          input: [{ role: 'user', content: 'いま、体に触れられました。' }],
          reasoning: { effort: 'none' },
          text: { verbosity: 'low', format: { type: 'json_schema', name: 'shannon_body_reaction', strict: true, schema: request.stance ? BODY_REACTION_SCHEMA_WITH_STANCE : BODY_REACTION_SCHEMA } },
          max_output_tokens: 160,
          store: false,
          prompt_cache_key: stableScopeIdentifier(request.scopeKey),
          safety_identifier: stableScopeIdentifier(request.scopeKey),
        }),
        signal: request.signal,
      });
    } catch {
      throw new Error('BODY_REACTION_UPSTREAM_FAILED');
    }
    const json = parseJson(await response.text());
    if (!response.ok) throw new Error(`BODY_REACTION_UPSTREAM_${response.status}`);
    const usage = responseUsage(json);
    this.options.usageStore?.recordLlmUsage({
      scopeKey: request.scopeKey, lane: 'chat', model: this.model, ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage),
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
    });
    const decision = parsedBodyReaction(parseJson(extractOutputText(json)));
    if (!decision) throw new Error('BODY_REACTION_EMPTY');
    return decision;
  }
}

/** Uses the conversation model and its key. Without a key she feels and remembers a touch and stays quiet. */
export function createConfiguredBodyReactionSpeaker(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  usageStore?: OpenAIBodyReactionSpeakerOptions['usageStore'],
): BodyReactionSpeaker | null {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  return new OpenAIBodyReactionSpeaker({ apiKey, model: environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna', usageStore });
}
