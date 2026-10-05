import { mentionsSuiteProduct, suiteProductPattern } from '@shannon/cognition';

/**
 * Where a memo or a note goes (owner decision 2026-10-05). She has three places: her study (`study.*`, in Shannon's
 * database), her own folder on the owner's PC (`folder.*`), and Aether, where she only sends a proposal to its inbox
 * (`conversationCommands.ts`). No fixed rule sends an unqualified 「メモを作って」 or 「ノートに残して」 to one of them:
 * the Aether command needs Aether named, and otherwise the model chooses from his words and the recent talk, or asks
 * (`SHANNON_MEMO_PLACE_RULE`), and his answer is acted on.
 */
const AETHER = suiteProductPattern('aether').source;
const AETHER_PLACE = `(?:${AETHER}(?:の(?:ノート|メモ))?|ノートアプリ)`;
const SAVE = '(?:残して|保存して|して|書いて|入れて|送って|メモして)';
const QUOTED = '(?:[「"])?([\\s\\S]{1,6000}?)(?:[」"])?';

/** 「〜をAetherに残して」「〜をAetherのノートに保存して」「〜をノートアプリに入れて」. */
const CONTENT_FIRST = new RegExp(`^${QUOTED}を${AETHER_PLACE}(?:に|へ)${SAVE}$`, 'iu');
/** 「Aetherに牛乳を買うってメモして」「Aetherのノートにさっきの話を残して」. */
const PLACE_FIRST = new RegExp(`^${AETHER_PLACE}(?:に|へ)[、,\\s]*${QUOTED}(?:を|って|と)(?:メモ|ノート)?に?${SAVE}$`, 'iu');
/** 「Aetherにメモして」「Aetherに残して」: what he just said goes there. */
const BARE_REQUEST = new RegExp(`^${AETHER_PLACE}(?:に|へ)(?:メモ|ノート)?を?(?:${SAVE.slice(3, -1)}|作って)$`, 'iu');

export type AetherNoteRequest = { content: string } | { bare: 'request' | 'answer' };

/** A request that names Aether as the place; null for everything else, an unqualified 「ノートに残して」 included. */
export function aetherNoteRequest(text: string): AetherNoteRequest | null {
  const content = text.match(CONTENT_FIRST)?.[1] ?? text.match(PLACE_FIRST)?.[1];
  if (content) return { content };
  if (BARE_REQUEST.test(text)) return { bare: 'request' };
  // 「Aetherに」「Aetherでお願いします」: only as the answer to her question where (conversationCommands.ts).
  return answersWithPlace(text) && namesAether(text) ? { bare: 'answer' } : null;
}

/** The words name Aether as a place: the product (Latin or Japanese) or 「ノートアプリ」. */
export function namesAether(words: string): boolean {
  return mentionsSuiteProduct(words, 'aether') || /ノートアプリ/u.test(words);
}

const MEMO_VERB = '(?:作って|作成して|書いて|残して|保存して|して|しといて|取って|とって|っといて|っておいて|お願い(?:します)?|おねがい|よろしく)'
  + '(?:おいて|ください|ほしい|くれる|もらえる|ね|よ)*';
const MEMO_REQUEST = new RegExp(`(?:メモ|ノート)(?:を|に)?${MEMO_VERB}(?=$|[、。！!？?\\s])`, 'u');
/** 「ノートに書いて？」 asks; 「メモ作ってくれる？」 still requests. */
const ASKS_BACK = /[?？]\s*$/u;
const POLITE_REQUEST = /(?:くれる|くれない|もらえる|もらえない|ください|お願い(?:します)?|おねがい)[?？]\s*$/u;

/** A request to make, write or keep a memo or a note: 「メモを作って」「ノートに残して」「メモっといて」「メモお願い」. */
export function asksForMemo(words: string): boolean {
  const said = words.trim();
  return MEMO_REQUEST.test(said) && (!ASKS_BACK.test(said) || POLITE_REQUEST.test(said));
}

/** Words about a note or memo that already exists (「この前のメモ」「ノートに書いてあった」「メモの内容」). */
const EXISTING_NOTE = /(?:この前|(?<!名)前の|さっきの(?:メモ|ノート)|あの(?:メモ|ノート)|書いてあった|書いた(?:メモ|ノート|やつ|こと)|(?:メモ|ノート)の(?:内容|中身)|(?:メモ|ノート)(?:を|に)?(?:見|読|探|確認))/u;

/**
 * A memo request that does not name Aether and asks about no existing note: nothing of Aether is pushed at her, the
 * model decides or asks. A request that also asks about a note he wrote keeps the Aether notes context.
 */
export function memoNotForAether(words: string): boolean {
  return asksForMemo(words) && !namesAether(words) && !EXISTING_NOTE.test(words);
}

/** What a memo request asks to keep: 「明日10時に歯医者ってメモして」 → 「明日10時に歯医者」; 「メモを作って」 → ''. */
export function memoRequestContent(words: string): string | null {
  const match = words.trim().replace(/[。！!]$/u, '')
    .match(new RegExp(`^(?:[「"])?([\\s\\S]*?)(?:[」"])?(?:を|って|と)?(?:メモ|ノート)(?:を|に)?${MEMO_VERB}$`, 'u'));
  return match ? match[1]!.trim() : null;
}

/** Her reply asked where a memo or a note should go (「書斎・PCのフォルダ・Aetherのどこに作りますか？」). */
export function asksWhichPlace(reply: string): boolean {
  const last = reply.trim().split(/(?<=[。！!])/u).slice(-2).join('');
  const places = [/書斎/u, /フォルダ/u, new RegExp(AETHER, 'iu')].filter(place => place.test(last)).length;
  return places >= 2 && /どこ|どれ|どちら/u.test(last);
}

const PLACE_NAME = `(?:書斎|(?:PC|パソコン|自分)の?フォルダ|フォルダ|PC|パソコン|${AETHER}(?:のノート)?|ノートアプリ)`;
const PLACE_ANSWER = new RegExp(`^${PLACE_NAME}(?:に|で|へ)?(?:お願い|おねがい)?(?:します)?$`, 'iu');

/**
 * An answer that is only a place: a place name and at most に／で／お願い／します (「書斎に」「Aetherでお願いします」).
 * Anything else, a no (「書斎はやめて」「Aetherに入れないで」) or a question (「PCのフォルダって何？」), is not.
 */
export function answersWithPlace(words: string): boolean {
  const said = words.normalize('NFKC').trim();
  return !/[?？]/u.test(said) && PLACE_ANSWER.test(said.replace(/[\s、。,.!！]/gu, ''));
}
