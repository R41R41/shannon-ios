import { randomUUID } from 'node:crypto';
import {
  OWNER_AUDIENCE, holdsFeelingThroughTouch, presentShannonFeeling, presentShannonMood, touchCause, touchFeeling, touchImpact, touchTarget,
  type CompanionStateSnapshot, type CompanionStateStore,
} from '@shannon/cognition';
import { emotionTiming, resolveReplyEmotion } from './companionPresence.js';
import { BODY_LIMITS, isImpossibleTouch } from './contracts/bodyContract.js';
import {
  BODY_REACTION_LIMITS, bodyReactionContentHash, validBodyReactionId,
  type BodyReactionAnswer, type BodyReactionConfig, type BodyReactionRequest,
} from './contracts/bodyReactionContract.js';
import type { BodyReactionSpeaker } from './bodyReactionModel.js';
import { BODY_TOUCH_PHRASES, asksStance, bodyReactionPrompt, boundedReactionText, type BodyReactionDecision } from './bodyReactionPrompt.js';
import { reflexPartWord } from './bodyTouchReflex.js';
import { bodyTouchPartWord, bodyTouchRegionWord, touchDetailPhrase, type BodySurface } from './bodyTouchWords.js';
import type { ReactionLine, SQLiteBodyReactionStore } from './bodyReactionStore.js';
import type { BodyTouches, FeltTouch } from './bodyTouch.js';
import type { ConversationStore } from './conversationStore.js';
import { visibleReplayMessages } from './memoryVisibility.js';

/**
 * When she is touched: the reflex from a touch to her answer (Syzygy ADR-0003, reflex layer).
 *
 * - Feeling and memory: every accepted request is one touch through `BodyTouches`, whether
 *   or not she speaks, exactly as a plain body event is.
 * - Deciding and speaking: one small model call. She may stay silent. The deadline runs from
 *   the moment the request is taken up: when it passes, the model is given up and she is
 *   quiet, and a model that answers later changes nothing.
 * - Conversation only if he answers: her line waits outside the conversation history. A
 *   voice turn that names the reaction receives it as the preceding message; without one
 *   it is dropped and remains only in the memory of the touch.
 *
 * Nothing here runs the turn pipeline, waits in a transaction, or holds a lock while the
 * model is called.
 */
export interface BodyReactionDependencies {
  store: SQLiteBodyReactionStore;
  touches: BodyTouches;
  stateStore: CompanionStateStore;
  conversationStore: Pick<ConversationStore, 'listThreads' | 'conversationHistory' | 'recentMessages' | 'experiencesById' | 'experienceCandidates' | 'history'>;
  /** Null without a model key: she feels and remembers, and stays quiet. */
  speaker: BodyReactionSpeaker | null;
  config: BodyReactionConfig;
  /** `SHANNON_BODY_INGEST`. */
  ingestEnabled: boolean;
  /** Whether the device registered its capabilities as her body. */
  isBody: (scopeKey: string, deviceId: string) => boolean;
  /** Where that body is (`windows`, `mac`, `iphone`), when it said. */
  surface?: (scopeKey: string, deviceId: string) => BodySurface | undefined;
  /** One entry in the activity record for a line she said. */
  record: (scopeKey: string, entry: { summary: string; outcome: 'done' }) => void;
  now: () => string;
}

export type BodyReactionRefusal = 'disabled' | 'ingest_disabled' | 'not_owner' | 'not_a_body' | 'conflict' | 'rate_limited';
export type BodyReactionOutcome = { kind: 'done'; answer: BodyReactionAnswer } | { kind: BodyReactionRefusal };

const LATE = Symbol('late');

/** Stage 2: how strongly she feels a touch whose feeling she chose: the size of her stance's error, else the startle. */
function stage2Intensity(prediction: NonNullable<FeltTouch['prediction']>, settled: ReturnType<BodyTouches['settle']>): number {
  const outcome = settled?.outcome ?? prediction.outcome;
  return outcome ? touchImpact(outcome) : prediction.startle;
}

export class BodyReactions {
  private readonly inflight = new Map<string, { hash: string; answer: Promise<BodyReactionAnswer> }>();
  private readonly requests = new Map<string, number[]>();
  private readonly pruned = new Map<string, number>();

  constructor(private readonly dependencies: BodyReactionDependencies) {}

  get enabled(): boolean { return this.dependencies.config.enabled && this.dependencies.ingestEnabled; }

