import { neutralFeelingTurn, utteranceKind, type FeelingAudience, type FeelingRegister, type FeelingTurnDecision } from '@shannon/cognition';
import { JEV_QUESTION_SETS, type JevChooser } from '../../infra/models/jev/jevChoice.js';
import {
  FEELING_TURN_JEV_INPUT, feelingTurnFromAnswers, feelingTurnQuestions, type FeelingTurnJevInput,
} from '../../contracts/feelingEventContract.js';
import { observeAsync } from '../../infra/observer/observerContext.js';
import type { FeelingLines } from './feelingEvents.js';

/**
 * The feeling turn v0 on Jev (Syzygy ADR-0013 D7, stage 1 items 5 and 6). Core: emotion.
 *
 * Text: one Jev call (`feeling_turn.v1`), started beside the turn's recall and context, so it waits for nothing; the reply waits for
 * it at most `FEELING_TURN_LIMITS.extraWaitMilliseconds` after its prompt is otherwise ready, and then goes on with 「ふつう」 (the
 * ledger facts still go in). Voice: the same three questions ride on the voice router's one Jev call (`voice_route.v4`), so a voice
 * turn makes no extra round trip.
 *
 * Jev is handed closed numbers of the ledger and the watch, the audience, and the speaker's words (as the voice router and the
 * tool menu already are); never her inner note, never the owner's other words.
 */
export const FEELING_TURN_LIMITS = Object.freeze({
  /** The longest a text reply waits for the feeling turn beyond its own preparation (the ADR-0013 D13 budget is +200 ms p95). */
  extraWaitMilliseconds: 200,
  utteranceCharacters: 400,
});

export interface FeelingTurnInput {
  scopeKey: string;
  surface: 'text' | 'voice';
  audience: FeelingAudience;
  utterance: string;
  lines: FeelingLines | null;
  /** The register hint (D16), passed through unchanged in stage 1. */
  register: FeelingRegister;
  mood: { valence: number; arousal: number };
  /** Stage 2 (`SHANNON_CORE_AFFECT`): also ask the meaning of the words for her appraisal (meant, teasing). */
  reading?: boolean;
  /** Whether Jev is handed the turn's words (`utterance`, at most 400 characters) or only the closed facts (`summary`). */
  jevInput?: FeelingTurnJevInput;
}

/** What the chooser is shown: closed numbers, the audience, the words of this turn. */
export function feelingTurnState(input: FeelingTurnInput): Record<string, unknown> {
  const kind = utteranceKind(input.utterance);
  return {
    audience: input.audience, relationship: input.audience === 'owner_alone' ? 'her_creator' : 'others_present', register_hint: input.register,
    this_turn: { feeling_order: kind === 'feeling_order', apology: kind === 'apologized', kind_words: kind === 'praised' },
    ...(input.reading ? { read_meaning: true } : {}),
    ledger: input.lines?.facts ?? {}, mood: { valence: round(input.mood.valence), arousal: round(input.mood.arousal) },
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The text turn's Jev call. Never throws: a failure is 「ふつう」. */
export async function chooseFeelingTurn(chooser: JevChooser | null, input: FeelingTurnInput): Promise<FeelingTurnDecision> {
  if (!chooser) return neutralFeelingTurn(input.register);
  const started = performance.now();
  return observeAsync('emotion', { phase: 'feeling.turn', surface: input.surface, audience: input.audience, register: input.register,
    composure: input.lines?.ledger.composure ?? 1 }, async () => {
    const handsWords = (input.jevInput ?? FEELING_TURN_JEV_INPUT) === 'utterance';
    const words = handsWords ? { utterance: input.utterance.slice(0, FEELING_TURN_LIMITS.utteranceCharacters) } : {};
    const state = { ...words, shannon_feeling: feelingTurnState(input) };
    const decided = await chooser.decide({
      scopeKey: input.scopeKey, surface: input.surface === 'voice' ? 'voice' : 'text', decision: 'feeling_turn',
      sets: [JEV_QUESTION_SETS.feelingTurn, ...(input.reading ? [JEV_QUESTION_SETS.feelingMeaning] : [])],
      state, questions: feelingTurnQuestions('', input.audience, input.reading === true),
      parse: answers => feelingTurnFromAnswers(answers, input.register, '', input.audience),
      fallback: () => neutralFeelingTurn(input.register),
      traceAnswers: value => ({ stance: value.stance, intensity: value.intensity, drawer: value.drawer, register: value.register, source: value.source }),
    });
    return decided.value;
  }, value => ({ stance: value.stance, intensity: value.intensity, drawer: value.drawer, register: value.register, source: value.source,
    latencyMs: Math.round(performance.now() - started) })).catch(() => neutralFeelingTurn(input.register));
}

/** The decision, or 「ふつう」 if it is not there within the extra wait (measured from now, the moment the reply is otherwise ready). */
export async function feelingTurnWithin(pending: Promise<FeelingTurnDecision>, register: FeelingRegister,
  milliseconds = FEELING_TURN_LIMITS.extraWaitMilliseconds): Promise<FeelingTurnDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<FeelingTurnDecision>(resolve => { timer = setTimeout(() => resolve(neutralFeelingTurn(register)), milliseconds); });
  try { return await Promise.race([pending, late]); } finally { clearTimeout(timer); }
}
