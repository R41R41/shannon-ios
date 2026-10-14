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

/** Touching her, in the words a conversation uses for it (触る・なでる・つつく・くすぐる・抱きしめる・手をつなぐ). */
const TOUCH_WORD = '(?:触|さわ(?=[っらりるれろ])|(?<!ん)なで(?=[てるたらなさまよ])|撫で|ナデ|つつ(?=[いくかきけ])|突つ|くすぐ|擽|抱きし|抱っこ|だっこ|ハグ|手を?つな|手を?繋)';
const TOUCH_TALK = new RegExp(TOUCH_WORD, 'u');
/** His asking: 「触ってもいい？」「なでていい？」「触らせて」. */
const TOUCH_ASK = new RegExp(`${TOUCH_WORD}[^。！？!?、]{0,6}(?:ていい|てもいい|ても良い|てよい|てもよい|させて|らせて)`, 'u');
/** Her yes, in a reply about it: 「いいですよ」「どうぞ」「かまいません」「しょうがないですね」. */
const TOUCH_PERMIT = /(?:いいですよ|いいよ|どうぞ|かまいません|構いません|かまわない|構わない|いいですけど|いいけど|特別に|しょうがない|仕方ない|仕方がない)/u;
/** Her no: 「だめ」「いやです」「やめて」「触らないで」. */
const TOUCH_REFUSE = new RegExp(`(?:だめ|ダメ|駄目|いやです|いやだ|嫌です|嫌だ|やだ|やめて|お断り|${TOUCH_WORD}[^。！？!?、]{0,3}ないで)`, 'u');
/** His own no: 「もう触らない」「触らないよ」. */
const TOUCH_REFRAIN = new RegExp(`${TOUCH_WORD}[^。！？!?、]{0,3}(?:らない|ません|ないよ|ないから)`, 'u');

export type TouchConsent = 'asked' | 'permitted' | 'refused';

/**
 * Whether a finished turn is about touching her and says yes or no to it (owner decision 2026-10-14: her note reflects at once when
 * touching is allowed or refused in conversation). Read narrowly: the turn must talk about touching (his words or her reply), and then
 * her refusal or his promise not to, her yes, or his asking. Facts for her reflection; what it means is hers to read. Unsure means null.
 */
export function touchConsentIn(message: string, reply: string): TouchConsent | null {
  const words = message.trim();
  const answer = reply.trim();
  if (!short(words, 120) || !(TOUCH_TALK.test(words) || TOUCH_TALK.test(answer))) return null;
  const asked = TOUCH_ASK.test(words);
  const about = asked || TOUCH_TALK.test(answer);
  if (TOUCH_REFRAIN.test(words) || (about && TOUCH_REFUSE.test(answer))) return 'refused';
  if (about && TOUCH_PERMIT.test(answer)) return 'permitted';
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