  async react(scopeKey: string, deviceId: string, request: BodyReactionRequest): Promise<BodyReactionOutcome> {
    const { config, store } = this.dependencies;
    if (!config.enabled) return { kind: 'disabled' };
    if (!this.dependencies.ingestEnabled) return { kind: 'ingest_disabled' };
    // A touch reaction is for the owner's own body only: no other scope may ask for one.
    if (config.ownerScopeKey !== scopeKey) return { kind: 'not_owner' };
    if (!this.dependencies.isBody(scopeKey, deviceId)) return { kind: 'not_a_body' };
    // Holding anything but the hand, or a hover anywhere but the head and the hair, is not a touch: no feeling, no memory,
    // no model, no request counted against the limit and no row written. As for an event, it is answered so every time,
    // whatever its id was used for before (a known id resent in such a shape is `not_a_touch`, not a conflict).
    if (isImpossibleTouch(request.touch)) {
      return { kind: 'done', answer: { ...this.quiet(request.id, this.dependencies.stateStore.snapshot(scopeKey), this.dependencies.now()), ignored: 'not_a_touch' } };
    }

    const hash = bodyReactionContentHash(request);
    const key = `${scopeKey}\u0000${request.id}`;
    // The same id asked again while the first is being answered waits for that answer.
    const running = this.inflight.get(key);
    if (running) return running.hash === hash ? { kind: 'done', answer: await running.answer } : { kind: 'conflict' };

    const at = this.dependencies.now();
    this.prune(scopeKey, at);
    const known = store.reaction(scopeKey, request.id);
    if (known) {
      if (known.contentHash !== hash) return { kind: 'conflict' };
      if (known.answer) return { kind: 'done', answer: known.answer };
      // Left unanswered by a process that stopped: the touch was counted then; she stays quiet now.
      const answer = this.quiet(request.id, this.dependencies.stateStore.snapshot(scopeKey), at);
      store.finish(scopeKey, answer, at, null);
      return { kind: 'done', answer: store.reaction(scopeKey, request.id)?.answer ?? answer };
    }
    if (!this.allowed(scopeKey, at)) return { kind: 'rate_limited' };
    const begun = store.begin(scopeKey, request.id, deviceId, hash, request.audience, at);
    if (!begun.started) {
      return begun.existing.contentHash !== hash ? { kind: 'conflict' }
        : { kind: 'done', answer: begun.existing.answer ?? this.quiet(request.id, this.dependencies.stateStore.snapshot(scopeKey), at) };
    }
    const answer = this.answer(scopeKey, request, at, this.surfaceOf(scopeKey, deviceId));
    this.inflight.set(key, { hash, answer });
    try {
      return { kind: 'done', answer: await answer };
    } finally {
      this.inflight.delete(key);
    }
  }

  /** A voice turn names the reaction before the model answers: her line, as the message that precedes his words. */
  link(scopeKey: string, reactionId: unknown): ReactionLine | null {
    if (!this.enabled || !validBodyReactionId(reactionId)) return null;
    try { return this.dependencies.store.link(scopeKey, reactionId, this.dependencies.now()); } catch { return null; }
  }

  /** The stored turn takes her line, once, so the history reads: her line, his answer, her reply. */
  claim(scopeKey: string, reactionId: unknown): ReactionLine | null {
    if (!this.enabled || !validBodyReactionId(reactionId)) return null;
    try { return this.dependencies.store.claim(scopeKey, reactionId, this.dependencies.now()); } catch { return null; }
  }

  private surfaceOf(scopeKey: string, deviceId: string): BodySurface | undefined {
    try { return this.dependencies.surface?.(scopeKey, deviceId); } catch { return undefined; }
  }

