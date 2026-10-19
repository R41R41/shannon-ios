import { COMMITMENT_RELATIVE_CLOCK_SOURCE, COMMITMENT_TEMPORAL_SOURCE } from './commitmentTime.js';

/**
 * Conservative Japanese rules for "the owner said they (or Shannon) will do
 * something at a stated time". These rules are deliberately closed lists: an
 * ambiguous sentence is left as conversation, because a missed capture is
 * visible in Talk while a wrong one becomes a false reminder.
 */
export interface PromiseMatch {
  /** Clause that carries the time expression; deadlines are resolved from it. */
  clause: string;
  /** What is promised, without the time expression or filler. */
  topic: string;
  /** The owner asked to be alerted at a clock time, which Shannon cannot guarantee. */
  wantsExactTime: boolean;
}

const TEMPORAL = `(?:${COMMITMENT_RELATIVE_CLOCK_SOURCE}|${COMMITMENT_TEMPORAL_SOURCE})`;
const PART_OF_DAY = '(?:早朝|朝|昼|夕方|夜|晩|午前中|午前|午後)';
const CLOCK = '(?:午前|午後)?\\s*\\d{1,2}(?:時(?:\\d{1,2}分|半)?|:\\d{2})(?:ごろ|頃)?';
const TEMPORAL_PHRASE = new RegExp(`${TEMPORAL}(?:中)?(?:(?:の|\\s)*${PART_OF_DAY})?(?:(?:の|\\s)*${CLOCK})?(?:までに|まで|には|に|は|の)?[、,\\s]*`, 'u');
const FILLER = /^(?:じゃあ|じゃ|では|それじゃあ?|それでは|よし|うん|はい|OK|オッケー|とりあえず|やっぱり|やっぱ)[、,\s]*/u;
const REASON_SPLIT = /(?:から|ので|けれど|けど)[、,\s]*/u;
const PARTICLE = /[をにへとで]/u;

