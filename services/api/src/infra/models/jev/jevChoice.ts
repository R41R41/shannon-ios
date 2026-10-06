import { emptyJevProbe, withJevProbe, type JevCallProbe } from './jevClient.js';

/**
 * The one Jev client (Syzygy ADR-0008 stage 2, `docs/skill-and-routing-contract.md`: 「Jev の使い方」). Core: response path.
 *
 * Jev answers a set of questions about a state: `noul` (a probability) and `choice` (one key of a closed menu, which always
 * includes a way to say none). The voice router (`JevVoiceDecisionGateway`, `voiceDecision.ts`) asks through `ask`, with the
 * bytes, headers, timeout and order of reading it always had; the stage-2 selectors (the tool menu, difficulty) ask through
 * `JevChooser`, which adds what the voice gateway has around its call:
 * - the same timeout (900 ms unless configured) and a fallback that decides instead when Jev times out, fails or answers
 *   something that cannot be used (the caller's `fallback`, never an exception);
 * - one content-free decision trace per call (stage 1's `shannon_decision_traces`), with the Jev call counted by the probe of
 *   `countedJevFetch` (`jevClient.ts`), its outcome, its size and its cost when the price is set. Never the words of the state.
 */
export interface JevQuestion {
  type: 'noul' | 'choice';
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}

export interface JevChoiceOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
}

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_DEFAULT_TIMEOUT_MILLISECONDS = 900;

export class JevChoiceClient {
  readonly model: string;
  readonly timeoutMilliseconds: number;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: JevChoiceOptions) {
    if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required');
    this.endpoint = options.endpoint ?? JEV_DEFAULT_ENDPOINT;
    this.model = options.model ?? JEV_DEFAULT_MODEL;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? JEV_DEFAULT_TIMEOUT_MILLISECONDS;
    // Read at construction, as the voice gateway always did.
    this.fetcher = options.fetcher ?? fetch;
  }

  /**
   * One call: the response body as Jev sent it. Throws on a timeout, a failure, or a status that is not ok (after the body is
   * read, in that order, as the voice gateway always did).
   */
  async ask(state: unknown, questions: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        state,
        questions,
      }),
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error(`JEV_RESPONSE_${response.status}`);
    return body;
  }
}

/** The answers of a Jev response, or an error when it has none. */
export function jevAnswers(body: unknown): Readonly<Record<string, unknown>> {
  const answers = body && typeof body === 'object' && !Array.isArray(body) ? (body as { answers?: unknown }).answers : undefined;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('JEV_RESPONSE_INVALID');
  return answers as Record<string, unknown>;
}

/** A `noul` answer: a probability in [0, 1]. */
export function jevNoul(answers: Readonly<Record<string, unknown>>, key: string): number {
  const value = answers[key];
  const probability = value && typeof value === 'object' ? (value as { noul?: unknown }).noul : undefined;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('JEV_RESPONSE_INVALID');
  return probability;
}

/** A `choice` answer: one of the allowed keys. */
export function jevChoice<const T extends readonly string[]>(answers: Readonly<Record<string, unknown>>, key: string, allowed: T): T[number] {
  const value = answers[key];
  const choice = value && typeof value === 'object' ? (value as { choice?: unknown }).choice : undefined;
  if (typeof choice !== 'string' || !allowed.includes(choice)) throw new Error('JEV_RESPONSE_INVALID');
  return choice as T[number];
}

/** What one stage-2 decision writes to the decision traces (`contracts/decisionTraceContract.ts`), as closed values. */
export interface JevChoiceTrace {
  surface: 'text' | 'voice';
  decision: 'tool_menu' | 'difficulty' | 'recall_beam';
  answers: Readonly<Record<string, string | boolean | number | readonly string[]>>;
  outcome: 'ok' | 'timeout' | 'error' | 'fallback';
  model: string;
  questions: number | null;
  contextChars: number | null;
  latencyMs: number;
  costUsd: number | null;
  at: string;
}

export interface JevDecision<T> {
  value: T;
  /** `jev`: Jev's answer was used; `fallback`: the caller's fallback decided. */
  source: 'jev' | 'fallback';
}

/**
 * The stage-2 selectors' way to Jev: one call, its answers parsed by the caller, the fallback on any failure, one trace.
 * Never throws. Each decision is one Jev call and one trace, so the usage summary counts calls from the traces as stage 1 does.
 */
export class JevChooser {
  constructor(
    private readonly client: Pick<JevChoiceClient, 'ask' | 'model'>,
    private readonly options: {
      /** Writes one trace (stage 1's writer, bound to a scope); absent while decision traces are off. */
      trace?: (scopeKey: string, trace: JevChoiceTrace) => void;
      usdPerCall: number | null;
      now?: () => string;
      clock?: () => number;
    },
  ) {}

  get model(): string { return this.client.model; }

  async decide<T>(request: {
    scopeKey: string;
    surface: 'text' | 'voice';
    decision: JevChoiceTrace['decision'];
    state: unknown;
    questions: Readonly<Record<string, JevQuestion>>;
    parse: (answers: Readonly<Record<string, unknown>>) => T;
    fallback: () => T;
    traceAnswers: (value: T, source: JevDecision<T>['source']) => JevChoiceTrace['answers'];
  }): Promise<JevDecision<T>> {
    const at = (this.options.now ?? (() => new Date().toISOString()))();
    const clock = this.options.clock ?? (() => performance.now());
    const started = clock();
    const probe: JevCallProbe = emptyJevProbe();
    let decided: JevDecision<T>;
    try {
      const body = await withJevProbe(probe, () => this.client.ask(request.state, request.questions));
      decided = { value: request.parse(jevAnswers(body)), source: 'jev' };
    } catch {
      decided = { value: request.fallback(), source: 'fallback' };
    }
    try {
      this.options.trace?.(request.scopeKey, {
        surface: request.surface, decision: request.decision, answers: request.traceAnswers(decided.value, decided.source),
        // Jev's own call failed (timeout or error): that is the outcome; an answer that could not be used is a fallback.
        outcome: decided.source === 'jev' ? 'ok' : probe.outcome === 'timeout' ? 'timeout' : probe.outcome === 'error' ? 'error' : 'fallback',
        model: this.client.model, questions: probe.questions ?? Object.keys(request.questions).length, contextChars: probe.stateChars,
        latencyMs: Math.max(0, clock() - started),
        costUsd: this.options.usdPerCall === null ? null : Math.max(1, probe.calls) * this.options.usdPerCall, at,
      });
    } catch { /* a trace never fails a turn */ }
    return decided;
  }
}
