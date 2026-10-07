/**
 * The turn verifier (Syzygy ADR-0008 stage 2, step 4, `SHANNON_TURN_VERIFY`; ADR-0008 §3 完了の確かめ方: 「終わった」は自己申告に
 * しない). Core: response path.
 *
 * 1. Deterministic, in every turn that offered her a write tool: a sentence of her reply that says she wrote, saved, made or
 *    sent something of hers (a memo, a story, a file, a document, a proposal) must be matched by a write tool that worked in
 *    this turn. When none did, her reply gets one fixed line in her voice that says so (`WRITE_CLAIM_CORRECTION`); the words
 *    she already said stand.
 * 2. Optional, text only, when the difficulty policy asked for verification and at least 15 s of the turn are left: a luna
 *    checker (`TurnChecker`) reads her reply and the closed results of her tools (names, worked or not) and answers
 *    `consistent`, `claims_unsupported` or `unclear`. `claims_unsupported` adds the same line.
 *
 * Its verdict is also a closed signal of the turn's G (owner answer I-3). It never stores what she said.
 */
export interface TurnToolResult { name: string; effect: 'read' | 'write'; ok: boolean }

export type TurnVerdict = 'ok' | 'claim_without_write' | 'checker_flagged';

export const WRITE_CLAIM_CORRECTION = 'ごめんなさい、ライ氏。いま「書いた・残した」と言いましたが、道具の結果を見ると、まだできていません。';

/** A thing of hers or his that a write would change. */
const OBJECT = /(?:メモ|ノート|物語|お話|下書き|原稿|書斎|ファイル|フォルダ|文書|ドキュメント|Aether|エーテル|提案|保存)/u;
/** A past-tense claim of having written, saved, made or sent it, not asked as a question. */
const CLAIM = /(?:保存|書き込み|書き換え|作成|追記|記録|追加|更新|送信)(?:しました|しておきました|済みです|完了しました)|(?:書き|書いて|残し|残して|作り|作って|置き|置いて|メモし|直し|直して|送り|送って)(?:ました|おきました)/u;
const QUESTION = /(?:か|かな|でしょうか)[。？?]?$|[？?]$/u;

/** The sentences of a reply that claim a write of hers. */
export function writeClaims(reply: string): string[] {
  return reply.split(/(?<=[。！!？?\n])/u).map(sentence => sentence.trim()).filter(sentence => OBJECT.test(sentence) && CLAIM.test(sentence) && !QUESTION.test(sentence)
    && !/(?:ませんでした|できなかった|できませんでした|ていません)/u.test(sentence));
}

/** The deterministic check: a claim of a write with no write that worked in this turn. */
export function verifyWriteClaims(reply: string, results: readonly TurnToolResult[]): TurnVerdict {
  if (!writeClaims(reply).length) return 'ok';
  return results.some(result => result.effect === 'write' && result.ok) ? 'ok' : 'claim_without_write';
}

/** The reply as she says it after the verdict: unchanged, or with the fixed line after it. */
export function verifiedReply(reply: string, verdict: TurnVerdict): string {
  return verdict === 'ok' || reply.includes(WRITE_CLAIM_CORRECTION) ? reply : `${reply.trimEnd()}\n${WRITE_CLAIM_CORRECTION}`;
}

/** The optional luna checker. Never throws: a failure is `unclear`. */
export interface TurnChecker {
  check(scopeKey: string, reply: string, results: readonly TurnToolResult[]): Promise<'consistent' | 'claims_unsupported' | 'unclear'>;
}

/** The luna checker runs only with this much of the turn left. */
export const TURN_CHECKER_MINIMUM_MILLISECONDS = 15_000;