  private async answer(scopeKey: string, request: BodyReactionRequest, at: string, surface: BodySurface | undefined): Promise<BodyReactionAnswer> {
    const { store, touches, stateStore, config } = this.dependencies;
    const startedAt = performance.now();
    let felt: FeltTouch | null = null;
    try {
      const age = Date.parse(at) - Date.parse(request.occurredAt);
      // The bounds of a body event: a touch stamped a day ago, or ahead of the server's clock, is not taken in at all.
      const acceptable = age <= BODY_LIMITS.eventMaximumAgeMilliseconds && age >= -BODY_LIMITS.eventFutureSkewMilliseconds;
      const timely = age <= BODY_REACTION_LIMITS.requestMaximumAgeMilliseconds;
      // The touch itself: felt and remembered whether or not she says anything. Under stage 2 a stance from earlier in the
      // episode is not carried onto a touch she is about to be asked about.
      felt = acceptable ? touches.observe(scopeKey, {
        id: request.id, type: request.touch.type, audience: request.audience, occurredAt: request.occurredAt,
        durationMs: request.touch.durationMs, ...(request.touch.strength !== undefined ? { strength: request.touch.strength } : {}),
        ...(request.touch.region !== undefined ? { region: request.touch.region } : {}), ...(surface ? { surface } : {}),
        // Touch vocabulary 2, as sent: stored with the touch, and since stage 1b read for the reflex (`part`) and her words.
        ...(request.touch.part !== undefined ? { part: request.touch.part } : {}), ...(request.touch.side !== undefined ? { side: request.touch.side } : {}),
        ...(request.touch.gesture !== undefined ? { gesture: request.touch.gesture } : {}), ...(request.touch.reflex !== undefined ? { reflex: request.touch.reflex } : {}),
      }, { awaitsStance: timely && this.dependencies.speaker !== null }) : null;
      const decision = felt && timely ? await this.decide(scopeKey, request, felt, at, startedAt, surface) : null;
      // The result table (Syzygy ADR-0005 stage 1b): how she took the touch, or nothing when she gave no judgement in time.
      if (felt) this.outcome(scopeKey, request, felt, decision);
      // Syzygy ADR-0006 stage 2: her stance is the outcome of the touch, and its prediction error moves her.
      const prediction = felt?.prediction;
      const settled = felt && prediction ? this.settle(scopeKey, felt, decision) : null;
      // Under stage 2 every named part is worded factually (頭をなでられた); under stage 1b only the parts where her body flinches first.
      // A touch in the old shape keeps its words of favour (頭をなでてもらった) only when she took it as welcome or fine; otherwise,
      // and while her stance is unknown, it is told factually by its region (頭をなでられた) or, without one, by `factual`.
      const favour = decision?.stance === 'welcome' || decision?.stance === 'fine';
      const reflexPart = prediction
        ? (request.touch.part ? bodyTouchPartWord(request.touch.part) : !favour && request.touch.region ? bodyTouchRegionWord(request.touch.region) : undefined)
        : reflexPartWord(request.touch.part);
      const factual = prediction !== undefined && !request.touch.part && !request.touch.region && !favour;
      // On a part where her body flinches first the table gave her no feeling, only the reflex: the feeling she chose is
      // her face afterwards also when she stays silent (the body shows `mood` after its flinch). Under stage 2 that holds for
      // every part (no table moves her). Elsewhere under stage 1b, as before, a silent answer leaves the feeling of the touch.
      const ownFeeling = decision !== null && (reflexPart !== undefined || prediction !== undefined) && decision.feeling !== 'neutral';
      if (!felt || !decision || (!decision.say && !ownFeeling)) return this.finished(scopeKey, this.quiet(request.id, stateStore.snapshot(scopeKey), at), at, null);

      const saidAt = this.dependencies.now();
      const before = stateStore.snapshot(scopeKey);
      const touched = {
        kind: request.touch.type, countInWindow: felt.burst.count, ownerAlone: request.audience === 'owner', durationMs: request.touch.durationMs,
        ...(request.touch.strength !== undefined ? { strength: request.touch.strength } : {}),
        // On such a part her chosen feeling is as strong as the reflex was felt, and its cause names the part (首をつつかれた).
        ...(reflexPart ? { reflexPart, ...(request.touch.gesture === 'rest' ? { resting: true } : {}) } : {}),
        ...(factual ? { factual: true } : {}),
      };
      // The feeling of her line is resolved as the feeling of any reply is: from her own words and the stored state.
      const resolved = resolveReplyEmotion({
        snapshot: before, userMessage: '', reply: decision.text, now: saidAt, replaces: true,
        // As strongly as the touch is felt (the one table, or the reflex), not as strongly as whatever she felt before it. Under
        // stage 2 as strongly as her stance was unexpected (|w_δ × δ|), or as the startle when no stance is known.
        decided: { primary: decision.feeling, intensity: prediction ? stage2Intensity(prediction, settled) : touchFeeling(touched).intensity },
      });
      // A feeling from conversation that the touch did not replace is not replaced by her line about the touch either.
      const held = holdsFeelingThroughTouch(before, resolved.expressiveEmotion, saidAt, emotionTiming());
      const after = resolved.expressiveEmotion.primary === 'neutral' || held ? before : stateStore.apply(scopeKey, {
        type: 'expressive-emotion-updated',
        emotion: { ...resolved.expressiveEmotion, cause: touchCause(touched), target: touchTarget(touched) },
      });
      if (!decision.say) return this.finished(scopeKey, this.quiet(request.id, after, saidAt), saidAt, null);
      const answer: BodyReactionAnswer = {
        schemaVersion: 1, id: request.id, status: 'said',
        message: {
          id: randomUUID(), text: decision.text, expression: resolved.messageEmotion.expression,
          ...(resolved.messageEmotion.feeling ? { feeling: resolved.messageEmotion.feeling } : {}),
          threadId: this.dependencies.conversationStore.listThreads(scopeKey)[0]?.threadId ?? null, listenSeconds: config.listenSeconds,
        },
        mood: this.mood(after, saidAt),
      };
      const listenUntil = new Date(Date.parse(saidAt) + config.listenSeconds * 1_000 + BODY_REACTION_LIMITS.linkMarginMilliseconds).toISOString();
      const stored = this.finished(scopeKey, answer, saidAt, listenUntil);
      if (stored === answer) {
        // The answer is stored: nothing after it may change what the body is told.
        try { touches.said(scopeKey, felt.burst.id, decision.text, request.audience === 'others'); } catch { /* the line is then not in the memory of the touch */ }
        try {
          // The part and gesture when the body named them (胸に触れられた), so the record never says 頭 of a touch elsewhere.
          const phrase = touchDetailPhrase(request.touch.type, request.touch, 'done') ?? BODY_TOUCH_PHRASES[request.touch.type].done;
          this.dependencies.record(scopeKey, { summary: `体に触れられて（${phrase}）、ひとこと返しました。`, outcome: 'done' });
        } catch { /* the answer stands without its record line */ }
      }
      return stored;
    } catch (error) {
      console.error('Shannon body reaction failed', error instanceof Error ? error.message : 'unknown');
      // An answer that was already stored for the id is the answer.
      try {
        const existing = store.reaction(scopeKey, request.id)?.answer;
        if (existing) return existing;
      } catch { /* answered below */ }
      let snapshot: CompanionStateSnapshot | null = null;
      try { snapshot = stateStore.snapshot(scopeKey); } catch { /* answered below */ }
      const answer: BodyReactionAnswer = snapshot ? this.quiet(request.id, snapshot, at)
        : { schemaVersion: 1, id: request.id, status: 'quiet', message: null, mood: { expression: 'neutral' } };
      try { store.finish(scopeKey, answer, at, null); } catch { /* the body still gets an answer */ }
      return answer;
    }
  }

