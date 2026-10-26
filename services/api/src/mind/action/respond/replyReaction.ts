import { isReactionEmoji } from '../../../contracts/conversationExtrasContract.js';

/**
 * Her own emoji reaction (owner request 2026-10-26: 「絵文字を付けられるようにしてほしい」; `docs/rich-chat-contract.md` §4). In a
 * turn where the person's message is shown with reactions (the app's own Talk while the owner alone reads it, a Discord message), her
 * structured reply has one more field, `reaction`: at most one emoji she puts on the message she is answering, shown under it as a
 * reaction (on Discord a real one). It rides the reply she already writes, so choosing one costs no tool call and no second round.
 */
/**
 * A plain string, not nullable: the provider compiles the reply's schema into a grammar whose size is limited and unpublished (a
 * request with 10 unions among other things was refused, `anthropicToolCapacity.ts`), so her reaction adds no union. Empty is none.
 */
export const REPLY_REACTION_SCHEMA = Object.freeze({
  type: 'string',
  description: '相手のいまのメッセージに付ける絵文字1つ（リアクション）。付けたい時だけ。付けない時（たいてい）は空文字',
});

/** Said once in the system of a turn that offers the field (the surface decides, not the turn: the app's Talk and Discord). */
export const REPLY_REACTION_INSTRUCTIONS = [
  '[メッセージに付ける絵文字]',
  '- reaction に絵文字を1つ書くと、相手のいまのメッセージにボクのリアクションとして付く（Discordなら本物のリアクション、アプリでは吹き出しの下）。',
  '- 笑った、うれしい、ぐっときた、びっくりした、了解、などの気持ちを一言より軽く返したい時にだけ使う。毎回は付けない。付けない時（たいてい）は空文字。',
  '- 返事の文の中でリアクションのことは言わない。絵文字1つだけで、文字や記号の組み合わせは書かない。',
].join('\n');

/** The field as the provider returned it: one emoji grapheme, or nothing. Never fails a turn. */
export function parsedReplyReaction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const emoji = value.trim();
  return isReactionEmoji(emoji) ? emoji : undefined;
}
