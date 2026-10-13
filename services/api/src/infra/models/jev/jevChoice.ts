import { observeAsync } from '../../observer/observerContext.js';
import { createHash, randomBytes } from 'node:crypto';
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
 *
 * ADR-0008 §14 (after Canny and JevBystander):
 * - **Fixed question sets.** Every question set has a version id and a language (`JEV_QUESTION_SETS`); a change of any wording is
 *   a new version. Each trace records the sets asked (`qv`), their language (`ql`), a digest of the exact questions (`qh`) and
 *   of the whole input (`h`: model, state, questions), salted with the install's secret (kept on the server, never in the
 *   repository; a per-process one without it), so the digest of a turn's words cannot be matched against guesses.
 * - **Replayable.** Each trace also records Jev's raw answers, one per question (`a.<key>`: the probability, or the chosen key),
 *   so `replayedAnswers` gives back what the selector parsed and every decision can be recomputed from the traces alone.
 * - **Cached by content.** The same input within `JEV_CACHE_MILLISECONDS` is answered from the last usable answer, without a call
 *   (traced with `cached: true` and no cost): Jev drifts about 0.05 between runs, and a repeated turn gets the same decision.
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
/**
 * A timeout that fires late because the API's one thread was busy is not Jev's: its answer may already be waiting to be read, and
 * the timer would win against it (timers run before the reads). Then the call gets this much more time, once (2026-10-13: both
 * Jev calls of a voice turn "timed out" together at 1.2 s and 1.4 s while Jev itself answered in 0.2-0.4 s).
 */
export const JEV_STALL_GRACE_MILLISECONDS = 200;
/** How late the timer must fire to count as the thread having been busy, not as Jev being slow. */
export const JEV_STALL_LATE_MILLISECONDS = 100;

/** `AbortSignal.timeout`, except that a timer fired late (the thread was blocked) first gives the call one short grace. */
export function stallTolerantTimeout(milliseconds: number, now: () => number = () => performance.now()): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController(), started = now();
  let graced = false;
  const fire = () => {
    if (!graced && now() - started - milliseconds >= JEV_STALL_LATE_MILLISECONDS) {
      graced = true;
      timer = setTimeout(fire, JEV_STALL_GRACE_MILLISECONDS);
      timer.unref?.();
      return;
    }
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  };
  let timer = setTimeout(fire, milliseconds);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
/** How long a usable answer stands for the same input (model, state, questions), and how many inputs are kept. */
export const JEV_CACHE_MILLISECONDS = 60_000;
export const JEV_CACHE_ENTRIES = 128;

/**
 * The fixed question sets (ADR-0008 §14): `<name>.v<version>`, all in English. Bump the version whenever any wording of the
 * set changes (instructions, criteria, the menu's wording around its entries); the entries of a menu are data, digested in `qh`.
 */
export const JEV_QUESTION_SETS = Object.freeze({
  voiceRoute: 'voice_route.v1',
  /** The voice route that also asks about the weather (`routerSkills`, 2026-10-13 daily evals E2/E3). */
  voiceRouteWeather: 'voice_route.v2',
  /** Syzygy ADR-0012: the voice route that also reads `shannon_inner` and chooses her performance from it (either set above, plus that). */
  voiceRouteInner: 'voice_route.v3',
  toolMenu: 'tool_menu.v2',
  fcaToolMenu: 'fca_tool_menu.v1',
  reflexEntry: 'reflex_entry.v1',
  reflexAction: 'reflex_action.v1',
  fcaTouchReflex: 'fca_touch_reflex.v1',
  difficulty: 'difficulty.v1',
  retry: 'retry_or_correction.v1',
  recallBeam: 'recall_beam.v1',
} as const);
export type JevQuestionSetId = typeof JEV_QUESTION_SETS[keyof typeof JEV_QUESTION_SETS];
export const JEV_QUESTION_LANGUAGE = 'en';

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
  async ask(state: unknown, questions: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const timeout = stallTolerantTimeout(this.timeoutMilliseconds);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    return observeAsync('llm', { provider: 'jev', questionCount: Object.keys(questions).length }, async () => {
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
      signal: requestSignal,
    });
    const body = await response.json() as unknown;
    if (signal) requestSignal.throwIfAborted();
    if (!response.ok) throw new Error(`JEV_RESPONSE_${response.status}`);
    return body;
    }, () => ({ provider: 'jev', answered: true }), { model: this.model }).finally(() => timeout.clear());
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

