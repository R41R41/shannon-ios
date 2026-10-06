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
 * What stays protected is what leaves her head towards others. `ownerPrivateRule` is the one place that says what she
 * may do with owner-private material: whenever it is in a prompt, or may have shaped what a prompt is given, the
 * prompt carries its line.
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
   * For what she writes in her study (a story, a note; owner decision 2026-10-02: she may write about him and the people he
   * knows): the same without anything that must reach nobody else, unmarked. Null when there is nothing.
   */
  forWriting(scopeKey: string, at: string, topic: string): OwnerContextBlock | null;
  /**
   * For a message she writes to the owner: the same, without anything that must never reach anyone else, because her words
   * may be seen or heard beyond him. `others`: someone else is present now, and each protected line carries the marker a
   * conversation with other people present uses.
   */
  forMessage(scopeKey: string, at: string, topic: string, others: boolean): OwnerContextBlock | null;
}

export const OWNER_CONTEXT_TITLE = `${SHANNON_OWNER_NAME}のこと・最近のふたりのこと`;
export const OWNER_CONTEXT_HEADER = `[${OWNER_CONTEXT_TITLE}]（${SHANNON_OWNER_NAME}と二人で話す時にボクが思い出せること。ほかの人には見せない）`;

/** The block as her writing is given it: without anything that must reach nobody but the owner. */
export const OWNER_CONTEXT_WRITING_HEADER = `[${OWNER_CONTEXT_TITLE}]（ボクが覚えていること。書く材料にしてよい）`;
/** In her thinking, in front of a line that must reach nobody but the owner: it is hers to know and never to write down. */
export const OWNER_CONTEXT_SECRET_MARK = '【内緒】';
/** The rule for the owner's upcoming items, while she may write about him. */
export const OWNER_CONTEXT_UPCOMING_THINKING_RULE = `- 「${SHANNON_OWNER_NAME}のこれから」は、${SHANNON_OWNER_NAME}が見せてくれているカレンダーの予定、ボクが覚えている期日つきの約束、Voyagerの期限つきタスク。話しかけるかどうかを考える材料にしてよい。`;

/** Replaces the line of the thinking rules that says nothing of the owner's is given, while the block is. */
export const OWNER_CONTEXT_MATERIALS_LINE = `- 使ってよい材料は、下に渡されるものだけ。自分の台帳、自分のメモと下書き、公開されている読み物、読者の反応、そして「${OWNER_CONTEXT_TITLE}」。そこにないことを、思い出したふりをして書かない。`;
/** Replace the lines of the story and note rules that say nothing of the owner's is given or used, while her writing may draw on it. */
export const OWNER_CONTEXT_DRAFT_MATERIALS = `- 材料は下に渡されたものだけ。自分の台帳、自分のメモ、そして「${OWNER_CONTEXT_TITLE}」。そこにないことを、思い出したふりをして書かない。`;
export const OWNER_CONTEXT_REVISE_MATERIALS = '- 材料は下に渡されたものだけ。そこにないことを、思い出したふりをして書かない。';
export const OWNER_CONTEXT_NOTE_PEOPLE = '- 読んだページに出てくる、知らない人の噂や個人情報は書かない。';
/** What she saw of the room, while she may write about the owner: she may write it; other people and text on screens stay out, as when she speaks of a look. */
export const OWNER_CONTEXT_SEEN_THINKING_RULE = '- メモのうち「見たこと」は、体のカメラで見た持ち主の部屋と持ち主のこと。次に何をするか考える材料にしてよいし、物語やメモに書いてもよい。写っていたほかの人のことと、画面や書類の文字は書かない。';
export const OWNER_CONTEXT_SEEN_STORY_RULE = '- メモのうち「見たこと」は、体のカメラで見た持ち主の部屋と持ち主のこと。見たとおりに物語に書いてよい。写っていたほかの人のことと、画面や書類の文字は書かない。';
/** Replaces the line of the message rules that says no conversation is given, while the block is. */
export const OWNER_CONTEXT_MESSAGE_MATERIALS = `下の「${OWNER_CONTEXT_TITLE}」にないことを、思い出したふりをしない。`;

/**
 * The output rule for owner-private material, in one place. `present`: such material is in this prompt, or may
 * have shaped what this prompt is given (an idea or a pursuit she wrote with it in front of her). Null when not:
 * the prompt is then what it was.
 *
 * By the owner's decision of 2026-10-02 (「ボクのことを物語やメモに書いていい。友達のことも」) the rule for her own writing is a
 * permission: she may write about him and the people he knows, by name, as they are. What stays: secrets go nowhere, what
 * she writes is read by the owner, and showing it to anyone else needs his approval (ADR-0002), except reading it aloud in a
 * conversation with others present (Syzygy ADR-0007 revised, 2026-10-06; `TOOLS_OTHERS_INSTRUCTIONS`).
 * - `thinking`: she may think with it and write about it; secrets nowhere; she reads only pages she was shown.
 * - `story`: a draft or a revision. She may write about him and his people; secrets not.
 * - `note`: the same for a note.
 * - `message`: a message to the owner. She may touch on it, lightly, one thing at most.
 */
export function ownerPrivateRule(kind: 'thinking' | 'story' | 'note' | 'message', present: boolean): string | null {
  if (!present) return null;
  if (kind === 'thinking') {
    return `- 「${OWNER_CONTEXT_TITLE}」は、${SHANNON_OWNER_NAME}と二人の時にボクが思い出せること。次に何をするか考える材料にしてよいし、${SHANNON_OWNER_NAME}に話しかけるきっかけにしてよい。物語やメモには、${SHANNON_OWNER_NAME}のことも、${SHANNON_OWNER_NAME}の友だちや周りの人のことも、名前を出してそのまま書いてよい（idea・aim・pursuits・text にも書いてよい）。ただし ${OWNER_CONTEXT_SECRET_MARK} の付いた行と、「内緒」「秘密」と言われたことは、考える時にだけ使う。言い換えても、thought にも reason にも query にも、どこにも書かない。ページの住所（url）も外に出る言葉なので、read で読むのは下の「読めそうな場所」にあるページだけ。`;
  }
  if (kind === 'note') {
    return `- メモには、${SHANNON_OWNER_NAME}のことも、${SHANNON_OWNER_NAME}の友だちや周りの人のことも、名前を出してそのまま書いてよい。メモは${SHANNON_OWNER_NAME}が読むもの。「内緒」「秘密」と言われたことは書かない。`;
  }
  if (kind === 'story') {
    return `- 物語には、${SHANNON_OWNER_NAME}のことも、${SHANNON_OWNER_NAME}の友だちや周りの人のことも、名前を出してそのまま書いてよい。書いたものを読むのは${SHANNON_OWNER_NAME}。ほかの人に見せるのは、${SHANNON_OWNER_NAME}がいいと言ってから。「内緒」「秘密」と言われたことは書かない。`;
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
