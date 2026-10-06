import { UNLABELLED_DISCLOSURE_MARKER } from '@shannon/cognition';
import type { SecretCheck } from './conversationSecrets.js';
import { toolFailure, type ToolResult } from './shannonTools.js';

/**
 * What she reads of Aether reaches the model this way while anyone but the owner can see or hear the reply (Syzygy
 * ADR-0007, owner decision 2026-10-06: 人前で読んだシャノン用フォルダのメモからは、所有者の内緒・個人的なことを除いてから使う).
 * Her stories and notes may hold what the owner told her alone. The rule is the one memory follows for the same turn
 * (`docs/architecture.md`, People and audience), applied to free text with the check her writes from a conversation
 * already use (`conversationSecrets.ts`, runs of words; `othersSecrets` picks the items by `disclosureDecision`):
 *
 * - a sentence that carries something withheld (what he asked to keep secret, marked 機微 by hand, asked her to forget,
 *   or anything withheld for an unnamed guest) is left out;
 * - a sentence that carries one of his other personal matters (guarded) is marked, as memory marks it, where he may
 *   release it (his own turn with others, 「友人も一緒」), and left out where he is not there (`openOnly`, someone
 *   else's turn on a platform), as memory leaves it out there.
 * - where he may release it, what she read is also, as a whole, derived text with no label of its own, and carries the
 *   unlabelled marker on a line of its own before it, as such text does in a prompt with him and others (review S2), so
 *   the speak-time check covers all of it. Where he is not there it carries none: the run filter is the rule there.
 *
 * A sentence is a line, cut after 。！？!?. When what stays still carries something withheld (a run across sentences),
 * nothing of the result is given; nor when the check could not be read (`null`). A sentence that was left out is not
 * replaced by anything; one line at the end says that some were. Like every use of this check it catches the owner's
 * own words and their runs, not a retelling in other words.
 */
export interface OthersTextCheck {
  withheld: SecretCheck;
  guarded: SecretCheck;
  /** Nobody present may release a protected line of the owner's (a turn someone other than the owner wrote). */
  openOnly: boolean;
}

export const LEFT_OUT_LINE = '（ここにいる人には渡さないところを、いくつか除いてある）';

const UNREADABLE = toolFailure('unavailable', '読んだ中身を、ここにいる人の前で使ってよいか確かめられなかったので、渡さない。', {
  retryable: true, refusal: { why: '内緒のことの記憶をいま読めなかった', wouldWork: '少しあとでもう一度' },
});
const CARRIES = toolFailure('refused', '読んだ中身に、ここにいる人には渡さないことが入っていたので、渡さない。', {
  retryable: false, refusal: { why: 'ライ氏以外の人がこの返事を見聞きできる', wouldWork: 'ライ氏と二人だけの時に読む' },
});

/** A tool result as the model may see it with others present. Failures carry no read text and pass as they are. */
export function resultForOthers(result: ToolResult, check: OthersTextCheck | null): ToolResult {
  if (!result.ok) return result;
  if (!check) return UNREADABLE;
  try {
    const shown = textForOthers(result.text, check);
    if (shown === null) return CARRIES;
    const text = check.openOnly ? shown : `${UNLABELLED_DISCLOSURE_MARKER}\n${shown}`;
    return text === result.text ? result : { ...result, text };
  } catch { return UNREADABLE; }
}

/** The text without what may not reach the model, or null when nothing of it may. */
export function textForOthers(text: string, check: OthersTextCheck): string | null {
  if (!check.withheld.carries(text) && !check.guarded.carries(text)) return text;
  let removed = false;
  const lines = text.split('\n').flatMap(line => {
    const kept = line.split(/(?<=[。！？!?])/u).flatMap(sentence => {
      if (check.withheld.carries(sentence) || (check.openOnly && check.guarded.carries(sentence))) { removed = true; return []; }
      return [check.guarded.carries(sentence) ? `${UNLABELLED_DISCLOSURE_MARKER}${sentence}` : sentence];
    }).join('');
    return kept.trim() || !line.trim() ? [kept] : [];
  });
  const shown = lines.join('\n');
  if (check.withheld.carries(shown) || (check.openOnly && check.guarded.carries(shown))) return null;
  return removed ? `${shown}\n${LEFT_OUT_LINE}` : shown;
}
