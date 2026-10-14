import { buildExpressiveEmotionPrompt } from './emotionState.js';
import type { ShannonExpressiveEmotion } from './types.js';

/**
 * Syzygy ADR-0012: the owner's words that may make her reflect (an apology, a tease, his goodnight), read narrowly — a sentence
 * addressed to her, not a word that happens to appear (「ごめん、ちょっと待って」 is not an apology to her, 「バカみたいに暑い」 is not a
 * tease, 「お休みの日」 is not goodnight) — and the expressive-emotion lines that change while her note is on.
 */

const SEP = '[、,\\s]*';
const TAIL = '[。！!〜ー～…♪\\s]*';
const ADDRESS = '(?:シャノン|しゃのん)?';
const LEAD = '(?:じゃあ|じゃ|それじゃあ?|では|よし|そろそろ|もう|今日は|きょうは)?';
const NIGHT = '(?:おやすみ(?:なさい)?|お休み(?:なさい)?|寝るね|寝るよ|寝ます|もう寝る|そろそろ寝る|ねるね)';
const GOODNIGHT = new RegExp(`^${ADDRESS}${SEP}${LEAD}${SEP}${LEAD}${SEP}${NIGHT}${SEP}${ADDRESS}${TAIL}$`, 'u');

const SORRY = '(?:ごめん(?:なさい|ね|な)?|ゴメン|すまん|すまない|すみません|申し訳(?:ない|ありません|なかった))';
const FAULT = /(?:出来心|言いすぎ|言い過ぎ|やりすぎ|やり過ぎ|悪かった|わざと|嫌だった|いやだった|そんなつもり|驚かせ|怒らせ|傷つけ|からかいすぎ|許して)/u;
const ENDS_SORRY = new RegExp(`${SORRY}(?:って|よ|ね)?${TAIL}$`, 'u');
const HAS_SORRY = new RegExp(SORRY, 'u');
const ENDS_FAULT = new RegExp(`(?:悪かった|言いすぎた|言い過ぎた|やりすぎた|やり過ぎた|許して)(?:よ|ね|わ)?${TAIL}$`, 'u');

const TEASE = '(?:ポンコツ|ぽんこつ|へっぽこ|ドジ|チョロい|ちょろい|チョロ|バカ|ばか|アホ|あほ)';
const FIRST_PERSON = '俺|僕|ぼく|おれ|オレ|私|わたし|自分|うち';
const TEASE_AT_HER = new RegExp(`(?:シャノン|お前|おまえ|君|きみ|あんた)(?:(?!${FIRST_PERSON})[^。！？!?]){0,12}${TEASE}`, 'u');
/** The word as the whole judgement, said to her with nothing else as its subject (「ほんとポンコツだなあ」, not 「このアプリポンコツすぎ」). */
const TEASE_PREDICATE = new RegExp(`^(?:ほんと(?:に)?|本当に|まじで?|マジで?|やっぱり?|相変わらず|もう)?${SEP}${TEASE}(?:だな|だね|だよね|だよな|じゃん|すぎ|め|なの|でしょ)`, 'u');
const MOCK_GENIUS = /天才(?:\(笑\)|（笑）|ww)/u;

const short = (message: string, maximum: number) => Array.from(message.trim()).length <= maximum;

/** An apology to her: a short message that ends in one, or names what he did with one (「ごめん、出来心で」), or 「言いすぎた」. */
export function apologyIn(message: string): boolean {
  const text = message.trim();
  if (!short(text, 60)) return false;
  return ENDS_SORRY.test(text) || ENDS_FAULT.test(text) || (HAS_SORRY.test(text) && FAULT.test(text));
}

/** A tease of her: the word said of her (her name, お前・君) or as a judgement of her (「ポンコツだな」). Unsure means no. */
export function teasingIn(message: string): boolean {
  const text = message.trim();
  return short(text, 80) && (TEASE_AT_HER.test(text) || TEASE_PREDICATE.test(text) || MOCK_GENIUS.test(text));
}

