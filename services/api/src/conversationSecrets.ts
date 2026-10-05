import { memoryControlFor, type CompanionStateSnapshot, type MemoryDisclosure } from '@shannon/cognition';
import type { ConversationStore } from './conversationStore.js';

/**
 * What a write of hers from a conversation must not repeat (ADR-0002; owner decision 2026-10-05): items the owner
 * asked to keep secret or marked 機微 by hand, and items and turns he asked her to forget or rejected. Nothing else
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

function forgotten(state: CompanionStateSnapshot, id: string): boolean {
  const status = memoryControlFor(state, id)?.status;
  return status === 'forgotten' || status === 'rejected';
}

export function conversationSecrets(state: CompanionStateSnapshot, conversations: Pick<ConversationStore, 'experienceCandidates'>, scopeKey: string): SecretCheck {
  const items = [
    ...state.userFacts.map(item => ({ id: item.id, texts: [item.statement, item.evidence ?? ''], disclosure: item.disclosure })),
    ...state.relationships.map(item => ({ id: item.id, texts: [item.statement, item.evidence ?? ''], disclosure: item.disclosure })),
    ...state.prospectiveMemories.map(item => ({ id: item.id, texts: [item.summary], disclosure: item.disclosure })),
  ];
  const texts = [
    ...items.filter(item => keptSecret(item.disclosure) || forgotten(state, item.id)).flatMap(item => item.texts),
    ...conversations.experienceCandidates(scopeKey).filter(turn => keptSecret(turn.disclosure) || forgotten(state, turn.id)).map(turn => turn.userMessage),
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
