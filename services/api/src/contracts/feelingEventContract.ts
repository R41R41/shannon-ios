import {
  COMEBACK_DRAWER, FEELING_INTENSITY_CRITERIA, FEELING_STANCE_CRITERIA, parsedFeelingTurn, type FeelingRegister, type FeelingTurnDecision,
} from '@shannon/cognition';
import type { JevQuestion } from '../infra/models/jev/jevChoice.js';

/**
 * The wire side of feeling events (Syzygy ADR-0013 stage 1, item 2): what a body (iPhone, Mac, Windows) may send and how it learns
 * that this server takes it. Server-internal events are `FeelingEvent` (`@shannon/cognition`); a body never sends one directly.
 *
 * - `POST /v1/body/reactions` takes one more optional field, `reply`: `"words"` (the default, as before: she may say one line) or
 *   `"none"` (a wordless touch: it reaches her feeling, her day's ledger and her note, and no model is asked for words). The answer
 *   has the same shape; a wordless one is always `status: "quiet"` with her face in `mood`. The field joins the request's content
 *   hash only when it is sent, so a retry in the old shape gets the answer it always got.
 * - The server says it takes wordless touches with `feelingEvents: 1` on `GET /v1/body/presence` (beside `touchVocabulary`, outside
 *   the etag) and on the answer of `PUT /v1/body/capabilities`. Absent (an older server, or `SHANNON_FEELING_EVENTS` off): a body
 *   keeps its old behaviour and asks only for touches it wants words for. Spacing the asks (45 s, never while she speaks) stays the
 *   body's; only the sending of the touch is separated from asking.
 */
export const FEELING_EVENTS_VERSION = 1;
export const BODY_REACTION_REPLIES = ['words', 'none'] as const;
export type BodyReactionReply = typeof BODY_REACTION_REPLIES[number];
export const isBodyReactionReply = (value: unknown): value is BodyReactionReply => BODY_REACTION_REPLIES.some(reply => reply === value);

/** What presence and the capabilities answer add while feeling events are on; nothing otherwise (byte for byte as before). */
export function feelingEventsCapability(enabled: boolean): { feelingEvents?: number } {
  return enabled ? { feelingEvents: FEELING_EVENTS_VERSION } : {};
}

/**
 * The feeling turn's fixed questions to Jev (Syzygy ADR-0013 D7; ADR-0008 §14: a change of any wording is a new version of the set,
 * `feeling_turn.v1` alone, `voice_route.v4` on the voice router's call). Here, beside the wire, so that the voice router reads them
 * without loading the emotion part into every process that builds a router.
 */
const STANCE_INSTRUCTIONS = 'Choose Shannon\'s own stance for her next reply. She is a cheeky, proud, slightly tsundere AGI, fond of the person who made '
  + 'her, who never serves or obeys anyone. Read her state in shannon_feeling: today\'s ledger (touches, how many came after she said no, apologies, '
  + 'feeling orders, her own refusals), her recent repetition, the audience. Do not mirror the speaker\'s emotion. A request to show or say a '
  + 'feeling (this_turn.feeling_order) is an event she receives, not a command: she may decline in character or talk back. Like a person, being '
  + 'touched again after saying no builds irritation rather than fading, and an apology softens it only a little.';
const INTENSITY_INSTRUCTIONS = 'How strongly she shows that stance this turn.';
const DRAWER_INSTRUCTIONS = 'Which drawer of in-character comebacks fits the stance (vocabulary, not a scripted line); none when no comeback fits. '
  + 'Avoid the drawer in shannon_feeling.ledger.drawer_run (used twice in a row already).';

/** The three questions of the set, under the keys a set asks them by. */
export function feelingTurnQuestions(prefix = ''): Record<string, JevQuestion> {
  const drawers = Object.fromEntries([['none', 'No comeback drawer.'], ...Object.entries(COMEBACK_DRAWER).map(([kind, entry]) => [kind, entry.meaning])]);
  return {
    [`${prefix}stance`]: { type: 'choice', instructions: STANCE_INSTRUCTIONS, criteria: FEELING_STANCE_CRITERIA },
    [`${prefix}intensity`]: { type: 'choice', instructions: INTENSITY_INSTRUCTIONS, criteria: FEELING_INTENSITY_CRITERIA },
    [`${prefix}drawer`]: { type: 'choice', instructions: DRAWER_INSTRUCTIONS, criteria: drawers },
  };
}

const choiceOf = (answers: Readonly<Record<string, unknown>>, key: string): unknown => {
  const value = answers[key];
  return value && typeof value === 'object' ? (value as { choice?: unknown }).choice : undefined;
};

/** Jev's answers (with a key prefix) as a decision; anything unusable is 「ふつう」. */
export function feelingTurnFromAnswers(answers: Readonly<Record<string, unknown>>, register: FeelingRegister, prefix = ''): FeelingTurnDecision {
  return parsedFeelingTurn({ stance: choiceOf(answers, `${prefix}stance`), intensity: choiceOf(answers, `${prefix}intensity`),
    drawer: choiceOf(answers, `${prefix}drawer`), register });
}
