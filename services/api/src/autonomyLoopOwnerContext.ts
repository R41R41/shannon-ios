import { SHANNON_OWNER_NAME } from '@shannon/cognition';

/**
 * What her own activity may see of the owner's (owner decision 2026-10-02, Syzygy ADR-0003: 「基本的に全部見ていい」).
 * Core: purpose.
 *
 * Her thinking may draw on what a conversation with the owner alone draws on: what she knows about him, the
 * recent talk between them, memories that fit what she is pursuing, people she remembers, today's focus. This
 * file names the interface and holds the words; it opens no store. The block is built elsewhere
 * (`autonomyOwnerContext.ts`) through the conversation's own memory entry points, so forgetting and the owner's
 * secrecy choices apply here exactly as there, and nothing is copied into a store of the loop.
 *
 * What stays protected is what leaves her head. `ownerPrivateRule` is the one place that says so: whenever
 * owner-private material is in a prompt, or may have shaped what a prompt is given, the prompt carries its line.
 * Things the owner asked to keep secret reach her thinking only; `carriesSecret` keeps them out of every free
 * text of hers that a later prompt or a search would carry on. A page address she makes up is text sent to a
 * stranger's server, so a thought made with the block in front of her reads only pages she was shown
 * (`planFromThought`).
 */
export interface OwnerContextBlock {
  /** The block as one prompt section, header included; within the configured size. */
  section: string;
  /**
   * The words of what must never reach anyone but the owner: what he asked to keep secret, what he marked 機微 by hand,
   * and what was said with an unnamed guest present. Used only to check her own free text; never put in a prompt.
   */
  secrets: readonly string[];
}

export interface AutonomyOwnerContext {
  /** For her thinking: what a conversation with the owner alone may use. Null when there is nothing. */
  forThinking(scopeKey: string, at: string, topic: string): OwnerContextBlock | null;
  /**
   * For a message she writes to the owner: the same, without anything that must never reach anyone else, because her words
   * may be seen or heard beyond him. `others`: someone else is present now, and each protected line carries the marker a
   * conversation with other people present uses.
   */
  forMessage(scopeKey: string, at: string, topic: string, others: boolean): OwnerContextBlock | null;
}

export const OWNER_CONTEXT_TITLE = `${SHANNON_OWNER_NAME}のこと・最近のふたりのこと`;
export const OWNER_CONTEXT_HEADER = `[${OWNER_CONTEXT_TITLE}]（${SHANNON_OWNER_NAME}と二人で話す時にボクが思い出せること。ほかの人には見せない）`;

/** Replaces the line of the thinking rules that says nothing of the owner's is given, while the block is. */
export const OWNER_CONTEXT_MATERIALS_LINE = `- 使ってよい材料は、下に渡されるものだけ。自分の台帳、自分のメモと下書き、公開されている読み物、読者の反応、そして「${OWNER_CONTEXT_TITLE}」。そこにないことを、思い出したふりをして書かない。作品やメモに実在の個人のことを入れない。`;
/** Replaces the line of the message rules that says no conversation is given, while the block is. */
export const OWNER_CONTEXT_MESSAGE_MATERIALS = `下の「${OWNER_CONTEXT_TITLE}」にないことを、思い出したふりをしない。`;

/**
 * The output rule for owner-private material, in one place. `present`: such material is in this prompt, or may
 * have shaped what this prompt is given (an idea or a pursuit she wrote with it in front of her). Null when not:
 * the prompt is then what it was.
 *
 * - `thinking`: she may think with it; it does not go into anything she writes down for a work, and she reads only pages she was shown.
 * - `story`: a draft or a revision. Inspiration, never the thing itself, never recognisable.
 * - `note`: a note about a page she read, for a pursuit she may have written with it in front of her. Nothing of his in it.
 * - `message`: a message to the owner. She may touch on it, lightly, one thing at most.
 */
export function ownerPrivateRule(kind: 'thinking' | 'story' | 'note' | 'message', present: boolean): string | null {
  if (!present) return null;
  if (kind === 'thinking') {
    return `- 「${OWNER_CONTEXT_TITLE}」は、${SHANNON_OWNER_NAME}と二人の時にボクが思い出せること。次に何をするか考える材料にしてよいし、${SHANNON_OWNER_NAME}に話しかけるきっかけにしてよい。物語の着想にしてもよいが、idea・aim・pursuits・text・query には、そのまま書かない。${SHANNON_OWNER_NAME}やその周りの人、場所、出来事だと分かる形にしない。「内緒」「秘密」と言われたことは、考える時にだけ使い、thought にも reason にも、どこにも書かない。ページの住所（url）も外に出る言葉なので、read で読むのは下の「読めそうな場所」にあるページだけ。`;
  }
  if (kind === 'note') {
    return `- 「いま追っていること」には、${SHANNON_OWNER_NAME}と二人の時に知ったことから思いついたものがあるかもしれない。メモには、${SHANNON_OWNER_NAME}やその周りの人、場所、出来事のことを書かない。`;
  }
  if (kind === 'story') {
    return `- 「書こうとしていること」「直したいこと」や台帳には、${SHANNON_OWNER_NAME}と二人の時に知ったことから思いついたものがあるかもしれない。着想にしてよいが、そのまま物語に書かない。${SHANNON_OWNER_NAME}やその周りの人、場所、出来事だと分かる名前や描写を入れない。`;
  }
  return `- 「${OWNER_CONTEXT_TITLE}」は、${SHANNON_OWNER_NAME}と二人の時に知ったこと。話しかけるきっかけや中身にしてよい。並べ立てない。触れるなら一つだけ、さりげなく。`;
}

/** A run of this many characters shared with a secret counts as carrying it; a shorter secret counts when it appears whole. */
export const SECRET_RUN_CHARACTERS = 6;
const SHORT_SECRET_CHARACTERS = 3;

/** Whether her free text repeats a run of something that must reach nobody but the owner. Whitespace is ignored. */
export function carriesSecret(text: string | null | undefined, secrets: readonly string[] | undefined): boolean {
  if (!text || !secrets?.length) return false;
  const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const candidate = compact(text);
  return secrets.some(secret => {
    const words = compact(secret);
    if (words.length < SECRET_RUN_CHARACTERS) return words.length >= SHORT_SECRET_CHARACTERS && candidate.includes(words);
    for (let index = 0; index + SECRET_RUN_CHARACTERS <= words.length; index += 1) {
      if (candidate.includes(words.slice(index, index + SECRET_RUN_CHARACTERS))) return true;
    }
    return false;
  });
}