const QUOTED = /[「」『』"“”]/u;
const QUESTION = /(?:[?？]|か|かな|かしら|っけ|の)$/u;
const HEDGE = /(?:例えば|たとえば|仮に|もし|かもしれ|かも|たぶん|多分|おそらく|気がする|と思う|と思います|だろう|でしょう|予定は未定|らしい|そうです|そうだ|って言|と言っ|と言わ|例文|翻訳|という設定|たら|なら|れば|場合|ときは|時は)/u;
const NEGATION = /(?:ない|ません|ないで|ず)(?:よ|ね|けど)?$|ない(?:こと|つもり|予定|よう)|(?:やめ|止め|辞め)(?:る|ます|よう|とく|ておく|た)|中止|キャンセル|取り消/u;
const OTHER_SUBJECT = /(?:友人|友達|友だち|彼女?|彼ら|あの人|母|父|兄|姉|弟|妹|家族|同僚|上司|部下|先生|息子|娘|妻|夫|旦那|嫁|子ども|子供|みんな|皆|[^\s、,。]{1,12}?(?:さん|くん|君|ちゃん|氏|先輩|部長|課長|社長))(?:は|が|も)/u;
/** A が-marked noun is another subject (rain, a parcel, a meeting), not the owner's own action. */
const NON_OWNER_SUBJECT = /(?<!僕|私|自分|俺|わたし|ぼく)(?<=[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9ー])が/u;
/** 立てる and 捨てる are verbs; 見てる and 行ってる are ongoing states. */
const PROGRESSIVE = /(?:ている|(?<![立建捨育当充宛企隔慌果])てる|でいる|ています|てます|でいます)$/u;

const SURU = /(?:を)?(?:しよう|します|しましょう|したい(?:です)?|しておく|しとく|しておきます|する(?:つもり|予定)?(?:です|だ)?)$/u;
const YARU = /(?:を)?(?:やる|やります|やろう|やりましょう|やりたい(?:です)?|やっておく|やっとく)$/u;
const FIXED = /(?:話そう|お願い(?:します)?)$/u;
const VOLITIONAL = /(?:(?:[行書聞歩働動開置磨描弾着引炊焼拭履]|い|お)こう|[急泳脱]ごう|(?:[話出探直返渡試貸]|起こ|過ご|目指|済ま|終わら)そう|[待持勝立]とう|[遊学選運呼結]ぼう|(?:[飲読頼休進住組込積]|楽し)もう|(?:[帰作走取撮乗入送守戻登通座眠切売踊練測張釣飾配]|がんば|頑張|終わ)ろう|(?:[買会言使洗歌習払誘向通拾]|手伝|もら|しま)おう|[えけげせてでねべめれきぎじちにびみり見寝着出]よう|ましょう)$/u;
/** Events that happen to the owner are predictions, not promises. */
const NON_VOLITIONAL = /(?:(?:^|[をにへでとはも、\s])(?:くる|きます|いる|います|ある|あります|なる|なります|できる|できます|わかる|わかります)|降る|降ります|晴れる|晴れます|曇る|曇ります|届く|届きます|来る|来ます|始まる|始まります|終わる|終わります|かかる|かかります|出来る|出来ます|分かる|分かります|思う|思います|感じる|感じます|見える|見えます|聞こえる|聞こえます|疲れる|疲れます|困る|困ります|違う|違います|足りる|足ります|要る|要ります|変わる|変わります|続く|続きます|決まる|決まります|治る|治ります|直る|直ります|咲く|咲きます|空く|空きます|減る|減ります|増える|増えます|上がる|上がります|下がる|下がります|止む|止みます|乾く|乾きます|壊れる|壊れます|売れる|売れます|切れる|切れます|混む|混みます|遅れる|遅れます|間に合う|間に合います)$/u;
const SELF_VERB = /(?:寝る|寝ます|起きる|起きます|休む|休みます|出かける|出かけます|帰る|帰ります|走る|走ります|泳ぐ|泳ぎます|歩く|歩きます|出発する|出発します)$/u;
const PLAN_SUFFIX = /(?:つもり|予定)?(?:です|だ)?$/u;
const PLAIN_VERB = /(?:[うくぐすつぬぶむる]|ます)$/u;
const DESIRE = /たい(?:です)?$/u;
/** 冷たい is an adjective and 雨みたい is a guess; neither is the owner wanting to act. */
const NOT_DESIRE = /(?:冷|重|眠|平|煙|めで|じれっ|ありが|なり|あり)たい(?:です)?$|(?<![をて])みたい(?:です)?$/u;
const GREETING = /よろしく|ありがとう|おやすみ|お疲れ|おつかれ/u;
/**
 * His own plan for the talk itself is no promise (owner 2026-10-19: 「今日はそれで会話終わりにする」 came back as 「今日の約束：…」).
 * 「会話は終わりにする」「それでおしまい」「もう寝る話はやめる」: the conversation, or 「それで」, ended or stopped.
 */
const CONVERSATION_PLAN = /(?:(?:会話|話|おしゃべり|やりとり|やり取り|通話|電話)(?:は|を|も)?|(?:それ|これ)で)(?:もう)?(?:終わり|おわり|おしまい|お終い|切り上げ|終了|ここまで)/u;
const REQUEST = /(?:起こして|声(?:を)?(?:かけて|掛けて)|リマインドして|思い出させて|知らせて|教えて|呼んで)(?:ね|よ|ください|くれる|ほしい|欲しい)?$/u;
const TIMER = /(?:タイマー|アラーム|目覚まし)(?:を)?(?:かけて|セットして|設定して|鳴らして|お願い)(?:ね|よ|ください)?$/u;

export function containsCommitmentTime(text: string): boolean {
  return new RegExp(TEMPORAL, 'u').test(text);
}

/** Quotes, hypotheticals, hearsay, other people's plans and greetings are never the owner's promise. */
export function promiseGuarded(clause: string): boolean {
  return QUOTED.test(clause) || HEDGE.test(clause) || OTHER_SUBJECT.test(clause) || GREETING.test(clause) || CONVERSATION_PLAN.test(clause);
}

/** "30分後に教えて" and timers need a clock alarm. They are answered, never stored. */
export function isExactTimeAlertRequest(sentence: string): boolean {
  const text = sentence.trim().replace(/[。！!]+$/u, '');
  if (!text || QUOTED.test(text) || /^(?:例えば|たとえば|もし|仮に)/u.test(text) || /[?？]$/u.test(text)) return false;
  if (TIMER.test(text)) return true;
  return /\d{1,3}\s*(?:分|時間)(?:後|たったら|経ったら|したら)/u.test(text) && REQUEST.test(text);
}

export function matchPromise(sentence: string): PromiseMatch | null {
  let text = sentence.trim().replace(/[。！!]+$/u, '').replace(/(?:よね|ね|よ)$/u, '');
  if (text.length < 3 || text.length > 200 || QUOTED.test(text) || isExactTimeAlertRequest(text)) return null;
  const clauses = text.split(REASON_SPLIT);
  let clause = (clauses.at(-1) ?? text).trim();
  for (let previous = ''; previous !== clause;) { previous = clause; clause = clause.replace(FILLER, ''); }
  const temporal = clause.match(TEMPORAL_PHRASE);
  if (!temporal || promiseGuarded(clause) || QUESTION.test(clause)) return null;
  const rest = `${clause.slice(0, temporal.index)}${clause.slice((temporal.index ?? 0) + temporal[0].length)}`.trim();
  const hasClock = new RegExp(`${CLOCK}|${COMMITMENT_RELATIVE_CLOCK_SOURCE}`, 'u').test(temporal[0]);

  if (REQUEST.test(rest)) {
    // "明日の天気を教えて" asks for information now; only a time-bound request is a promise.
    if (/(?:教えて|知らせて|呼んで)/u.test(rest) && !hasClock) return null;
    if (temporal[0].trimEnd().endsWith('の') && !new RegExp(`${PART_OF_DAY}|${CLOCK}`, 'u').test(temporal[0])) return null;
    return { clause, topic: rest, wantsExactTime: hasClock };
  }
  if (NEGATION.test(clause) || NON_OWNER_SUBJECT.test(rest) || PROGRESSIVE.test(rest)) return null;
  const vague = !/\d|今日|今夜|今晩|明|あした|あさって|曜|月末|今月中/u.test(temporal[0]);
  for (const ending of [SURU, YARU, FIXED]) {
    const match = rest.match(ending);
    if (!match) continue;
    const topic = rest.slice(0, match.index).trim();
    // "あとでやる" names neither a day nor a thing: nothing to remind about.
    if (!topic && vague) return null;
    return { clause, topic: topic || rest, wantsExactTime: false };
  }
  if (VOLITIONAL.test(rest) || (DESIRE.test(rest) && !NOT_DESIRE.test(rest))) return { clause, topic: rest, wantsExactTime: false };
  // 「休みです」 is a state: only a verb left after removing つもり/予定/です is a plan.
  const verb = /ます$/u.test(rest) ? rest : rest.replace(PLAN_SUFFIX, '');
  if (PLAIN_VERB.test(verb) && !NON_VOLITIONAL.test(verb) && (SELF_VERB.test(verb) || PARTICLE.test(verb))) {
    return { clause, topic: rest, wantsExactTime: false };
  }
  return null;
}
