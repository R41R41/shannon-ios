import {
  UNKNOWN_GUEST_PRESENCE, disclosureDecision, memoryControlFor, resolveDisclosure, type CompanionStateSnapshot, type DisclosureDecision, type MemoryDisclosure,
} from '@shannon/cognition';
import type { ConversationStore } from '../memory/store/conversationStore.js';

/**
 * What a write of hers from a conversation must not repeat (ADR-0002; owner decision 2026-10-05): items the owner
 * asked to keep secret or marked 機微 by hand; items and turns he asked her to forget or rejected; and what went with
 * them as `visibleMemoryText` reads it: items derived from a forgotten turn, items that quote what a forgotten item
 * quoted, and the turns forgotten items came from. Nothing else
 * of his: her stories and notes may be about him and the people he knows. A corrected item's original wording is not
 * included (it is wrong, not secret). The words are used only to check what her study and folder tools are asked to
 * write; they are never given to a model.
 *
 * The check: a run of `SECRET_RUN` characters of any such text (whitespace, punctuation and a leading 「ユーザーは」
 * style subject removed; runs that are all hiragana are filler and skipped) appearing in what she writes. A text
 * shorter than a run must appear whole. Every text is checked in full; there is no cap on how many there are.
 */
export const SECRET_RUN = 10;
const SHORT_MINIMUM = 4;

export interface SecretCheck {
  carries(text: string): boolean;
}

const SUBJECT = /^(?:ユーザー|ライ氏|ライさん|オーナー|私|わたし|僕|ぼく|俺)(?:は|が|の|って)/u;