/** A short closed digest (`<prefix><16 hex>`), a valid trace symbol. */
export function jevDigest(prefix: 'q' | 'h', value: unknown): string {
  return `${prefix}${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

const RAW_KEY = /^[A-Za-z0-9_.:-]{1,90}$/u;
const RAW_SYMBOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;

/**
 * Jev's raw answers as trace answers (`a.<key>`): a `noul` as its probability, a `choice` as its key when it is one of the
 * question's criteria; `invalid` otherwise. Keys that are not closed symbols are left out (none of the stage-2 sets has one).
 */
export function rawTraceAnswers(answers: Readonly<Record<string, unknown>>, questions: Readonly<Record<string, JevQuestion>>): Record<string, string | number> {
  const raw: Record<string, string | number> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (!RAW_KEY.test(key)) continue;
    const value = answers[key];
    const field = value && typeof value === 'object' ? (value as Record<string, unknown>)[question.type] : undefined;
    if (question.type === 'noul') raw[`a.${key}`] = typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= 1 ? field : 'invalid';
    else raw[`a.${key}`] = typeof field === 'string' && Object.hasOwn(question.criteria, field) && RAW_SYMBOL.test(field) ? field : 'invalid';
  }
  return raw;
}

/** The answers as Jev sent them, rebuilt from a trace's raw answers: `parse(replayedAnswers(trace.answers))` replays a decision. */
export function replayedAnswers(trace: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(trace)) {
    if (!name.startsWith('a.') || value === 'invalid') continue;
    answers[name.slice(2)] = typeof value === 'number' ? { type: 'noul', noul: value } : { type: 'choice', choice: value };
  }
  return answers;
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
  private readonly cache = new Map<string, { body: unknown; at: number; contextChars: number | null; questions: number | null }>();

  constructor(
    private readonly client: Pick<JevChoiceClient, 'ask' | 'model'>,
    private readonly options: {
      /** Writes one trace (stage 1's writer, bound to a scope); absent while decision traces are off. */
      trace?: (scopeKey: string, trace: JevChoiceTrace) => void;
      usdPerCall: number | null;
      now?: () => string;
      clock?: () => number;
      /** How long a usable answer stands for the same input; 0: no cache. */
      cacheMilliseconds?: number;
      /** The install's secret salt of `h` (`wiring/installSalt.ts`); absent, one for this process. */
      salt?: string;
    },
  ) {
    this.salt = options.salt ?? randomBytes(16).toString('hex');
  }

  private readonly salt: string;

  get model(): string { return this.client.model; }

  async decide<T>(request: {
    scopeKey: string;
    surface: 'text' | 'voice';
    decision: JevChoiceTrace['decision'];
    /** The fixed question sets asked (ADR-0008 §14), in the order their questions are merged. */
    sets: readonly JevQuestionSetId[];
    state: unknown;
    questions: Readonly<Record<string, JevQuestion>>;
    parse: (answers: Readonly<Record<string, unknown>>) => T;
    fallback: () => T;
    traceAnswers: (value: T, source: JevDecision<T>['source']) => JevChoiceTrace['answers'];
    /** Observation only; never changes the decision or the cognition trace. */
    observe?: (metadata: { cached: boolean; model: string; source: JevDecision<T>['source'] }) => void;
    /** Optional cancellation for a short body-control session; legacy callers retain their existing request. */
    signal?: AbortSignal;
  }): Promise<JevDecision<T>> {
    const at = (this.options.now ?? (() => new Date().toISOString()))();
    const clock = this.options.clock ?? (() => performance.now());
    const started = clock();
    const probe: JevCallProbe = emptyJevProbe();
    const input = jevDigest('h', { salt: this.salt, model: this.client.model, state: request.state, questions: request.questions });
    const key = `${request.scopeKey}\u0000${input}`;
    const ttl = this.options.cacheMilliseconds ?? JEV_CACHE_MILLISECONDS;
    const hit = ttl > 0 ? this.cache.get(key) : undefined;
    const cached = hit !== undefined && started - hit.at < ttl;
    let decided: JevDecision<T>;
    let raw: Record<string, string | number> = {};
    try {
      const body = cached ? hit.body : await withJevProbe(probe, () => request.signal
        ? this.client.ask(request.state, request.questions, request.signal) : this.client.ask(request.state, request.questions));
      request.signal?.throwIfAborted();
      const answers = jevAnswers(body);
      raw = rawTraceAnswers(answers, request.questions);
      decided = { value: request.parse(answers), source: 'jev' };
      if (!cached && ttl > 0) this.remember(key, { body, at: started, contextChars: probe.stateChars, questions: probe.questions });
    } catch {
      decided = { value: request.fallback(), source: 'fallback' };
    }
    try {
      this.options.trace?.(request.scopeKey, {
        surface: request.surface, decision: request.decision,
        answers: {
          ...request.traceAnswers(decided.value, decided.source),
          qv: [...request.sets], ql: JEV_QUESTION_LANGUAGE, qh: jevDigest('q', request.questions), h: input, cached, ...raw,
        },
        // Jev's own call failed (timeout or error): that is the outcome; an answer that could not be used is a fallback.
        outcome: decided.source === 'jev' ? 'ok' : probe.outcome === 'timeout' ? 'timeout' : probe.outcome === 'error' ? 'error' : 'fallback',
        model: this.client.model, questions: (cached ? hit.questions : probe.questions) ?? Object.keys(request.questions).length,
        contextChars: cached ? hit.contextChars : probe.stateChars,
        latencyMs: Math.max(0, clock() - started),
        // A cached answer made no call and cost nothing.
        costUsd: this.options.usdPerCall === null ? null : cached ? 0 : Math.max(1, probe.calls) * this.options.usdPerCall, at,
      });
    } catch { /* a trace never fails a turn */ }
    try { request.observe?.({ cached, model: this.client.model, source: decided.source }); } catch { /* observation never fails a turn */ }
    return decided;
  }

  private remember(key: string, entry: { body: unknown; at: number; contextChars: number | null; questions: number | null }): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > JEV_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
}
