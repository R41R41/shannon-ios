/**
 * The turn verifier (Syzygy ADR-0008 stage 2, step 4, `SHANNON_TURN_VERIFY`; ADR-0008 §3 完了の確かめ方: 「終わった」は自己申告に
 * しない). Core: response path.
 *
 * 1. Deterministic, in every turn that offered her a write tool: a sentence of her reply that says she wrote, saved, made or
 *    sent something of hers must match a successful write in this turn. Folder, Aether and Minecraft results also carry
 *    their native outcome/action/target: acceptance cannot prove completion, and an explicit other target cannot match.
 *    Unsupported claims add one fixed line in her voice; the words
 *    she already said stand.
 * 2. Optional, text only, when the difficulty policy asked for verification and at least 15 s of the turn are left: a luna
 *    checker (`TurnChecker`) reads her reply and the closed results of her tools (names, worked or not) and answers
 *    `consistent`, `claims_unsupported` or `unclear`. `claims_unsupported` adds the same line.
 *
 * Its verdict is also a closed signal of the turn's G (owner answer I-3). It never stores what she said.
 */
import type { ToolExecutionEvidence } from '../../contracts/toolEvidenceContract.js';
export interface TurnToolResult { name: string; effect: 'read' | 'write'; ok: boolean; evidence?: ToolExecutionEvidence }

export type TurnVerdict = 'ok' | 'claim_without_write' | 'checker_flagged';

export const WRITE_CLAIM_CORRECTION = 'ごめんなさい、ライ氏。いま「書いた・残した」と言いましたが、道具の結果を見ると、まだできていません。';

/** A thing of hers or his that a write would change. */
const OBJECT = /(?:メモ|ノート|物語|お話|下書き|原稿|書斎|ファイル|フォルダ|文書|ドキュメント|Aether|エーテル|提案|保存)/u;
/** A past-tense claim of having written, saved, made or sent it, not asked as a question. */
const CLAIM = /(?:保存|書き込み|書き換え|作成|追記|記録|追加|更新|送信)(?:しました|しておきました|済みです|完了しました)|(?:書き|書いて|残し|残して|作り|作って|置き|置いて|メモし|直し|直して|送り|送って)(?:ました|おきました)/u;
const QUESTION = /(?:か|かな|でしょうか)[。？?]?$|[？?]$/u;
const MINECRAFT_OBJECT = /(?:マイクラ|Minecraft|マインクラフト|サーバー|ワールド)/iu;
const ACTION_CLAIM = /(?:起動|停止|ログイン|ログアウト|完了|終了|採掘|キャンセル|討伐)(?:しました|済みです)|(?:集め|建て|終わり|止め|倒し|取り消し)(?:ました|ておきました)|昼に(?:しました|しておきました)/u;
const NEGATED = /(?:ませんでした|できなかった|できませんでした|ていません|まだ終わっていません)/u;

/** The sentences of a reply that claim a write of hers. */
export function writeClaims(reply: string, nativeEvidence = true): string[] {
  if (!nativeEvidence) return reply.split(/(?<=[。！!？?\n])/u).map(sentence => sentence.trim()).filter(sentence =>
    OBJECT.test(sentence) && CLAIM.test(sentence) && !QUESTION.test(sentence) && !NEGATED.test(sentence));
  // A failed second action cannot negate an affirmative claim before 「しましたが、」.
  return reply.split(/(?<=[。！!？?\n])/u).flatMap(sentence => sentence.split(/(?<=ました|です|済み)(?:が|けど|ものの)[、,]?|[、,](?:しかし|一方|ただし)[、,]?/u))
    .map(sentence => sentence.trim()).filter(sentence =>
    (OBJECT.test(sentence) && CLAIM.test(sentence) || MINECRAFT_OBJECT.test(sentence) && (CLAIM.test(sentence) || ACTION_CLAIM.test(sentence)))
    && !QUESTION.test(sentence) && !NEGATED.test(sentence));
}

/** Narrow supported-domain checks. Unrecognised prose and legacy executors still use the existing write-success rule. */
function domainMatches(claim: string, name: string): boolean {
  if (MINECRAFT_OBJECT.test(claim)) return name.startsWith('minecraft.');
  if (name.startsWith('minecraft.')) return false;
  if (/提案/u.test(claim)) return name === 'aether.propose';
  if (name === 'aether.propose') return false;
  if (/(?:Aether|エーテル)/iu.test(claim)) return name.startsWith('aetherFolder.');
  if (/(?:ファイル|PC|Mac|パソコン)/iu.test(claim)) return name.startsWith('folder.');
  return true;
}

