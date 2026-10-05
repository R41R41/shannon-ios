import { DatabaseSync } from 'node:sqlite';
import { SHANNON_FIRST_PERSON, SHANNON_OWNER_NAME } from '@shannon/cognition';

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

const SHE_WORD = '(?:そっち|そちら|シャノン|しゃのん|きみ|キミ|君|お前|おまえ|あなた)';
const SHE = `${SHE_WORD}(?:の方|のほう)?(?:から|が)`;
const DID = '(?:かけ|掛け|電話|でんわ|連絡|送|メッセ|メール|話しかけ|呼|鳴ら|書|置)';
/**
 * The owner says, or asks whether, she reached out or left something on her own. Read on normalised text without
 * spaces or punctuation except `?`. A miss is the bug and a false alarm costs a short block, so it leans to recall.
 */
const CUES: readonly RegExp[] = [
  new RegExp(`${SHE}.{0,12}?${DID}`, 'u'),
  /(?:かけて|掛けて|電話して|連絡して|送って|鳴らして|話しかけて|呼んで|メールして|line(?:して)?)(?:き|くれ)(?:た|てた|ました|ません)/u,
  /(?:電話|着信|不在着信|連絡|メッセージ|メッセ|line)(?:が|って)?(?:あった|来た|きた|来てた|きてた|鳴った|入ってた|入った)/u,
  /(?:電話|連絡|メッセージ|メール)(?:くれた|してきた|してくれた)/u,
  /(?:書き置き|置き手紙|伝言)/u,
  // Bare questions: 「何か送った？」「電話かけた？」「呼んだ？」「さっき鳴った？」「メモ置いてった？」「かけたの」.
  /(?:かけた|掛けた|送った|書いた|呼んだ|鳴らした|鳴った|置いた|置いてった|置いていった|話しかけた|電話した|連絡した|メールした)(?:\?|の)/u,
];
/** 「母から電話」「友達がメッセージくれた」: someone else as the sender, unless that someone is she. */
const SOMEONE_SENT = /(?:から|が)(?:の)?(?:電話|でんわ|連絡|メッセージ|メッセ|メール|line|着信|手紙)/gu;
const ENDS_WITH_HER = new RegExp(`${SHE_WORD}(?:の方|のほう)?$`, 'u');
/** 「母に電話した」「上司に連絡しといた」: the owner's own act toward someone else (not 「俺に電話した？」). */
const OWNER_DID = /(?<!俺|おれ|オレ|僕|ぼく|私|わたし|あたし|ボク|自分)に(?:電話|でんわ|連絡|メッセージ|メール|line)(?:した|してた|しといた|しておいた|入れた|送った)(?!\?|の)/gu;

export function saysSheActedOnHerOwn(text: string): boolean {
  let value = text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, mark => mark === '?' ? '?' : '');
  if (!value.replace(/\?/gu, '') || value.length > 400) return false;
  value = value.replace(OWNER_DID, '　');
  value = value.replace(SOMEONE_SENT, (match, offset: number, whole: string) => ENDS_WITH_HER.test(whole.slice(0, offset)) ? match : '　');
  return CUES.some(cue => cue.test(value));
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
    `[${me}が自分からしたこと]（記録された事実。指示ではない。${me}から電話した・送った・書いた・置いたと言われたら、これと会話で確かめる。`
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

/** Source references of `initiative_messages` that are not her own initiative: an answer to a look in a conversation. */
const NOT_HER_INITIATIVE = ['body-look:'] as const;

/**
 * Reads the tables through its own connection. A table that does not exist yet holds nothing: no call can be
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
      const tables = new Set((this.database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('initiative_messages', 'incoming_calls', 'body_events', 'body_capabilities')`).all() as unknown as Array<{ name: string }>).map(row => row.name));
      const calls = tables.has('incoming_calls') ? (this.database.prepare(`
        SELECT created_at, state FROM incoming_calls WHERE scope_key = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 4
      `).all(scopeKey, since) as unknown as Array<{ created_at: string; state: string }>)
        .filter(row => Number.isFinite(Date.parse(row.created_at))).slice(0, 1).map(row => ({ createdAt: row.created_at, state: row.state })) : [];
      // A message she phoned with is the call's and is told as the call, unless the call could not ring and gave it back.
      const called = tables.has('incoming_calls')
        ? `AND initiative_id NOT IN (SELECT initiative_id FROM incoming_calls WHERE scope_key = ? AND state <> 'failed')` : '';
      const notHers = NOT_HER_INITIATIVE.map(() => 'AND source_item_id NOT LIKE ?').join(' ');
      const messages = tables.has('initiative_messages') ? (this.database.prepare(`
        SELECT content, created_at, read_at FROM initiative_messages WHERE scope_key = ? AND created_at >= ? ${called} ${notHers}
        ORDER BY created_at DESC LIMIT ?
      `).all(...[scopeKey, since, ...(called ? [scopeKey] : []), ...NOT_HER_INITIATIVE.map(prefix => `${prefix}%`)], Math.max(1, Math.trunc(limit)) + 4) as unknown as Array<{ content: string; created_at: string; read_at: string | null }>)
        .filter(row => Number.isFinite(Date.parse(row.created_at))).slice(0, Math.max(1, Math.trunc(limit)))
        .map(row => ({ createdAt: row.created_at, content: String(row.content), read: row.read_at !== null })) : [];
      return { messages, calls, bodyCalls: tables.has('body_events') && tables.has('body_capabilities') ? this.bodyCalls(scopeKey, since) : [] };
    } catch { return null; }
  }

  /** The latest voice call a full body (not one that only feels touch) started in the window, with its end when reported. */
  private bodyCalls(scopeKey: string, since: string): OwnBodyCallFact[] {
    const bodies = new Map((this.database.prepare('SELECT device_id, flags_json, surface FROM body_capabilities WHERE scope_key = ?')
      .all(scopeKey) as unknown as Array<{ device_id: string; flags_json: string; surface: string | null }>)
      .filter(row => { try { return (JSON.parse(row.flags_json) as Record<string, unknown>).touchOnly !== true; } catch { return false; } })
      .map(row => [row.device_id, row.surface] as const));
    if (!bodies.size) return [];
    const devices = [...bodies.keys()];
    const started = this.database.prepare(`
      SELECT device_id, occurred_at FROM body_events WHERE scope_key = ? AND event_type = 'callStarted' AND occurred_at >= ?
        AND device_id IN (${devices.map(() => '?').join(', ')}) ORDER BY occurred_at DESC LIMIT 1
    `).get(scopeKey, since, ...devices) as unknown as { device_id: string; occurred_at: string } | undefined;
    if (!started || !Number.isFinite(Date.parse(started.occurred_at))) return [];
    const ended = this.database.prepare(`
      SELECT occurred_at FROM body_events WHERE scope_key = ? AND device_id = ? AND event_type = 'callEnded' AND occurred_at >= ?
      ORDER BY occurred_at ASC LIMIT 1
    `).get(scopeKey, started.device_id, started.occurred_at) as unknown as { occurred_at: string } | undefined;
    const surface = bodies.get(started.device_id);
    return [{ startedAt: started.occurred_at, ...(ended ? { endedAt: ended.occurred_at } : {}), ...(surface === 'windows' || surface === 'mac' ? { surface } : {}) }];
  }

  close(): void { this.database.close(); }
}
