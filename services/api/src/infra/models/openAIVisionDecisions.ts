/**
 * The Decisions call of the vision pathway (Syzygy ADR-0011 §4.1 and §4.3): one `POST /v1/decisions` that asks, in one request,
 * a `predicate` (does this frame call for a response?) and a `choice` among closed candidate ids. Decisions makes no sentence;
 * it picks an id. No Responses fallback, no automatic retry, and the frame is passed as a data URL in memory only.
 *
 * Wire shape (official guide, 2026-10-13, confirmed by the synthetic measurement of 2026-10-14): questions
 * `{ type: 'predicate', name, instructions }` and `{ type: 'choice', name, instructions, choices: [{ value, description }] }`;
 * answers `{ type: 'predicate', name, probability }` and `{ type: 'choice', name, choice, probabilities: [{ value, probability }],
 * confidence }`, or `{ type: 'refusal', name }`; usage `{ input_tokens, input_tokens_details, output_tokens, total_tokens }`.
 */
export const VISION_DECISIONS_MODEL = 'gpt-6-luna';
export const VISION_DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions';
/** The official price (input only; no output or cache fee). */
export const VISION_DECISIONS_USD_PER_MILLION_INPUT = 0.10;

export interface VisionDecisionsImage { mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array }
export interface VisionDecisionsRequest {
  /** Closed text only: the source, the time, what was decided recently. Never words read from a picture. */
  context: string;
  image: VisionDecisionsImage | null;
  predicate: { name: string; instructions: string };
  choice: { name: string; instructions: string; candidates: readonly { id: string; description: string }[] };
  signal: AbortSignal;
}
export interface VisionDecisionsUsage {
  usageComplete: boolean;
  inputTokens: number;
  estimatedCostUsd: number;
}
export interface VisionDecisionsAnswer {
  predicate: number | null;
  choice: { id: string; confidence: number; probabilities: readonly { id: string; probability: number }[] } | null;
  refused: boolean;
  usage: VisionDecisionsUsage;
  elapsedMs: number;
}
export interface VisionDecisionsClient {
  decide(request: VisionDecisionsRequest): Promise<VisionDecisionsAnswer>;
}
export interface OpenAIVisionDecisionsOptions {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMilliseconds?: number;
  now?: () => number;
  /** The cost a call is charged when its usage is not known (never zero). */
  unknownCostUpperBoundUsd: number;
}

/** A failed call. `usage` is what is known of the spend; a call that may have been charged keeps its reservation. */
export class VisionDecisionsError extends Error {
  constructor(readonly code: 'timeout' | 'http_error' | 'usage_unknown' | 'invalid_answer' | 'network', readonly usage: VisionDecisionsUsage | null) {
    super(`VISION_DECISIONS_${code.toUpperCase()}`);
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** The usage of a reply: complete only when every count is present and adds up. */
export function visionDecisionsUsage(value: unknown, unknownCostUpperBoundUsd: number): VisionDecisionsUsage {
  const response = record(value);
  const usage = record(response?.usage);
  const details = record(usage?.input_tokens_details);
  const input = count(usage?.input_tokens) ? usage.input_tokens : 0;
  const output = count(usage?.output_tokens) ? usage.output_tokens : -1;
  const complete = response?.model === VISION_DECISIONS_MODEL && count(usage?.input_tokens) && output >= 0 && count(usage?.total_tokens)
    && usage.total_tokens === input + output && (details === null || count(details.cached_tokens));
  const estimate = input * VISION_DECISIONS_USD_PER_MILLION_INPUT / 1_000_000;
  return { usageComplete: complete, inputTokens: input, estimatedCostUsd: complete ? estimate : Math.max(estimate, unknownCostUpperBoundUsd) };
}

function dataUrl(image: VisionDecisionsImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

/** The request body. Exported for the test that pins the wire shape. */
export function visionDecisionsBody(request: Omit<VisionDecisionsRequest, 'signal'>): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: request.context }];
  if (request.image) content.push({ type: 'input_image', image_url: dataUrl(request.image), detail: 'low' });
  return {
    model: VISION_DECISIONS_MODEL,
    input: [{ role: 'user', content }],
    questions: [
      { type: 'predicate', name: request.predicate.name, instructions: request.predicate.instructions },
      { type: 'choice', name: request.choice.name, instructions: request.choice.instructions,
        choices: request.choice.candidates.map(candidate => ({ value: candidate.id, description: candidate.description })) },
    ],
  };
}