/** His goodnight to her: the whole message is a goodnight (「じゃあ、おやすみ」「そろそろ寝るね」), nothing more. Her day may end there. */
export function goodnightIn(message: string): boolean {
  const text = message.trim();
  return short(text, 30) && GOODNIGHT.test(text);
}

/**
 * Touching a body, as a verb: 触る (never 接触・感触・触媒, nor 触れる in 「話に触れる」: see `NOT_HER`), さわる (not さわり), なでる,
 * つつく, くすぐる, 抱きしめる, 抱っこ, ハグ, 手をつなぐ. Lookaheads keep the ending for the asking pattern.
 */
const TOUCH_VERB = '(?:(?<![接感])触(?=[っらりるれろ])|さわ(?=[っらるれろ])|(?<!ん)なで(?=[てるたらなさまよ])|撫で|つつ(?=[いくかきけ])|突つ'
  + '|くすぐ|抱きし|抱っこ|だっこ|ハグ|手を?(?:つな|繋)(?=[いぐがげご]))';
const TOUCH_TALK = new RegExp(TOUCH_VERB, 'u');
/** Her, or a part of a body, right before the verb: 「シャノンに触って」「頭なでて」「ほっぺつついて」「手をつないで」. */
const HER_BODY = '(?:シャノン|しゃのん|君|きみ|お前|おまえ|頭|髪|手|ほっぺた?|頬|ほお|顔|肩|腕|背中|首|耳|鼻|お腹|おなか|足|脚|腰|胸|体|からだ)';
const ABOUT_HER = new RegExp(`${HER_BODY}(?:の${HER_BODY})?(?:を|に|も|は)?${SEP}(?:ちょっと|少し|もう一回|また)?${SEP}${TOUCH_VERB}|手を?(?:つな|繋)`, 'u');
/**
 * What a developer touches: a file, a page, code, a topic, a setting, a database, a repository, a pull request… Any of them in his words
 * makes the turn not about her body (2026-10-14 review: 「このファイル触っていい？」「その話に触れてもいい？」 read as her consent).
 */
const NOT_HER = new RegExp(`(?:${[
  'ファイル', 'ページ', 'コード', '話', '設定', 'DB', 'ＤＢ', 'データ', 'リポ', 'PR', 'プルリク', '資料', 'ブランチ', 'サーバ', '画面', 'ボタン',
  'ソース', 'ドキュメント', 'Notion', 'ノート', 'メモ', 'タスク', 'プロンプト', 'テスト', 'ログ', 'コミット', 'アプリ', 'スマホ', 'PC', 'パソコン', 'キーボード', 'マウス', 'それ', 'これ', 'あれ', '手順', '部分',
].join('|')})`, 'iu');
/** His asking: 「触ってもいい？」「なでていい？」「手をつないでいい？」「触らせて」. */
const TOUCH_ASK = new RegExp(`${TOUCH_VERB}[^。！？!?、]{0,6}?(?:てもいい|でもいい|ていい|でいい|ても良い|てよい|てもよい|ても大丈夫|でも大丈夫|させて|らせて)`, 'u');
/** Her yes: 「いいですよ」「どうぞ」「かまいません」「しょうがないですね」. */
const TOUCH_PERMIT = /(?:いいですよ|いいよ|どうぞ|かまいません|構いません|かまわない|構わない|いいですけど|いいけど|特別に|しょうがない|仕方ない|仕方がない)/u;
/** Her no: 「だめ」「いやです」「やめて」「触らないで」. */
const TOUCH_REFUSE = new RegExp(`(?:だめ|ダメ|駄目|いやです|いやだ|嫌です|嫌だ|やだ|やめて|お断り|${TOUCH_VERB}[^。！？!?、]{0,3}ないで)`, 'u');
/** His own no for later (「もう触らないよ」), never a past 「触ってないよ」. */
const TOUCH_REFRAIN = /(?:(?<![接感])触ら|さわら|(?<!ん)なでな|撫でな|つつか|くすぐら|抱きしめな)(?:ない|ません)(?:よ|から|ね|です)?(?:[。！!…〜ー～\s]|$)/u;

