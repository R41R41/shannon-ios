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
 * つつく, くすぐる, 抱きしめる, 抱っこ, ハグ, ぎゅっとする, ぽんぽん, 手を握る, つなぐ. Lookaheads keep the ending for the asking pattern.
 */
const GESTURES = [
  '(?<![接感])触(?=[っらりるれろ])', 'さわ(?=[っらるれろ])', '(?<!ん)なで(?=[てるたらなさまよ])', '撫で', 'つつ(?=[いくかきけ])', '突つ', 'くすぐ',
  '抱きし', '抱っこ', 'だっこ', 'ハグ', 'ぽんぽん', '(?:つな|繋)(?=[いぐがげご])',
  // Only 「ぎゅっとする」「ぎゅってして」「ぎゅーさせて」 (not 「ぎゅっと圧縮」), and only a hand held (「手を握って」, not 「握りつぶし」).
  'ぎゅ(?:っと?|って|ー)(?=(?:して|する|させ|しな|しま))', '(?<=手を?)(?:握|にぎ)(?=(?:る|って|ら))',
];
const TOUCH_VERB = `(?:${GESTURES.join('|')})`;
const TOUCH_TALK = new RegExp(TOUCH_VERB, 'u');
/**
 * Her, or a part of a body, as a word of its own (review of 077abda7: 全体・本体・補足・冒頭・先頭・笑顔・相手 are not 体・足・頭・顔・手):
 * a kanji or katakana word not preceded by kanji or katakana, a hiragana word only at a word's start or after の. 右手・手首 are lost.
 */
const HER_WORD = '(?:シャノン|君|お前|頭|髪|手|頬|顔|肩|腕|背中|首|耳|鼻|お腹|足|脚|腰|胸|体)';
const HER_KANA = '(?:しゃのん|きみ|おまえ|ほっぺた?|ほお|おなか|からだ)';
const HER_BODY = `(?:(?:(?<![\\p{Script=Han}\\p{Script=Katakana}ー])|(?<=もう一回|もう一度))${HER_WORD}|(?:(?<![\\p{L}\\p{N}])|(?<=の))${HER_KANA})`;
const LEAD_WORDS = '(?:ねえ|じゃあ|もう一回|もう一度|もう|また|ちょっと|少し|今度は)';
/** Her or a part of her right before the verb: 「シャノンに触って」「頭なでて」「ほっぺつついて」「手をつないで」「君の髪なでて」. */
const ABOUT_HER = new RegExp(`${HER_BODY}(?:の${HER_BODY})?(?:を|に|も|は)?${SEP}(?:${LEAD_WORDS}${SEP})*${TOUCH_VERB}`, 'u');
/**
 * Within minutes of a touch of his, only the verb with nothing it is done to (review of 077abda7: 「もう本番は触らないよ」, 「この実装
 * 触っていい？」 are not about her): 「触っていい？」「もう一回触っていい？」「触らないで」「ぎゅってしていい？」.
 */
const BARE_TOUCH = new RegExp(`^(?:(?:シャノン|${LEAD_WORDS})${SEP})*${TOUCH_VERB}`, 'u');
const BARE_CHARACTERS = 24;
/**
 * What a developer touches: a file, a page, code, a topic, a setting, a database, a repository, a pull request… Any of them in his words
 * makes the turn not about her body (2026-10-14 review: 「このファイル触っていい？」「その話に触れてもいい？」 read as her consent).
 */
const NOT_HER = new RegExp(`(?:${[
  'ファイル', 'ページ', 'コード', '話', '設定', 'DB', 'ＤＢ', 'データ', 'リポ', 'PR', 'プルリク', '資料', 'ブランチ', 'サーバ', '画面', 'ボタン',
  'ソース', 'ドキュメント', 'Notion', 'ノート', 'メモ', 'タスク', 'プロンプト', 'テスト', 'ログ', 'コミット', 'アプリ', 'スマホ', 'PC', 'パソコン',
  'キーボード', 'マウス', 'それ', 'これ', 'あれ', '手順', '部分', '実装', 'config', 'API', 'UI', 'iPhone', 'Mac', 'Windows', '関数', 'ヘッダ',
  'ワークフロー', '本番', '環境', 'ビルド', 'デプロイ', 'クラス', 'モデル', '仕様', '原稿', '文章', '機能', 'アニメーション', 'モーション',
  'ジェスチャー', '判定', '処理', 'イベント', 'バグ',
].join('|')})`, 'iu');
/** His asking: 「触ってもいい？」「なでていい？」「手をつないでいい？」「触らせて」. */
const TOUCH_ASK = new RegExp(`${TOUCH_VERB}[^。！？!?、]{0,6}?(?:てもいい|でもいい|ていい|でいい|ても良い|てよい|てもよい|ても大丈夫|でも大丈夫|させて|らせて)`, 'u');
/** Her yes: 「いいですよ」「どうぞ」「かまいません」「しょうがないですね」. */
const TOUCH_PERMIT = /(?:いいですよ|いいよ|どうぞ|かまいません|構いません|かまわない|構わない|いいですけど|いいけど|特別に|しょうがない|仕方ない|仕方がない)/u;
/** Her no: 「だめ」「いやです」「やめて」「触らないで」. */
const TOUCH_REFUSE = new RegExp(`(?:だめ|ダメ|駄目|いやです|いやだ|嫌です|嫌だ|やだ|やめて|お断り|${TOUCH_VERB}[^。！？!?、]{0,3}ないで)`, 'u');
/** His own no for later (「もう触らないよ」「もう頭なでないよ」「もう抱きしめないよ」), never a past 「触ってないよ」「触りませんでした」. */
const REFRAIN_STEMS = [
  '(?<![接感])触[らり]', 'さわ[らり]', '(?<!ん)なで', '撫で', 'つつ[かき]', 'くすぐ[らり]', '抱きしめ', '(?:抱っこ|だっこ|ハグ|ぎゅっと?|ぎゅって|ぎゅー|ぽんぽん|なでなで)し',
  '(?:つな|繋)[がぎ]', '手を?(?:握|にぎ)ら',
];
const TOUCH_REFRAIN = new RegExp(`(?:${REFRAIN_STEMS.join('|')})(?:ない|ません)(?:よ|から|ね|です)?(?:[。！!…〜ー～\\s]|$)`, 'u');