/** Only quotes grammatically attached to a target noun are matched: quoted body/goal text is not an identifier. */
function explicitTargets(claim: string): string[] {
  return [...claim.matchAll(/(?:ファイル|文書|ドキュメント|ノート|サーバー)\s*「([^」]+)」|「([^」]+)」(?:のファイル|の文書|のノート|のサーバー)|\bid:\s*([A-Za-z0-9_:-]+)/giu)]
    .map(match => (match[1] ?? match[2] ?? match[3])!.normalize('NFC'));
}

function actionMatches(claim: string, evidence: ToolExecutionEvidence): boolean {
  if (evidence.target.kind === 'minecraft_server') {
    if (!evidence.receiptId || evidence.receiptId !== evidence.operationId || !evidence.target.id) return false;
    // A start or stop verb wins over 「昼」 (「昼にサーバーを起動しました」 is a start; review P3-3).
    const wanted = /ログアウト/u.test(claim) ? 'logout' : /ログイン/u.test(claim) ? 'login' : /起動/u.test(claim) ? 'start'
      : /停止|止め/u.test(claim) ? 'stop' : /昼|時刻/u.test(claim) ? 'set_day' : null;
    return wanted !== null && wanted === evidence.action;
  }
  if (evidence.target.kind === 'minecraft_request') return evidence.action === 'cancel'
    ? /取消|取り消|キャンセル|停止|止め/u.test(claim) && !/(?:完了|採掘|討伐|作成|更新|保存)(?:しました|済みです)|(?:集め|建て|倒し)(?:ました|ておきました)/u.test(claim)
    : evidence.action === 'request' && queuedReceiptClaim(claim, evidence);
  if (evidence.target.kind === 'aether_proposal') return /提案/u.test(claim);
  const wanted = /作成|作って|作りました/u.test(claim) ? 'create' : /更新|書き換|直して/u.test(claim) ? 'update' : null;
  return wanted === null || wanted === evidence.action;
}

function supportsClaim(claim: string, result: TurnToolResult): boolean {
  if (!result.ok || result.effect !== 'write' || !domainMatches(claim, result.name)) return false;
  const evidence = result.evidence;
  if (!evidence) return true;
  if (evidence.outcome === 'failed' || evidence.outcome === 'unknown' || !actionMatches(claim, evidence)) return false;
  if (evidence.outcome === 'queued' && !queuedReceiptClaim(claim, evidence)) return false;
  const known = [evidence.target.id, ...evidence.labels ?? []].filter((id): id is string => !!id).map(id => id.normalize('NFC'));
  return explicitTargets(claim).every(target => known.includes(target));
}

/** Acceptance claims have their own closed verb set. Merely mentioning an earlier request never proves completion. */
function queuedReceiptClaim(claim: string, evidence: ToolExecutionEvidence): boolean {
  const object = evidence.action === 'propose' ? /提案/u : /依頼|頼みごと|リクエスト|停止要求/u;
  return object.test(claim) && /(?:送信|送り|渡し|受け付け|受付)(?:しました|ました|済みです)/u.test(claim)
    && !/(?:保存|作成|更新|追加|書き換え|起動|停止|ログイン|ログアウト|完了|終了|採掘)(?:しました|済みです)|(?:集め|建て|倒し|討伐し)(?:ました|ておきました)/u.test(claim);
}

/** Every detected claim must match its domain, exact explicit target and native terminal outcome when available. */
export function verifyWriteClaims(reply: string, results: readonly TurnToolResult[]): TurnVerdict {
  return writeClaims(reply).every(claim => results.some(result => supportsClaim(claim, result))) ? 'ok' : 'claim_without_write';
}

/** The reply as she says it after the verdict: unchanged, or with the fixed line after it. */
export function verifiedReply(reply: string, verdict: TurnVerdict): string {
  const correction = MINECRAFT_OBJECT.test(reply) ? 'ごめんなさい、ライ氏。操作が完了したように伝えましたが、元の実行結果では、まだその完了を確認できていません。' : WRITE_CLAIM_CORRECTION;
  return verdict === 'ok' || reply.includes(correction) ? reply : `${reply.trimEnd()}\n${correction}`;
}

/** The optional luna checker. Never throws: a failure is `unclear`. */
export interface TurnChecker {
  check(scopeKey: string, reply: string, results: readonly TurnToolResult[]): Promise<'consistent' | 'claims_unsupported' | 'unclear'>;
}

/** The luna checker runs only with this much of the turn left. */
export const TURN_CHECKER_MINIMUM_MILLISECONDS = 15_000;
