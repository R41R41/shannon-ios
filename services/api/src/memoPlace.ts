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
/** 「Aetherに」「Aetherで」「エーテルにお願いします」: only as the answer to her question where. */
const BARE_ANSWER = new RegExp(`^${AETHER_PLACE}(?:に|へ|で)?(?:お願い(?:します)?|して|作って|残して)?(?:ください)?$`, 'iu');

export type AetherNoteRequest = { content: string } | { bare: 'request' | 'answer' };

/** A request that names Aether as the place; null for everything else, an unqualified 「ノートに残して」 included. */
export function aetherNoteRequest(text: string): AetherNoteRequest | null {
  const content = text.match(CONTENT_FIRST)?.[1] ?? text.match(PLACE_FIRST)?.[1];
  if (content) return { content };
  if (BARE_REQUEST.test(text)) return { bare: 'request' };
  return BARE_ANSWER.test(text) ? { bare: 'answer' } : null;
}

/** The words name Aether as a place: the product (Latin or Japanese) or 「ノートアプリ」. */
export function namesAether(words: string): boolean {
  return mentionsSuiteProduct(words, 'aether') || /ノートアプリ/u.test(words);
}

const MEMO_VERB = '(?:作って|作成して|書いて|残して|保存して|して|しといて|取って|とって)(?:おいて|ください|ほしい|くれる|もらえる|ね|よ)*';
const MEMO_REQUEST = new RegExp(`(?:メモ|ノート)(?:を|に)?${MEMO_VERB}(?=$|[、。！!？?\\s])`, 'u');

/** A request to make, write or keep a memo or a note: 「メモを作って」「ノートに残して」「メモしておいて」. */
export function asksForMemo(words: string): boolean {
  return MEMO_REQUEST.test(words.trim());
}

/** A memo request that does not name Aether: nothing of Aether is pushed at her, the model decides or asks. */
export function memoNotForAether(words: string): boolean {
  return asksForMemo(words) && !namesAether(words);
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

/** A short answer that names one of the places. */
export function namesMemoPlace(words: string): boolean {
  const said = words.normalize('NFKC').replace(/[\s\p{P}]/gu, '');
  return said.length > 0 && said.length <= 30 && (/書斎|フォルダ|PC|パソコン/iu.test(said) || namesAether(said));
}
