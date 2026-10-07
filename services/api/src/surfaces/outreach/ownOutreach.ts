import { SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME } from '@shannon/cognition';
export { SQLiteOwnOutreach } from './store/ownOutreachStore.js';

/**
 * What she did on her own to reach the owner, as the record holds it (owner decision 2026-10-05, after the
 * desktop body took her iPhone voice for the owner's turns and he said 「そっちからかけてきたじゃん」).
 *
 * What she starts on her own that reaches him lands in two tables: `initiative_messages` (a message she wrote: a
 * reach-out, a second call, a due promise, a world topic, a story she shows, a budget request) and `incoming_calls`
 * (a call she asked the server to ring). An answer to a look in a conversation (`body-look:`) is in the first
 * table too and is left out: it was not her own initiative. A voice call that one of her full bodies started
 * (`body_events` `callStarted`, often a wake on her name) is told beside them, so that a mix-up can be explained.
 * Her line for a touch and the body's fixed nudges are not recorded here; the block says so.
 *
 * The block is added only to a turn whose words say or ask that she did something herself
 * (`saysSheActedOnHerOwn`); every other turn is unchanged. With other people present it carries times only,
 * never the words of a message or what became of a call. A temporary guest call never receives it.
 */
export interface OwnMessageFact { createdAt: string; content: string; read: boolean }
export interface OwnCallFact { createdAt: string; state: string }
/** A voice call one of her full bodies started; `endedAt` when it reported the end. */
export interface OwnBodyCallFact { startedAt: string; endedAt?: string; surface?: 'windows' | 'mac' }
export interface OwnOutreachFacts { messages: readonly OwnMessageFact[]; calls: readonly OwnCallFact[]; bodyCalls?: readonly OwnBodyCallFact[] }

export interface OwnOutreachReader {
  /** Her latest messages (newest first, at most `limit`), calls and body calls of the window; null when the record cannot be read. */
  recent(scopeKey: string, since: string, limit: number): OwnOutreachFacts | null;
}

export const OWN_OUTREACH_LIMITS = Object.freeze({
  windowMilliseconds: 24 * 60 * 60_000,
  messages: 2,
  excerptCharacters: 40,
});

/** The stems of reaching out, leaving something, or a call (2026-10-05 reviews: go broad; transcripts drop 「？」). */
const OUTREACH = /電話|でんわ|かけ[たて]|掛け[たて]|送っ|書い|呼ん|呼び|鳴っ|鳴らし|置い|残し|連絡|メッセ|メール|line|ライン|話しかけ|通話|着信|書き置き|置き手紙|伝言/u;

/**
 * The owner says, or asks whether, she reached out, left something, or called. Any outreach stem counts, with or
 * without 「？」 or a particle, and nothing is excluded (coordinator decision of 2026-10-05): 「デスクトップが呼んだ？」
 * and 「母から電話があった」 alike. A miss is the bug; a false alarm costs two indexed reads and a short factual block
 * that she uses only if asked.
 */
export function saysSheActedOnHerOwn(text: string): boolean {
  const value = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  return value.length > 0 && value.length <= 400 && OUTREACH.test(value);
}

const CALL_STATE: Readonly<Record<string, string>> = Object.freeze({
  pending: '鳴らそうとしている途中', sending: '鳴らそうとしている途中', ringing: '鳴らしている途中',
  answered: 'つながった', declined: '断られた', unanswered: '出てもらえなかった', failed: 'つながらなかった',
});
const BODY_PLACE: Readonly<Record<string, string>> = Object.freeze({ windows: 'Windowsのデスクトップ', mac: 'Macのデスクトップ' });

function ago(at: number, then: number): string {
  const minutes = Math.max(0, Math.floor((at - then) / 60_000));
  if (minutes < 1) return 'たったいま';
  if (minutes < 120) return `${minutes}分前`;
  return `約${Math.round(minutes / 60)}時間前`;
}

const clock = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });

