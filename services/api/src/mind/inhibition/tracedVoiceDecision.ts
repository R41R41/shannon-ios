import { emptyJevProbe, withJevProbe } from '../../infra/models/jev/jevClient.js';
import { JEV_QUESTION_SETS } from '../../infra/models/jev/jevChoice.js';
import type { VoiceDecisionGateway, VoiceDecisionInput, VoiceTurnDecision } from '../../contracts/voiceDecisionContract.js';
import type { DecisionTraceDraft, DecisionTraceWriter, TraceAnswer } from '../../contracts/decisionTraceContract.js';

/**
 * The voice turn's routing decision, traced (Syzygy ADR-0008 stage 1: 「判断ごとの記録」). Core: approval and budget.
 *
 * `TracedVoiceDecisionGateway` wraps the configured gateway (Jev → the configured small model → the local rules) and returns its decision
 * untouched. Beside it, one trace: which decider was configured, whether its answer was used or a fallback decided (and
 * which), how long it took, how many questions and characters of context Jev was given (counted by the Jev client's fetch,
 * `countedJevFetch`), what was decided as closed enums, and Jev's cost when its price is set (`SHANNON_JEV_USD_PER_CALL`;
 * unset, null: 未設定). The transcript, the context and the reply never enter it.
 *
 * With decision traces switched off the configured gateway is used as it was, with the fetch it had (`wiring/cognitionLedgerWiring.ts`).
 * With stage 2 on (ADR-0008 §14) the trace also names the router's fixed question set and its language (`qv`, `ql`).
 */
export class TracedVoiceDecisionGateway implements VoiceDecisionGateway {
  readonly mode: VoiceDecisionGateway['mode'];
  readonly model: string;

  constructor(
    private readonly inner: VoiceDecisionGateway,
    private readonly write: DecisionTraceWriter,
    private readonly options: { usdPerJevCall: number | null; now?: () => string; clock?: () => number;
      /** Stage 2 (ADR-0008 §14): the router's question set and language, recorded in each trace; absent, the trace is stage 1's. */
      questionSet?: { id: string; language: string } },
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
      const trace = voiceRouteTrace(this.inner, input, decision, probe, Math.max(0, clock() - started), at, this.options.usdPerJevCall);
      const set = this.options.questionSet;
      // Syzygy ADR-0012: a turn that gave Jev her inner line asked `voice_route.v3`.
      // Syzygy ADR-0013: a turn that also asked the feeling turn asked `voice_route.v4`.
      const id = set && input.shannonFeeling ? JEV_QUESTION_SETS.voiceRouteFeeling : set && input.shannonInner ? JEV_QUESTION_SETS.voiceRouteInner : set?.id;
      this.write(input.scopeKey, set ? { ...trace, answers: { ...trace.answers, qv: [id!], ql: set.language } } : trace);
    } catch { /* a trace never fails a turn */ }
    return decision;
  }
}

const DECIDER: Readonly<Record<VoiceTurnDecision['source'], DecisionTraceDraft['decider']>> = Object.freeze({ jev: 'jev', openai: 'openai', anthropic: 'anthropic', fallback: 'local' });

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
    ...(decision.feeling ? { feelingStance: decision.feeling.stance, feelingIntensity: decision.feeling.intensity, feelingDrawer: decision.feeling.drawer,
      feelingRegister: decision.feeling.register } : {}),
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