function parsedChoice(answer: Record<string, unknown>, ids: ReadonlySet<string>): VisionDecisionsAnswer['choice'] {
  if (typeof answer.choice !== 'string' || !ids.has(answer.choice) || !unit(answer.confidence) || !Array.isArray(answer.probabilities)) {
    throw new VisionDecisionsError('invalid_answer', null);
  }
  const probabilities = answer.probabilities.map(item => {
    const entry = record(item);
    if (!entry || typeof entry.value !== 'string' || !ids.has(entry.value) || !unit(entry.probability)) throw new VisionDecisionsError('invalid_answer', null);
    return { id: entry.value, probability: entry.probability };
  });
  return { id: answer.choice, confidence: answer.confidence, probabilities };
}

/** Reads the two answers. A refusal of either question is a refusal; anything outside the closed shape is invalid. */
export function parsedVisionAnswers(value: unknown, request: Pick<VisionDecisionsRequest, 'predicate' | 'choice'>):
  Pick<VisionDecisionsAnswer, 'predicate' | 'choice' | 'refused'> {
  const answers = record(value)?.answers;
  if (!Array.isArray(answers) || answers.length !== 2) throw new VisionDecisionsError('invalid_answer', null);
  const byName = new Map(answers.map(item => [record(item)?.name, record(item)] as const));
  const predicate = byName.get(request.predicate.name);
  const choice = byName.get(request.choice.name);
  if (!predicate || !choice) throw new VisionDecisionsError('invalid_answer', null);
  if (predicate.type === 'refusal' || choice.type === 'refusal') return { predicate: null, choice: null, refused: true };
  if (predicate.type !== 'predicate' || !unit(predicate.probability) || choice.type !== 'choice') throw new VisionDecisionsError('invalid_answer', null);
  const ids = new Set(request.choice.candidates.map(candidate => candidate.id));
  return { predicate: predicate.probability, choice: parsedChoice(choice, ids), refused: false };
}

export class OpenAIVisionDecisions implements VisionDecisionsClient {
  private readonly now: () => number;
  constructor(private readonly options: OpenAIVisionDecisionsOptions) {
    const timeout = options.timeoutMilliseconds;
    if (!options.apiKey.trim() || !Number.isFinite(options.unknownCostUpperBoundUsd) || options.unknownCostUpperBoundUsd <= 0
      || (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0))) throw new Error('VISION_DECISIONS_CONFIG_INVALID');
    this.now = options.now ?? Date.now;
  }

  async decide(request: VisionDecisionsRequest): Promise<VisionDecisionsAnswer> {
    const started = this.now();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.options.timeoutMilliseconds ?? 2_500)]);
    const unknown = visionDecisionsUsage(null, this.options.unknownCostUpperBoundUsd);
    let status = 0;
    let value: unknown = null;
    try {
      const response = await (this.options.fetcher ?? fetch)(VISION_DECISIONS_ENDPOINT, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(visionDecisionsBody(request)), signal,
      });
      status = response.status;
      value = await response.json() as unknown;
    } catch {
      throw new VisionDecisionsError(signal.aborted ? 'timeout' : 'network', unknown);
    }
    const usage = visionDecisionsUsage(value, this.options.unknownCostUpperBoundUsd);
    if (status < 200 || status >= 300) throw new VisionDecisionsError('http_error', status >= 500 || status === 0 ? unknown : usage);
    if (!usage.usageComplete) throw new VisionDecisionsError('usage_unknown', usage);
    try {
      return { ...parsedVisionAnswers(value, request), usage, elapsedMs: this.now() - started };
    } catch (error) {
      if (error instanceof VisionDecisionsError) throw new VisionDecisionsError(error.code, usage);
      throw error;
    }
  }
}
