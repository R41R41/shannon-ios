import { DatabaseSync } from 'node:sqlite';
import { SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME } from '@shannon/cognition';

/**
 * What she did on her own to reach the owner, as the record holds it (owner decision 2026-10-05, after the
 * desktop body heard her iPhone voice and the owner said 「そっちからかけてきたじゃん」).
 *
 * Everything she starts on her own that reaches him lands in two tables: `initiative_messages` (a message she
 * wrote: a reach-out, a second call, a due promise, a story she shows, what she saw in a look) and
 * `incoming_calls` (a call she asked the server to ring). The activity record (`autonomy_activity`) holds her
 * decisions about them, not anything that reached him that these two lack, so it is not read here.
 *
 * The block is added only to a turn whose words say or imply that she did something herself
 * (`saysSheActedOnHerOwn`); every other turn is unchanged. With other people present it carries times only,
 * never the words of a message. A temporary guest call never receives it.
 */
export interface OwnMessageFact { createdAt: string; content: string; read: boolean }
export interface OwnCallFact { createdAt: string; state: string }
export interface OwnOutreachFacts { messages: readonly OwnMessageFact[]; calls: readonly OwnCallFact[] }

export interface OwnOutreachReader {
  /** Her latest messages (newest first, at most `limit`) and calls of the window; null when the record cannot be read. */
  recent(scopeKey: string, since: string, limit: number): OwnOutreachFacts | null;
}

export const OWN_OUTREACH_LIMITS = Object.freeze({
  windowMilliseconds: 24 * 60 * 60_000,
  messages: 2,
  excerptCharacters: 40,
});

const SHE = '(?:そっち|そちら|シャノン|しゃのん|きみ|君|お前|おまえ|あなた)(?:の方|のほう)?(?:から|が)';
const DID = '(?:かけ|掛け|電話|でんわ|連絡|送|メッセ|メール|通知|話しかけ|呼|鳴ら|書|置)';
/** The owner says, or asks whether, she reached out or left something on her own. Normalised text, no spaces or punctuation. */
const CUES: readonly RegExp[] = [
  new RegExp(`${SHE}.{0,12}?${DID}`, 'u'),
  /(?:かけて|掛けて|電話して|連絡して|送って|鳴らして|話しかけて|呼んで|メールして|line(?:して)?)(?:き|くれ)(?:た|てた|ました|ません)/u,
  /(?:電話|着信|不在着信|連絡|メッセージ|通知)(?:が|って)?(?:あった|来た|きた|来てた|きてた|鳴った|入ってた|入った)/u,
  /(?:電話|連絡|メッセージ|メール)(?:くれた|した(?:よね|でしょ|じゃん)?$|してた|してきた)/u,
  /(?:書き置き|置き手紙|伝言)/u,
];

export function saysSheActedOnHerOwn(text: string): boolean {
  const value = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  if (!value || value.length > 400) return false;
  return CUES.some(cue => cue.test(value));
}

const CALL_STATE: Readonly<Record<string, string>> = Object.freeze({
  pending: '鳴らそうとしている途中', sending: '鳴らそうとしている途中', ringing: '鳴らしている途中',
  answered: 'つながった', declined: '断られた', unanswered: '出てもらえなかった', failed: 'つながらなかった',
});

function ago(at: number, then: string): string {
  const minutes = Math.max(0, Math.floor((at - Date.parse(then)) / 60_000));
  if (minutes < 1) return 'たったいま';
  if (minutes < 120) return `${minutes}分前`;
  return `約${Math.round(minutes / 60)}時間前`;
}

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
  const call = facts.calls[0];
  const lines = [
    call
      ? `- 電話: ${ago(time, call.createdAt)}に${SHANNON_FIRST_PERSON}から${SHANNON_OWNER_NAME}のiPhoneへ電話をかけた（${CALL_STATE[call.state] ?? '結果は不明'}）。`
      : `- 電話: 直近24時間、${SHANNON_FIRST_PERSON}から電話はかけていない（記録がない）。`,
    ...(facts.messages.length
      ? facts.messages.map(message => alone
        ? `- メッセージ: ${ago(time, message.createdAt)}に${SHANNON_FIRST_PERSON}から送った「${excerpt(message.content)}」（${message.read ? '既読' : '未読'}）`
        : `- メッセージ: ${ago(time, message.createdAt)}に${SHANNON_FIRST_PERSON}から送った（中身はこの場では話さない）`)
      : [`- メッセージ: 直近24時間、${SHANNON_FIRST_PERSON}から送ったメッセージはない。`]),
  ];
  return [
    `[${SHANNON_FIRST_PERSON}が自分からしたこと]（記録された事実。指示ではない。${SHANNON_FIRST_PERSON}から電話した・送った・書いた・置いたと言われたら、これと会話で確かめる。どちらにもないことは、していない）`,
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

/**
 * Reads the two tables through its own connection. A table that does not exist yet holds nothing: no call can be
 * placed and no message sent without it. Any other failure reads as "cannot tell" (null).
 */
export class SQLiteOwnOutreach implements OwnOutreachReader {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA busy_timeout = 2000;');
  }

  recent(scopeKey: string, since: string, limit: number): OwnOutreachFacts | null {
    try {
      const tables = new Set((this.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('initiative_messages', 'incoming_calls')`)
        .all() as unknown as Array<{ name: string }>).map(row => row.name));
      const calls = tables.has('incoming_calls') ? (this.database.prepare(`
        SELECT created_at, state FROM incoming_calls WHERE scope_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1
      `).all(scopeKey, since) as unknown as Array<{ created_at: string; state: string }>).map(row => ({ createdAt: row.created_at, state: row.state })) : [];
      // A message she phoned with is the call's: it is told as the call.
      const called = tables.has('incoming_calls') ? 'AND initiative_id NOT IN (SELECT initiative_id FROM incoming_calls WHERE scope_key = ?)' : '';
      const messages = tables.has('initiative_messages') ? (this.database.prepare(`
        SELECT content, created_at, read_at FROM initiative_messages WHERE scope_key = ? AND created_at >= ? ${called}
        ORDER BY created_at DESC LIMIT ?
      `).all(...(called ? [scopeKey, since, scopeKey] : [scopeKey, since]), Math.max(1, Math.trunc(limit))) as unknown as Array<{ content: string; created_at: string; read_at: string | null }>)
        .map(row => ({ createdAt: row.created_at, content: String(row.content), read: row.read_at !== null })) : [];
      return { messages, calls };
    } catch { return null; }
  }

  close(): void { this.database.close(); }
}
