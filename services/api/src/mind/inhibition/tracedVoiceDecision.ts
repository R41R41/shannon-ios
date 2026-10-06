import { countedJevFetch, emptyJevProbe, withJevProbe } from '../../infra/models/jev/jevClient.js';
import { jevUsdPerCall } from '../../infra/models/jev/jevUsage.js';
import type { LlmUsageStore } from '../../llmUsage.js';
import { createConfiguredVoiceDecisionGateway } from '../../voiceDecision.js';
import type { VoiceDecisionGateway, VoiceDecisionInput, VoiceTurnDecision } from '../../voiceDecisionContract.js';
import type { DecisionTraceDraft, DecisionTraceWriter, TraceAnswer } from './decisionTraceContract.js';

/**
 * The voice turn's routing decision, traced (Syzygy ADR-0008 stage 1: 「判断ごとの記録」). Core: approval and budget.
 *
 * `TracedVoiceDecisionGateway` wraps the configured gateway (Jev → luna → the local rules, unchanged) and returns its decision
 * untouched. Beside it, one trace: which decider was configured, whether its answer was used or a fallback decided (and
 * which), how long it took, how many questions and characters of context Jev was given (counted by the Jev client's fetch,
 * `countedJevFetch`), what was decided as closed enums, and Jev's cost when its price is set (`SHANNON_JEV_USD_PER_CALL`;
 * unset, null: 未設定). The transcript, the context and the reply never enter it.
 *
 * With decision traces switched off the configured gateway is returned as it was, with the fetch it had.
 */
export class TracedVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode: VoiceDecisionGateway['mode'];
  readonly model: string;

  constructor(
    private readonly inner: VoiceDecisionGateway,
    private readonly write: DecisionTraceWriter,
    private readonly options: { usdPerJevCall: number | null; now?: () => string; clock?: () => number },
  ) {
    this.mode = inner.mode;
    this.model = inner.model;
  }

  async decide(input: VoiceDecisionInput): Promise<VoiceTurnDecision> {
    const at = (this.options.now ?? (() => new Date().toISOString()))();
    const clock = this.options.clock ?? (() => performance.now());
    const started = clock();
    const probe = emptyJevProbe();
    const decision = await withJevProbe(probe, () => this.inner.decide(input));
    try {
      this.write(input.scopeKey, voiceRouteTrace(this.inner, input, decision, probe, Math.max(0, clock() - started), at, this.options.usdPerJevCall));
    } catch { /* a trace never fails a turn */ }
    return decision;
  }
}

const DECIDER: Readonly<Record<VoiceTurnDecision['source'], DecisionTraceDraft['decider']>> = Object.freeze({ jev: 'jev', openai: 'openai', fallback: 'local' });

export function voiceRouteTrace(
  inner: Pick<VoiceDecisionGateway, 'mode' | 'model'>, input: VoiceDecisionInput, decision: VoiceTurnDecision,
  probe: ReturnType<typeof emptyJevProbe>, latencyMs: number, at: string, usdPerJevCall: number | null,
): DecisionTraceDraft {
  const decider = DECIDER[inner.mode];
  const answered = DECIDER[decision.source];
  const fellBack = answered !== decider;
  // The configured decider's own call failed (Jev's fetch timed out or failed): that is the outcome; else a fallback that
  // decided means its answer could not be used.
  const outcome: DecisionTraceDraft['outcome'] = !fellBack ? 'ok' : probe.outcome === 'timeout' ? 'timeout' : probe.outcome === 'error' ? 'error' : 'fallback';
  const answers: Record<string, TraceAnswer> = {
    respond: decision.shouldRespond, class: decision.conversationClass, latency: decision.latencyClass, affect: decision.affect,
    intensity: decision.affectIntensity, delivery: decision.delivery, skills: [...decision.selectedSkills], reply: decision.replyRequiredProbability,
    ...(decision.silence ? { silence: decision.silence } : {}),
    ...(decision.transcriptReliabilityProbability !== undefined ? { reliable: decision.transcriptReliabilityProbability } : {}),
    ...(decision.roomLookProbability !== undefined ? { look: decision.roomLookProbability } : {}),
    ...(decision.lookSelfProbability !== undefined ? { lookSelf: decision.lookSelfProbability } : {}),
  };
  const jev = decider === 'jev';
  const contextChars = jev ? probe.stateChars : input.transcript.length + (input.context ?? []).reduce((sum, item) => sum + item.content.length, 0);
  return {
    surface: 'voice', decision: 'voice_route', decider, model: inner.model, questions: jev ? probe.questions : null, contextChars,
    latencyMs, outcome, fallbackDecider: fellBack ? answered : null, answers,
    // Jev's cost of this decision: its calls at the configured price; unknown while the price is unset.
    costUsd: !jev ? 0 : usdPerJevCall === null ? null : probe.calls * usdPerJevCall,
    relatedId: null, at,
  };
}

/**
 * The gateway of the voice turn. With a trace writer, the configured one with a counting Jev fetch, wrapped; without one
 * (`SHANNON_DECISION_TRACES=off`), exactly `createConfiguredVoiceDecisionGateway(environment, usageStore)`.
 */
export function configuredVoiceDecision(
  environment: Readonly<Record<string, string | undefined>>, usageStore: LlmUsageStore | undefined, write: DecisionTraceWriter | null,
): VoiceDecisionGateway {
  if (!write) return createConfiguredVoiceDecisionGateway(environment, usageStore);
  const inner = createConfiguredVoiceDecisionGateway(environment, usageStore, countedJevFetch());
  return new TracedVoiceDecisionGateway(inner, write, { usdPerJevCall: jevUsdPerCall(environment) });
}
