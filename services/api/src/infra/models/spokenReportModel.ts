import { shannonPersonaPrompt } from '@shannon/cognition';
import { DEFAULT_HAIKU_MODEL } from './anthropic/haikuConfig.js';
import { anthropicApiKey } from './anthropic/anthropicConfig.js';
import { responseModelFetcher, validateResponseModelUsage } from './anthropic/haikuResponses.js';
import { extractOutputText, parseJson, stableScopeIdentifier, validModel } from './chatModelSupport.js';
import { estimatedOpenAICostUsd, responseUsage, type LlmUsageEvent } from './llmUsage.js';
import { SPOKEN_REPORT_INSTRUCTIONS, spokenReportInput, type SpokenReportRequest, type SpokenReportSpeaker } from '../../mind/action/fca/fcaSpokenReport.js';

export interface SpokenReportModelOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  usageStore?: { recordLlmUsage(event: LlmUsageEvent): void };
}

/**
 * The short spoken form of a report the owner asked for: one small Haiku call with her persona and the delivery rules.
 * It is work he asked for, so its tokens are the conversation's `chat` lane, never her own day's budget.
 */
export class SpokenReportModel implements SpokenReportSpeaker {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: SpokenReportModelOptions) {
    if (!options.apiKey.trim()) throw new Error('SPOKEN_REPORT_API_KEY_REQUIRED');
    this.model = validModel(options.model ?? DEFAULT_HAIKU_MODEL);
    this.endpoint = options.endpoint ?? 'https://api.openai.com/v1/responses';
    this.fetcher = responseModelFetcher({ ...options, model: this.model });
  }

  async speak(request: SpokenReportRequest): Promise<string> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(this.body(request)),
      signal: request.signal,
    });
    const json = parseJson(await response.text());
    if (!response.ok) throw new Error(`SPOKEN_REPORT_UPSTREAM_${response.status}`);
    this.record(request.scopeKey, json);
    validateResponseModelUsage(this.model, json);
    return extractOutputText(json);
  }

  private body(request: SpokenReportRequest) {
    return {
      model: this.model,
      instructions: `${shannonPersonaPrompt('owner')}\n\n${SPOKEN_REPORT_INSTRUCTIONS}`,
      input: [{ role: 'user', content: spokenReportInput(request) }],
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      max_output_tokens: 200,
      store: false,
      prompt_cache_key: stableScopeIdentifier(request.scopeKey),
      safety_identifier: stableScopeIdentifier(request.scopeKey),
    };
  }

  private record(scopeKey: string, json: unknown): void {
    const usage = responseUsage(json);
    this.options.usageStore?.recordLlmUsage({ scopeKey, lane: 'chat', model: this.model, ...usage,
      estimatedCostUsd: estimatedOpenAICostUsd(this.model, usage), occurredAt: new Date().toISOString() });
  }
}

/** The regular Haiku credential (its existing shared-key fallback). Without one, a report's plain first sentences are spoken. */
export function createConfiguredSpokenReportModel(environment: Readonly<Record<string, string | undefined>>,
  usageStore?: SpokenReportModelOptions['usageStore']): SpokenReportSpeaker | null {
  const apiKey = environment.SHANNON_HAIKU_API_KEY?.trim() || anthropicApiKey(environment);
  return apiKey ? new SpokenReportModel({ apiKey, model: DEFAULT_HAIKU_MODEL, usageStore }) : null;
}
