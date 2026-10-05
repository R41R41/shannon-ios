import { memoryControlFor, type CompanionStateSnapshot, type MemoryDisclosure } from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';

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
  const texts = [
    ...items.filter(item => keptSecret(item.disclosure) || gone(item)).flatMap(item => item.texts),
    ...conversations.experienceCandidates(scopeKey)
      .filter(turn => keptSecret(turn.disclosure) || forgotten(state, turn.id) || goneTurns.has(turn.id)).map(turn => turn.userMessage),
  ];
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