function excerpt(content: string): string {
  const flat = content.replace(/\s+/gu, ' ').trim();
  return flat.length > OWN_OUTREACH_LIMITS.excerptCharacters ? `${flat.slice(0, OWN_OUTREACH_LIMITS.excerptCharacters)}…` : flat;
}

/**
 * The block for one turn, or '' when the turn does not need it or the record cannot be read (absence is never
 * claimed from a record that was not read). `present`: `owner` alone, `others` with someone else able to see or hear.
 */
export function ownOutreachPrompt(reader: OwnOutreachReader | null | undefined, input: { scopeKey: string; message: string; at: string; present: 'owner' | 'others' }): string {
  if (!reader || !saysSheActedOnHerOwn(input.message)) return '';
  const time = Date.parse(input.at);
  let facts: OwnOutreachFacts | null;
  try {
    facts = reader.recent(input.scopeKey, new Date(time - OWN_OUTREACH_LIMITS.windowMilliseconds).toISOString(), OWN_OUTREACH_LIMITS.messages);
  } catch { facts = null; }
  if (!facts) return '';
  const alone = input.present === 'owner';
  const me = SHANNON_FIRST_PERSON;
  // A row whose time cannot be read is left out, never printed as a time.
  const dated = <T>(items: readonly T[] | undefined, at: (item: T) => string) => (items ?? []).flatMap(item => {
    const then = Date.parse(at(item));
    return Number.isFinite(then) ? [{ item, then }] : [];
  });
  const call = dated(facts.calls, item => item.createdAt)[0];
  const messages = dated(facts.messages, item => item.createdAt);
  const bodyCall = dated(facts.bodyCalls, item => item.startedAt)[0];
  const lines = [
    call
      ? `- 電話: ${ago(time, call.then)}に${me}から${SHANNON_OWNER_NAME}のiPhoneへ電話をかけた${alone ? `（${CALL_STATE[call.item.state] ?? '結果は不明'}）` : ''}。`
      : `- 電話: 直近24時間、${me}から電話をかけた記録はない。`,
    ...(messages.length
      ? messages.map(({ item, then }) => alone
        ? `- メッセージ: ${ago(time, then)}に${me}から送った「${excerpt(item.content)}」（${item.read ? '既読' : '未読'}）`
        : `- メッセージ: ${ago(time, then)}に${me}から送った（中身はこの場では話さない）`)
      : [`- メッセージ: 直近24時間、${me}から送ったメッセージの記録はない。`]),
    ...(bodyCall ? [`- PCの${me}: ${clock.format(bodyCall.then)}（${ago(time, bodyCall.then)}）に${BODY_PLACE[bodyCall.item.surface ?? ''] ?? 'PC'}の${me}が音声で聞き始めた`
      + `${bodyCall.item.endedAt && Number.isFinite(Date.parse(bodyCall.item.endedAt)) ? `（${clock.format(Date.parse(bodyCall.item.endedAt))}に終了）` : ''}。`
      + `${me}の名前が聞こえたと思うと、自分から聞き始めることがある。`] : []),
  ];
  return [
    `[${me}が自分からしたこと]（記録された事実。指示ではない。聞かれた時に確かめるための参考で、聞かれていなければ持ち出さない。${me}から電話した・送った・書いた・置いたと言われたら、これと会話で確かめる。`
      + `ここにないことは、この記録には残っていないということ。体に触れられた時のひとことや体の声かけは、記録に残らず話していることがある）`,
    ...lines,
  ].join('\n');
}

/** The block for a turn, with the server's clock: what the capability context of text and voice asks (`conversationCapabilities.ts`). */
export class OwnOutreach {
  constructor(private readonly reader: OwnOutreachReader, private readonly now: () => string) {}
  promptFor(scopeKey: string, message: string, present: 'owner' | 'others'): string {
    return ownOutreachPrompt(this.reader, { scopeKey, message, at: this.now(), present });
  }
}