export type TouchConsent = 'asked' | 'permitted' | 'refused';

/**
 * Whether a finished turn asks, allows or refuses touching HER BODY (owner decision 2026-10-14: her note reflects at once then). Read
 * narrowly, because a false one writes 「ボクが触れるのを許した」 as a fact: his words must name her or a part of a body (a word of its
 * own) right before the verb, or, within minutes of a touch of his (`recentTouch`), be the bare verb with nothing it is done to; and
 * nothing in them may be a thing a developer touches (a file, a page, a topic, a database…). Then her refusal or his promise not
 * to, her yes, or his asking. When in doubt, null.
 */
export function touchConsentIn(message: string, reply: string, context: { recentTouch?: boolean } = {}): TouchConsent | null {
  const words = message.trim();
  const answer = reply.trim();
  if (!short(words, 120) || NOT_HER.test(words) || !TOUCH_TALK.test(words)) return null;
  const named = ABOUT_HER.test(words);
  const bare = context.recentTouch === true && Array.from(words).length <= BARE_CHARACTERS && BARE_TOUCH.test(words);
  if (!named && !bare) return null;
  const asked = TOUCH_ASK.test(words);
  // Her no counts only as the answer to his asking (「肩に触る判定どう？」→「だめな理由はないです」 is not a refusal).
  if (TOUCH_REFRAIN.test(words) || (asked && TOUCH_REFUSE.test(answer))) return 'refused';
  // Her yes counts only as the answer to his asking (「触ってないよ」→「いいですよ」 is not a permission).
  if (asked && TOUCH_PERMIT.test(answer)) return 'permitted';
  return asked ? 'asked' : null;
}

/** His telling her he is about to touch her: 「よしよしするね」「手繋ぐね」「なでるよ」「触るからね」. */
const TOUCH_ANNOUNCE = new RegExp(`(?:${TOUCH_VERB}|よしよし|ヨシヨシ|なでなで)[^。！？!?、]{0,6}?(?:するね|するよ|するから|しまーす|します|ぐね|ぐよ|るね|るよ|るから|ます)${TAIL}$`, 'u');
const PETTING = /(?:よしよし|ヨシヨシ|なでなで)/u;

/**
 * What the last exchange agreed about touching her, for the reflex of a touch that follows (owner 2026-10-19: 「えっ、また！？」 right after
 * her 「どうぞ」, and 「ひゃっ」 right after 「手繋ぐね」): she allowed it, or he said he was about to (and she did not refuse). Null otherwise,
 * and whenever she refused. Read as narrowly as `touchConsentIn`.
 */
export function touchAgreementIn(message: string, reply: string): 'permitted' | 'announced' | null {
  const words = message.trim().replace(OPENING, '');
  const answer = reply.trim();
  // A touch follows this exchange at once: the bare verb (「もうちょっと触ってもいい？」) is about her, as within minutes of a touch.
  const consent = touchConsentIn(words, answer, { recentTouch: true });
  if (consent === 'refused') return null;
  if (consent === 'permitted') return 'permitted';
  if (!short(words, 60) || NOT_HER.test(words) || !(TOUCH_TALK.test(words) || PETTING.test(words)) || TOUCH_REFUSE.test(answer)) return null;
  if (PET_ASK.test(words)) return TOUCH_PERMIT.test(answer) ? 'permitted' : null;
  return TOUCH_ANNOUNCE.test(words) ? 'announced' : null;
}
/** 「うーん、じゃあ」 before his words. */
const OPENING = /^(?:(?:うーん|ううん|えーと|ええと|えっと|あのー?|ねえ|ねぇ|じゃあ|では|それじゃあ?)[、,\s]+)+/u;
/** 「頭ヨシヨシしていいかな？」: asking to pet her, a word the touch verbs do not have. */
const PET_ASK = /(?:よしよし|ヨシヨシ|なでなで)[^。！？!?、]{0,6}?(?:してもいい|していい|しても大丈夫|させて)/u;

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