  /** Stage 2: her stance (or the one carried from this episode) learned as the outcome. A failure leaves only the startle. */
  private settle(scopeKey: string, felt: FeltTouch, decision: BodyReactionDecision | null): ReturnType<BodyTouches['settle']> {
    try { return this.dependencies.touches.settle(scopeKey, felt, decision?.stance ?? null); } catch (error) {
      console.error('Shannon touch appraisal failed', error instanceof Error ? error.name : 'unknown');
      return null;
    }
  }

  /** The one model call, raced against the deadline. Null when she has no words in time: the caller stays quiet. */
  private async decide(scopeKey: string, request: BodyReactionRequest, felt: FeltTouch, at: string, startedAt: number, surface?: BodySurface): Promise<BodyReactionDecision | null> {
    const { speaker, touches, config } = this.dependencies;
    if (!speaker) return null;
    const sitting = touches.sitting(scopeKey, felt.snapshot, at);
    // Stage 2: she is asked her stance on every touch, and, with the owner alone, told their closeness and how she took
    // touches on this part before (facts only; Syzygy ADR-0005 owner answer 4, ADR-0006 §1 「考える層への渡し方」).
    const stage2 = felt.prediction !== undefined;
    // The part of touch vocabulary 2, else the old region, each named by its own words (首, 脇, 頬): never a fallback word.
    const part = request.touch.part ?? request.touch.region;
    const partWord = request.touch.part ? bodyTouchPartWord(request.touch.part) : request.touch.region ? bodyTouchRegionWord(request.touch.region) : undefined;
    const history = stage2 && request.audience === 'owner' ? {
      closeness: felt.snapshot.temperament.closeness,
      ...(part && partWord ? { part: partWord, stances: touches.stances(scopeKey, part, felt.snapshot, at) } : {}),
    } : undefined;
    const prompt = bodyReactionPrompt({
      ...(stage2 ? { asksStance: true } : {}), ...(history ? { history } : {}),
      touch: request.touch, audience: request.audience, feeling: presentShannonFeeling(felt.snapshot, at, emotionTiming()),
      burst: felt.burst, sitting: sitting.bursts, said: request.audience === 'owner' ? sitting.said : sitting.saidOpen, conversation: this.conversation(scopeKey, request, felt.snapshot, at), at, ...(surface ? { surface } : {}),
    });
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // What is left of the deadline after the touch was taken in and the prompt was built.
    const remaining = Math.max(0, config.deadlineMilliseconds - (performance.now() - startedAt));
    const deadline = new Promise<typeof LATE>(resolve => { timer = setTimeout(() => resolve(LATE), remaining); });
    try {
      const stance = stage2 || asksStance(request.touch);
      const decision = await Promise.race([speaker.decide({ scopeKey, prompt, signal: abort.signal, ...(stance ? { stance } : {}) }).catch(() => null), deadline]);
      if (decision !== LATE) {
        // Whatever the speaker returns, her line is one short sentence, and no words means silence.
        const text = decision?.say ? boundedReactionText(decision.text) : '';
        return decision ? { ...decision, text, say: text.length > 0 } : null;
      }
      // Given up: the body has stopped waiting, so a line that arrives now must not be said or kept.
      abort.abort();
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One row of the result table for a touch she was asked about. A failure loses the row, never the answer. Without a
   * decision (deadline, no model, a late request) the stance stays empty: only the reflex moved her, and nothing of hers is made up.
   */
  private outcome(scopeKey: string, request: BodyReactionRequest, felt: FeltTouch, decision: BodyReactionDecision | null): void {
    try {
      this.dependencies.store.recordOutcome(scopeKey, {
        touchId: request.id, burstId: felt.burst.id, audience: request.audience,
        stance: decision?.stance ?? null, feeling: decision ? decision.feeling : null, said: decision?.say === true, decidedAt: this.dependencies.now(),
      });
    } catch { /* the answer stands without its row */ }
  }

  /** The last lines of the Talk, only while a conversation with the owner alone is in progress. */
  private conversation(scopeKey: string, request: BodyReactionRequest, snapshot: CompanionStateSnapshot, at: string): readonly { role: 'user' | 'assistant'; content: string }[] {
    if (request.audience !== 'owner') return [];
    try {
      const thread = this.dependencies.conversationStore.listThreads(scopeKey)[0];
      if (!thread || Date.parse(at) - Date.parse(thread.updatedAt) > BODY_REACTION_LIMITS.conversationFreshMilliseconds) return [];
      // Through the same filter as any replay: what the owner had her forget is not re-fed.
      return visibleReplayMessages(snapshot, this.dependencies.conversationStore as ConversationStore, scopeKey, thread.threadId, OWNER_AUDIENCE,
        BODY_REACTION_LIMITS.contextMessages).messages.map(entry => entry.item);
    } catch { return []; }
  }

  /** Writes the answer once and returns what is stored for the id, so every reader of the id sees the same answer. */
  private finished(scopeKey: string, answer: BodyReactionAnswer, at: string, listenUntil: string | null): BodyReactionAnswer {
    if (this.dependencies.store.finish(scopeKey, answer, at, listenUntil)) return answer;
    return this.dependencies.store.reaction(scopeKey, answer.id)?.answer ?? answer;
  }

  private quiet(id: string, snapshot: CompanionStateSnapshot, at: string): BodyReactionAnswer {
    return { schemaVersion: 1, id, status: 'quiet', message: null, mood: this.mood(snapshot, at) };
  }

  /** Her face now, without its cause: the body may be on a stream. */
  private mood(snapshot: CompanionStateSnapshot, at: string): BodyReactionAnswer['mood'] {
    const mood = presentShannonMood(snapshot, at, emotionTiming());
    return { expression: mood.expression, ...(mood.feeling ? { feeling: mood.feeling } : {}) };
  }

  private allowed(scopeKey: string, at: string): boolean {
    const time = Date.parse(at);
    const recent = (this.requests.get(scopeKey) ?? []).filter(value => time - value >= 0 && time - value < 60_000);
    if (recent.length >= BODY_REACTION_LIMITS.requestsPerMinute) return false;
    if (this.requests.size >= 64) this.requests.clear();
    this.requests.set(scopeKey, [...recent, time]);
    return true;
  }

  private prune(scopeKey: string, at: string): void {
    const time = Date.parse(at);
    const last = this.pruned.get(scopeKey);
    if (last !== undefined && time - last >= 0 && time - last < 60_000) return;
    if (this.pruned.size >= 64) this.pruned.clear();
    this.pruned.set(scopeKey, time);
    try { this.dependencies.store.prune(scopeKey, at); } catch { /* the request is still answered */ }
  }
}
