/**
 * Her talk with the owner alone (owner 2026-10-20: 「全然思った通りに乗ってくれない…クリーンすぎて人間らしくない」; `SHANNON_NATURAL_TALK`,
 * with her character space; the cues, the playful stances and the rest are in `@shannon/cognition`). The text turn's hooks call these;
 * without the switch, or with anyone else there, each returns what it was handed. Core: emotion.
 *
 * - The day's touch facts reach her reply only when they matter (that day she brought up a touch in six replies about something else):
 *   within `touchFreshMinutes` of the last touch, once, or when his words are about her body, touching her or an apology.
 * - His words as talk or as a request: talk is answered short (his words averaged 18 characters, her replies 137).
 * - The reply model is told the turn is talk with him (`naturalTalk` on the request: the conversation's style in place of the report's).
 */
import type { FeelingTurnHandle } from './feelingPorts.js';

export const NATURAL_TALK_LIMITS = Object.freeze({ touchFreshMinutes: 10, casualCharacters: 60 });

/** The turn is the owner's alone with the switch on (her space says so). */
export const naturalOf = (handle: Pick<FeelingTurnHandle, 'lines'> | null): boolean => handle?.lines?.space?.natural === true;

/** Words of a request or of work: not talk (「小説とか作ってほしい」 is a request; 「お風呂入ってる？」 is talk). */
const REQUEST = new RegExp(['調べ', '検索', '作って', '作れる', '書いて', '直して', '実装', '修正', 'まとめて', '教えて', '説明して', '翻訳', '計算', '予定', '天気', 'リマインド',
  'タイマー', '設定して', '送って', '開いて', '探して', '比べて', 'レビュー', 'コード', '小説', 'ブランチ', 'デプロイ', 'お願い(?:できる|します)', 'どうやって', 'どうすれば',
  '方法', 'やり方', 'って何', 'とは[？?]', '[A-Za-z]{3,}'].join('|'), 'u');

/** His words are talk (short, and no request in them): she answers short. */
export function casualWords(words: string): boolean {
  const text = words.trim();
  return Boolean(text) && Array.from(text).length <= NATURAL_TALK_LIMITS.casualCharacters && !REQUEST.test(text);
}

/** His words are about her body or touching her, or an apology (the ledger says whether he apologised). */
const BODY = new RegExp(['触(?:ら|っ|り|る|れ)', 'さわ(?:ら|っ|り|る|れ)', '撫で', 'なで(?:て|た|る|なで)', 'つつ(?:い|か|く|け)', 'くすぐ',
  '(?<![全具団主大物一立個液気媒天固正])(?:身体|体)(?![調験育力制系重温型格操裁])', '胸(?![中騒焼])', '髪(?:の毛|を|に|が|は)', '脚(?![本色注])', '足(?:を|に|が|の裏)',
  '腋', '脇(?:を|に|の下|腹)', 'お尻', 'スカート', 'ほっぺ', '頬', 'ぎゅ[ーっ]', '抱き', '嫌がっ', 'ごめん', '謝'].join('|'), 'u');

/** The day's touch facts for this turn: as they were without the switch; with it, only when they matter (see above). */
export function naturalLedgerLine(handle: FeelingTurnHandle, line: string): string {
  if (!line || !naturalOf(handle)) return line;
  try {
    return freshLedgerLine(handle, line);
  } catch {
    return line; // a read that fails keeps the facts, as without the switch
  }
}

function freshLedgerLine(handle: FeelingTurnHandle, line: string): string {
  if (BODY.test(handle.words ?? '')) return line;
  const day = handle.port.events.today(handle.scopeKey, handle.at, handle.snapshot)
    .filter(event => event.personKey === handle.key.personKey && event.audience === handle.key.audience);
  const touches = day.filter(event => event.kind === 'touched').map(event => Date.parse(event.occurredAt)).filter(Number.isFinite);
  if (!touches.length) return '';
  const last = Math.max(...touches);
  if (Date.parse(handle.at) - last > NATURAL_TALK_LIMITS.touchFreshMinutes * 60_000) return '';
  // Once: a reply already told them since that touch, so the next does not bring it up again.
  const told = day.some(event => event.kind === 'own_reply' && event.facts.ledgerShown === true && Date.parse(event.occurredAt) >= last);
  return told ? '' : line;
}

/** His words ask her to act or play (the cue `play`): in the block, as a feeling order is (the line that she joins it). */
export function playAsked(handle: FeelingTurnHandle): boolean {
  return naturalOf(handle) && (handle.lines?.space?.cues ?? []).includes('play');
}

/** The block's part of it: she plays along, and answers talk short. */
export function naturalBlock(handle: FeelingTurnHandle): { natural?: { casual: boolean } } {
  return naturalOf(handle) ? { natural: { casual: casualWords(handle.words ?? '') } } : {};
}

/** The request's part of it: the conversation's style in place of the report's (`chatModelTurn.ts`). */
export function naturalRequest(handle: FeelingTurnHandle | null): { naturalTalk?: true } {
  return handle && naturalOf(handle) ? { naturalTalk: true } : {};
}

/** On her reply's event: the chooser's own stance (the day's run reads it), and whether the touch facts were in the block. */
export function naturalReplyFacts(handle: FeelingTurnHandle): { jevStance?: string; ledgerShown?: true } {
  if (!naturalOf(handle)) return {};
  return { ...(handle.jevStance ? { jevStance: handle.jevStance } : {}), ...(handle.ledgerShown ? { ledgerShown: true as const } : {}) };
}