function compact(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function keptSecret(disclosure: MemoryDisclosure | undefined): boolean {
  return disclosure?.category === 'secret' || (disclosure?.decidedBy === 'owner' && disclosure.sensitivity === 'sensitive');
}

function forgotten(state: CompanionStateSnapshot, id: string | undefined): boolean {
  const status = id ? memoryControlFor(state, id)?.status : undefined;
  return status === 'forgotten' || status === 'rejected';
}

export function conversationSecrets(state: CompanionStateSnapshot, conversations: Pick<ConversationStore, 'experienceCandidates'>, scopeKey: string): SecretCheck {
  return runCheck(secretTexts(state, conversations, scopeKey));
}

/** The texts `conversationSecrets` checks. */
function secretTexts(state: CompanionStateSnapshot, conversations: Pick<ConversationStore, 'experienceCandidates'>, scopeKey: string): string[] {
  const items = [
    ...state.userFacts.map(item => ({ id: item.id, source: item.sourceExperienceId, evidence: item.evidence, texts: [item.statement, item.evidence ?? ''], disclosure: item.disclosure })),
    ...state.relationships.map(item => ({ id: item.id, source: item.sourceExperienceId, evidence: item.evidence, texts: [item.statement, item.evidence ?? ''], disclosure: item.disclosure })),
    ...state.prospectiveMemories.map(item => ({ id: item.id, source: item.sourceExperienceId, evidence: item.evidence, texts: [item.summary, item.evidence ?? ''], disclosure: item.disclosure })),
  ];
  // What a forgotten or rejected item quoted: an item whose evidence quotes the same words is gone with it.
  const normalize = (value: string | undefined) => (value ?? '').replace(/[\s。、]/gu, '');
  const goneQuotes = items.filter(item => forgotten(state, item.id)).map(item => normalize(item.evidence))
    .concat(state.memoryControls.filter(control => forgotten(state, control.memoryId)).map(control => normalize(control.sourceEvidence)))
    .filter(quote => quote.length >= 3);
  const quotesGone = (evidence: string | undefined) => {
    const quote = normalize(evidence);
    return quote.length >= 3 && goneQuotes.some(gone => gone.includes(quote) || quote.includes(gone));
  };
  // Forgotten or rejected itself, from a forgotten or rejected turn, or quoting what such an item quoted.
  const gone = (item: typeof items[number]) => forgotten(state, item.id) || forgotten(state, item.source) || quotesGone(item.evidence);
  const goneTurns = new Set(items.filter(item => forgotten(state, item.id)).map(item => item.source).filter((value): value is string => Boolean(value)));
  return [
    ...items.filter(item => keptSecret(item.disclosure) || gone(item)).flatMap(item => item.texts),
    ...conversations.experienceCandidates(scopeKey)
      .filter(turn => keptSecret(turn.disclosure) || forgotten(state, turn.id) || goneTurns.has(turn.id)).map(turn => turn.userMessage),
  ];
}

/**
 * What of the owner's may not reach the model as it is while anyone else can see or hear the reply, as a check of free
 * text (owner decision 2026-10-06, Syzygy ADR-0007: what she reads of 「シャノン用フォルダ」 in front of others, `aetherShownText.ts`).
 * It is the rule memory follows for such a turn (`disclosureDecision`), judged for an unnamed guest, the strictest presence:
 * `withheld` is everything `conversationSecrets` holds and every fact, relationship, promise or turn of his withheld for that
 * presence; `guarded` every one guarded for it (his other personal matters, which memory gives such a turn marked and
 * `aetherShownText.ts` leaves out of what she reads, by his word 「除く」). A turn
 * gives its user words whoever spoke them: turns are not filtered by speaker, and a turn without a label (written before
 * labels) is guarded. A text shorter than a run must appear whole (`SHORT_MINIMUM`), so a short legacy turn such as
 * 「ありがとう」 can take out, in a turn with others present, a sentence that holds those words; this is left as it is
 * rather than weaken the check (review N1). `withheld` also holds each sentence of a withheld text whole (`sentenceCheck`):
 * by the owner's word 「除く」 a short sentence of a secret (「来月に手術。」) is left out too, though it is shorter than a run.
 * Only this path has it; `conversationSecrets` and every other use of the run check are unchanged.
 */
export function othersSecrets(state: CompanionStateSnapshot, conversations: Pick<ConversationStore, 'experienceCandidates'>, scopeKey: string): { withheld: SecretCheck; guarded: SecretCheck } {
  const decided = (id: string, disclosure: MemoryDisclosure | undefined): DisclosureDecision =>
    disclosureDecision(resolveDisclosure(state, id, disclosure), UNKNOWN_GUEST_PRESENCE);
  const items = [
    ...state.userFacts.map(item => ({ decision: decided(item.id, item.disclosure), texts: [item.statement, item.evidence ?? ''] })),
    ...state.relationships.map(item => ({ decision: decided(item.id, item.disclosure), texts: [item.statement, item.evidence ?? ''] })),
    ...state.prospectiveMemories.map(item => ({ decision: decided(item.id, item.disclosure), texts: [item.summary, item.evidence ?? ''] })),
    ...conversations.experienceCandidates(scopeKey).map(turn => ({ decision: decided(turn.id, turn.disclosure), texts: [turn.userMessage] })),
  ];
  const texts = (decision: DisclosureDecision) => items.filter(item => item.decision === decision).flatMap(item => item.texts);
  const withheldTexts = [...secretTexts(state, conversations, scopeKey), ...texts('withheld')];
  const runs = runCheck(withheldTexts);
  const sentences = sentenceCheck(withheldTexts);
  return { withheld: { carries: text => runs.carries(text) || sentences.carries(text) }, guarded: runCheck(texts('guarded')) };
}

/**
 * Each sentence and each fragment of these texts of at least `SHORT_MINIMUM` characters, matched whole inside what is
 * checked (a sentence of the folder text). A sentence is cut after 。！？!? and at line breaks (「来月、手術。」 gives
 * 「来月手術」); a fragment, kept beside it, is also cut after ｡．, at 、，, emoji, and whitespace next to a character
 * outside ASCII (so 「来月に手術 病院は東大病院」 gives 「来月に手術」; ASCII words are not cut apart, and an ASCII-only
 * text is not cut at `.`). Both are compacted as a run is, with a leading 「ユーザーは」 style subject removed. On both
 * sides, variation selectors, the zero-width joiner and skin-tone modifiers are removed first (`withoutEmojiParts`),
 * so an emoji such as ❤️ or 👨‍⚕️ cuts cleanly and leaves nothing on the next fragment. A short fragment of hiragana alone (at most
 * `FILLER_MAXIMUM` characters, 「そうなんだ」) is filler and skipped; a longer one (「うつになった」) is matched like any other.
 */
const FILLER_MAXIMUM = 5;
const SENTENCE_CUT = /(?<=[。！？!?])|\n/u;
const FRAGMENT_CUT = /(?<=[。！？!?｡．])|[、，,\n]|\p{Extended_Pictographic}|(?<=[^\x00-\x7F])\s+|\s+(?=[^\x00-\x7F])/u;
const withoutEmojiParts = (text: string) => text.replace(/[\uFE0E\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/gu, '');

function sentenceCheck(texts: readonly string[]): SecretCheck {
  const sentences = new Set<string>();
  for (const text of texts.map(withoutEmojiParts)) {
    for (const sentence of [...text.split(SENTENCE_CUT), ...text.split(FRAGMENT_CUT)]) {
      const words = compact(sentence.trim().replace(SUBJECT, ''));
      if (words.length >= SHORT_MINIMUM && !(words.length <= FILLER_MAXIMUM && /^[\p{Script=Hiragana}ー]+$/u.test(words))) sentences.add(words);
    }
  }
  return {
    carries(text: string): boolean {
      const candidate = compact(withoutEmojiParts(text));
      for (const words of sentences) if (candidate.includes(words)) return true;
      return false;
    },
  };
}

/** The check of `SECRET_RUN` runs over these texts (see `conversationSecrets`). */
function runCheck(texts: readonly string[]): SecretCheck {
  const runs = new Set<string>();
  const whole = new Set<string>();
  for (const text of texts) {
    const words = compact(text.trim().replace(SUBJECT, ''));
    if (words.length < SECRET_RUN) {
      if (words.length >= SHORT_MINIMUM) whole.add(words);
      continue;
    }
    for (let index = 0; index + SECRET_RUN <= words.length; index += 1) {
      const run = words.slice(index, index + SECRET_RUN);
      if (!/^[\p{Script=Hiragana}ー]+$/u.test(run)) runs.add(run);
    }
  }
  return {
    carries(text: string): boolean {
      const candidate = compact(text);
      for (const words of whole) if (candidate.includes(words)) return true;
      for (let index = 0; index + SECRET_RUN <= candidate.length; index += 1) {
        if (runs.has(candidate.slice(index, index + SECRET_RUN))) return true;
      }
      return false;
    },
  };
}