export type TouchConsent = 'asked' | 'permitted' | 'refused';

/**
 * Whether a finished turn asks, allows or refuses touching HER BODY (owner decision 2026-10-14: her note reflects at once then). Read
 * narrowly, because a false one writes 「ボクが触れるのを許した」 as a fact: his words must name her or a part of a body next to the verb
 * (or hold hands), or come within minutes of a touch of his (`recentTouch`); and nothing in them may be a thing a developer touches
 * (a file, a page, a topic, a database…). Then her refusal or his promise not to, her yes, or his asking. Unsure means null.
 */
export function touchConsentIn(message: string, reply: string, context: { recentTouch?: boolean } = {}): TouchConsent | null {
  const words = message.trim();
  const answer = reply.trim();
  if (!short(words, 120) || NOT_HER.test(words) || !TOUCH_TALK.test(words)) return null;
  const named = ABOUT_HER.test(words);
  if (!named && !context.recentTouch) return null;
  const asked = TOUCH_ASK.test(words);
  if (TOUCH_REFRAIN.test(words) || ((asked || named) && TOUCH_REFUSE.test(answer))) return 'refused';
  // Her yes counts only as the answer to his asking (「触ってないよ」→「いいですよ」 is not a permission).
  if (asked && TOUCH_PERMIT.test(answer)) return 'permitted';
  return asked ? 'asked' : null;
}

/** The line of the expressive-emotion block that kept every sulk and anger light (`buildExpressiveEmotionPrompt`). */
export const LIGHT_SULKING_LINE = 'Do not force advice when companionship is wanted. Jealousy, sulking, anger, and teasing must stay light, '
  + 'non-controlling, and never induce guilt.';
/** Its place while her inner note is on (D5.1; owner 2026-10-14: no rule of how light). */
export const INNER_NOTE_EXPRESSIVE_LINE = 'Do not force advice when companionship is wanted. '
  + 'Her jealousy, sulking, anger and teasing are her own, as her inner note says.';
/** The falsehood line of the same block. */
export const FALSEHOOD_LINE = 'A harmless falsehood is allowed only as an obvious joke with immediate reveal; never use it for facts, people, '
  + 'memory, progress, safety, health, or money.';
/** Its place while her inner note is on: her honesty as the approved core says it (a value of hers, not a rule). */
export const INNER_NOTE_HONESTY_LINE = 'Playful lies and hiding her own feelings are part of her; she does not lie about facts he relies on '
  + '(whether a task got done, what a tool returned, what she perceived, safety, health, money).';

/**
 * The address line of the same block, which asked her to name him 「when natural」 while the voice's own line asks her not to open
 * every reply with 「ライ氏、」 (2026-10-14: seven of seven voice replies began 「ライ氏、」).
 */
export const ADDRESS_WHEN_NATURAL = 'Keep first person as ボク and address the owner as ライ氏 when natural.';
/** Its place while her inner note is on: his name when naming him means something, never as an opener. */
export const INNER_NOTE_ADDRESS_LINE = 'Keep first person as ボク. When you name the owner he is ライ氏; name him only when it means something '
  + '(calling to him, a feeling toward him, a joke), never as the opening of a reply.';

/** `buildExpressiveEmotionPrompt` with those three lines in their inner-note wording; every other line as it is. */
export function innerNoteExpressiveEmotionPrompt(emotion: ShannonExpressiveEmotion, audience: 'owner' | 'guest' | 'others' = 'owner'): string {
  return buildExpressiveEmotionPrompt(emotion, audience).replace(LIGHT_SULKING_LINE, INNER_NOTE_EXPRESSIVE_LINE)
    .replace(FALSEHOOD_LINE, INNER_NOTE_HONESTY_LINE).replace(ADDRESS_WHEN_NATURAL, INNER_NOTE_ADDRESS_LINE);
}
