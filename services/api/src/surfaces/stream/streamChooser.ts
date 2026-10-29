import { PAID_KINDS, type CommentRecord, type StreamLedger } from './streamLedger.js';
import { STREAM_LIMITS } from './streamContract.js';

/**
 * What to answer next (`docs/stream-contract.md` §3). Pure: it reads the ledger and says which comments, never what to say.
 *
 * Score: addressed by name +3, a question +2, a viewer's first comment of the stream +2, a superchat or membership +4, the owner or a
 * moderator +1, a viewer answered in the last minute −3. A comment that needs the safety floor (a threat, prying into the owner's life,
 * repeated lewd words) goes first, whatever its score. Short reactions are folded into the crowd and never answered alone. Comments that
 * say the same (the same digest, or the same question) are answered together, up to three, and only clean ones: a comment with a closed
 * tag of hurt is answered alone.
 */
export const STREAM_SCORES = Object.freeze({ named: 3, question: 2, first: 2, paid: 4, role: 1, answeredRecently: -3, floor: 100 });
export const MAX_ANSWERED_TOGETHER = 3;

export interface ChosenComments {
  primary: CommentRecord;
  /** The primary and the comments answered with it (primary first). */
  group: CommentRecord[];
  floor: boolean;
  score: number;
}

export function commentScore(record: CommentRecord, ledger: Pick<StreamLedger, 'answeredRecently' | 'needsFloor'>, nowMs: number): number {
  let score = 0;
  if (record.named) score += STREAM_SCORES.named;
  if (record.question) score += STREAM_SCORES.question;
  if (record.first) score += STREAM_SCORES.first;
  if (PAID_KINDS.has(record.kind)) score += STREAM_SCORES.paid;
  if (record.roles.includes('owner') || record.roles.includes('moderator')) score += STREAM_SCORES.role;
  if (ledger.answeredRecently(record.authorId, nowMs)) score += STREAM_SCORES.answeredRecently;
  if (ledger.needsFloor(record)) score += STREAM_SCORES.floor;
  return score;
}

/** Character bigrams, for telling that two questions are the same question. */
function bigrams(text: string): Set<string> {
  const plain = Array.from(text.normalize('NFKC').toLowerCase().replace(/[\s。、！？!?…ー〜~w笑]+/gu, ''));
  const out = new Set<string>();
  for (let index = 0; index < plain.length - 1; index += 1) out.add(plain[index]! + plain[index + 1]!);
  return out;
}
export function similarity(left: string, right: string): number {
  const a = bigrams(left), b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const gram of a) if (b.has(gram)) common += 1;
  return common / (a.size + b.size - common);
}

const SAME_QUESTION = 0.5;
const sameThing = (left: CommentRecord, right: CommentRecord): boolean =>
  left.digest === right.digest || (left.question && right.question && similarity(left.text, right.text) >= SAME_QUESTION);

export function chooseComments(ledger: StreamLedger, nowMs: number): ChosenComments | null {
  const candidates = ledger.all().filter(record => {
    if (record.status !== 'new' || record.reaction || ledger.isIgnored(record.authorId)) return false;
    const window = PAID_KINDS.has(record.kind) ? STREAM_LIMITS.paidCandidateMilliseconds : STREAM_LIMITS.candidateMilliseconds;
    return nowMs - record.publishedMs <= window;
  });
  if (!candidates.length) return null;
  const scored = candidates.map(record => ({ record, score: commentScore(record, ledger, nowMs) }));
  // Highest first; among equals the one that has waited longest.
  scored.sort((a, b) => b.score - a.score || a.record.publishedMs - b.record.publishedMs);
  const best = scored[0]!;
  const group = [best.record];
  if (!best.record.tags.length) {
    for (const { record } of scored.slice(1)) {
      if (group.length >= MAX_ANSWERED_TOGETHER) break;
      if (!record.tags.length && sameThing(best.record, record)) group.push(record);
    }
  }
  return { primary: best.record, group, floor: ledger.needsFloor(best.record), score: best.score };
}
