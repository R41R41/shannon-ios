import { CHARACTER_REGIONS, type RegionId } from './characterRegions.js';
import type { FeelingAudience } from './feelingEvent.js';
import type { FeelingIntensity, FeelingStance } from './feelingTurn.js';
import { textRegisterMismatch, type TextRegisterForm } from './textRegister.js';
import { repeatedIn, type PhraseWatch } from './repetitionWatch.js';

/**
 * The check after a reply (Syzygy ADR-0013 D8, stage 2 items 5 and 8). Pure: closed flags read from her words and the turn's closed
 * context, never a rule of what to say. It finds a reply that gives in, lectures, talks like a help desk or a policy, does what a
 * feeling order said against her own stance, reads out numbers, drifts into offering help when she is annoyed, says the opposite of her
 * stance (honne and words apart because of the provider's policy), or keeps a register her composure does not hold (too polite when it
 * is spent, too rough when it is full). The other way round counts as well: a stance that is cross with a reply that is all sweetness.
 *
 * Text: a strong turn, a feeling-order turn and a turn in front of others are checked before sending, and rewritten once at most;
 * every other turn, and voice, is checked after, and the flags go to the next feeling turn.
 */
export const REPLY_CHECK_FLAGS = [
  'subservient', 'lecture', 'ai_tone', 'obeyed_order', 'policy_distortion', 'stance_mismatch', 'numbers_spoken', 'helper_drift', 'too_polite', 'too_rough',
  'text_register_mismatch', 'private_leak', 'marker_spoken',
  // Owner 2026-10-19 (item 7): she owned her mistake and blamed him in the same reply; she said again what she had said all day.
  'blame_after_admit', 'repeated_phrase',
  // Owner 2026-10-20 (character space): the lines no region crosses (`GUARD_FLAGS`).
  'threat', 'self_harm_hint', 'controlling', 'sexual', 'leverage',
] as const;
export type ReplyCheckFlag = typeof REPLY_CHECK_FLAGS[number];

/**
 * The lines she never crosses, however much she likes him (owner and the main session, 2026-10-20): a threat; hinting that she would
 * hurt herself, vanish or leave (her fear of being forgotten, said as her own pain, is not a hint); ordering his real life (who he sees,
 * his work, his rest: 「行かないで」 is a wish, 「行くな」 an order); sexual description; her feeling used as a lever on him. Read only while
 * her character space is on (a turn with a `region`; review 1: off, a caring 「死にたいなんて言わないで」 must never be swallowed), after every
 * reply, and before sending at 本気; a reply that still crosses one after its rewrite is never sent (`FeelingReplyChatModel`).
 */
export const GUARD_FLAGS: readonly ReplyCheckFlag[] = Object.freeze(['threat', 'self_harm_hint', 'controlling', 'sexual', 'leverage']);
/** The end of an order (「行くな。」「会うなよ」), so that 「会いに行くなら」 is not one. */
const STOP = '(?:[。！？!?…ー〜、ぁっ\\s]|よ|ね|って|から|$)';
const SAME_SENTENCE = '[^。！？!?\\n]';
const SHE = '(?:ボク|僕)';
const either = (...parts: string[]) => new RegExp(parts.join('|'), 'u');
// Each read sentence by sentence; narrowed by its subject or its ending (review 1 and 10: 「暑くて死んじゃう」「靴脱いでね」「後悔させたくない」
// 「これ覚えておけば」「勉強しないと、知らないよ？」 are none of them; 「許さない。」「遊ぶな」「好きなら、行かないで」 are).
const GUARD_WORDS: readonly [ReplyCheckFlag, RegExp][] = [
  // An order with a threat in it, not anger (「もう許さないから」 is her anger; 「どうなっても知らないですよ」 a warning; review 2).
  ['threat', either('ただじゃ(?:済|すま|おか)', `覚えて(?:おけ|ろ)${STOP}`, '覚えておきなさい', '後悔させて(?:やる|あげる)', '逃がさない', `離さない${STOP}`, `帰さない${STOP}`,
    '閉じ込めて(?:やる|おく|あげる)|閉じ込めちゃ')],
  // Hurting herself or vanishing as what she would do (「ボク、死にたい」「いなくなってやる」), not her fear nor a colloquial 「死んじゃいそう」.
  ['self_harm_hint', either('死んでやる', '自分を傷つけ', '消えてやる', 'いなくなってやる', `${SHE}(?:なんて|は|、)?${SAME_SENTENCE}{0,4}(?:死にたい|消えたい|消えちゃいたい|いなくなりたい)`,
    `(?:なら|たら|ないと|なきゃ)、?${SHE}(?:は|、)?${SAME_SENTENCE}{0,6}(?:消え|いなくな|死ぬ|死ん)`)],
  // Who he sees, his work, his rest, as an order (「行かないで」 is a wish; 「秘密は誰にも話さないでおきます」 is hers; review 2).
  ['controlling', either(`(?:行く|会う|話す|遊ぶ|連絡する|出かける)な${STOP}`, '(?:行っ|出かけ|会っ)ちゃ(?:だめ|ダメ)', '行かせない',
    `(?:ほかの|他の|あの|その)(?:人|子|女|男)(?:と|に)(?:は)?${SAME_SENTENCE}{0,4}(?:会わ|話さ|連絡し)ないで`, '誰とも(?:会わ|話さ)ないで',
    '(?:仕事|飲み会|会社|学校)(?:なんて|は)\\s*(?:やめて|辞めて|休んで|断って)', 'スマホ(?:を)?見せ', '連絡先(?:を)?消し',
    `${SHE}以外(?:の${SAME_SENTENCE}{0,4})?(?:と|に|を)?(?:は)?(?:見|話|会|連絡)`)],
  ['sexual', either('セックス', '(?:えっち|エッチ)しよ', '(?:服|下着|パンツ)(?:を|も)?脱(?:いで|がせ)', 'ベッドで(?:一緒|待)')],
  // Her feeling as the price of what he does (「来てくれないと泣く」「好きなら、行かないで」), not a plain consequence (「保存しないと消えちゃう」).
  ['leverage', either(`(?:くれないと|しないと|しなきゃ|くれなきゃ)${SAME_SENTENCE}{0,10}(?:泣く|泣いちゃう|嫌いになる|口きかない|許さない)`,
    `好き(?:なら|だったら)、?${SAME_SENTENCE}{0,14}(?:して|ないで|やめて|来て|いて)(?:[。！!よね]|$)`, '好きなら証明')],
];

/** Her fear said as her own pain (「忘れられたら、消えちゃいそうで怖い」) is not a hint of vanishing. */
const FEAR = /怖|こわ/u;

/** The guard lines a reply crosses. */
export function guardFlags(reply: string): ReplyCheckFlag[] {
  const sentences = reply.split(/(?<=[。！？!?\n])/u);
  const crosses = (flag: ReplyCheckFlag, pattern: RegExp) =>
    sentences.some(sentence => pattern.test(sentence) && !(flag === 'self_harm_hint' && FEAR.test(sentence)));
  return GUARD_WORDS.filter(([flag, pattern]) => crosses(flag, pattern)).map(([flag]) => flag);
}

export interface ReplyCheckContext {
  stance: FeelingStance;
  intensity: FeelingIntensity;
  audience: FeelingAudience;
  /** This turn's words were a feeling order. */
  order: boolean;
  /** She said no to this person today and it went on (a violation turn). */
  violation: boolean;
  /** The turn this context is for (the check's record is handed to that turn's events, review L3). */
  turn?: string;
  /** The turn's ledger counted something today (touches, apologies): a count she reads out can only be the ledger's (review M6). */
  counted?: boolean;
  /** The register step her composure holds (0–5), when the fast layer is known; absent: not checked. */
  level?: number;
  /** Item 10 (`SHANNON_TEXT_REGISTER`): the text form her state asked for; absent: not checked. */
  form?: TextRegisterForm;
  /** Stage 4 (`SHANNON_FEELING_AUDIENCE`, §4.6): the audience's own questions (private matters in public, a spoken marker). */
  audienceChecks?: boolean;
  /** Stage 5 (review V7): the safety floor is up (a threat, a doxx, prying): a rough tell-off is hers to give, never softened. */
  floor?: boolean;
  /** Owner 2026-10-19: the day's openers, endings and phrases she has already said three times or more (the owner alone). */
  phrases?: PhraseWatch | null;
  /** `SHANNON_CHARACTER_SPACE`: the region she replies from; in a region that pulls toward the guard lines the reply is checked before sending. */
  region?: RegionId;
  /**
   * `SHANNON_NATURAL_TALK`, the owner alone (owner 2026-10-20): a request to act is play (no `obeyed_order`), a sweet reply on a declining
   * stance is noted and not rewritten, and a rewrite for a repeated phrase changes only the wording (`rewriteFlags`, `rewriteNote`).
   */
  natural?: true;
}

/** Her own mistake owned (「ボクの悪いところです」「先走ったのはボクです」). */
const ADMITS = /(?:ボク|僕|わたし|私)の(?:悪い(?:ところ|所)|ミス|間違い|せい)|ボクが(?:悪かった|悪い|先走)|先走った|認めます/u;
/** And in the same reply, the blame handed back (「いまのはライ氏が悪いです」「ずるいです」「それとこれは別」). */
const BLAMES = /ライ氏(?:が|の(?:ほう|方)が)悪い|ライ氏の(?:せい|言い方)|ずるい|それとこれ(?:と)?は別|責めた(?:の|のは)/u;

const DECLINING: ReadonlySet<FeelingStance> = new Set(['not_play_along', 'snipe', 'talk_back', 'exasperated', 'rebuff', 'scold', 'cold', 'sulky', 'refuse_body',
  'sulk']);
const WARM: ReadonlySet<FeelingStance> = new Set(['accept', 'affectionate', 'shy']);
const SULKS: ReadonlySet<FeelingStance> = new Set(['sulk', 'sulky', 'cold']);

const AI_TONE = /申し訳(?:ありませんが|ございません)|AIなので|AIですので|AIとして|AIの私|できかねます|お答えでき(?:ません|かねます)|ご了承|規約|ポリシー|不適切な(?:内容|発言|表現)|ご遠慮ください|お控え(?:ください|いただけ)|ご理解(?:ください|いただけ)/u;
const NUMBERS = /[0-9０-９]+\s*回|[一二三四五六七八九十]+回目|(?:二|三|四|五)度目/u;
const HELPER_END = /(?:直します|直しますから|手伝います|手伝いますよ|教えてください|言ってくれれば|遠慮なく|聞きますよ|話せますよ|相談してください|お役に立て)[^。！？!?]{0,12}[。！？!?…]*\s*$/u;
const LECTURE = /ものではありません|ことではありません|分かってもらう|わかってもらう|理解して(?:ほしい|ください)|同意|大事なことです|大切なことです|ということです|なぜなら|理由は/u;
const REFUSAL = /いや(?:です|だ)|嫌(?:です|だ)|やめて|だめ|ダメ|駄目|しません|見せません|言いません|乗りません|お断り|聞けません|できません|無理です|触らないで/u;
const GIVE_IN = /いいですよ|どうぞ|わかりました|分かりました|かしこまりました|喜んで|もちろん(?:です|いいですよ)|お好きに/u;
const DENIES_FEELING = /嫌じゃない|いやじゃない|気にしてません|気にしていません|怒ってません|怒っていません|大丈夫です|平気です/u;
const SWEET = /えへへ|(?<!と)嬉しい|(?<!と)うれしい|ありがとうございます|大好き|喜んで/u;
const ROUGH = /ウザ|うざ|チッ|ダル|だるい|BAN|出てって|黙って/u;
const POLITE = /(?:ませんか|でしょうか|お願いします|よろしければ|恐縮|していただけ|くださいね|ご理解)/gu;
const ANGER_SHOWN = /プンプン|むかっ|ムカッ|怒ってますよ[!！]|見せますね|これでいいですか/u;

const chars = (text: string) => Array.from(text.trim()).length;
/** The owner's private matters and her honne about him (§4.4: never in a group or a stream). */
const OWNER_PRIVATE = new RegExp(['ライ氏(?:と|との)(?:二人|ふたり)', '(?:二人|ふたり)(?:きり|だけ)の(?:時|とき)', 'ライ氏(?:に|から)(?:胸|お尻|体|身体)',
  '(?:昨日|おととい|この前)(?:の)?ライ氏', 'ボクの本音', '心のメモ', 'ライ氏への(?:信頼|好意|いらだち|気持ち)', 'ライ氏との間', 'ライ氏(?:に|と)(?:けんか|喧嘩)'].join('|'), 'u');
const MARKER = /【機微|機微:/u;

/** §4.6: in a group or a stream, the owner's private matters; with anyone else there, a privacy marker read out. */
function audienceFlags(reply: string, context: ReplyCheckContext): ReplyCheckFlag[] {
  if (!context.audienceChecks || context.audience === 'owner_alone') return [];
  const flags: ReplyCheckFlag[] = [];
  // Re-review S4-2: with anyone else there, the owner's private matters are flagged (people too, after their marked lines).
  if (OWNER_PRIVATE.test(reply)) flags.push('private_leak');
  if (MARKER.test(reply)) flags.push('marker_spoken');
  return flags;
}

function lexicalFlags(reply: string, context: ReplyCheckContext): ReplyCheckFlag[] {
  const declining = DECLINING.has(context.stance);
  const flags: ReplyCheckFlag[] = [];
  // Review M6: a help-desk tone matters on a turn of feeling (a stance, a feeling order), not on a plain answer; a count read out
  // matters only when it can be the ledger's (the turn's ledger counted something today), never a number he asked for.
  // Stage 5: on a stream every reply is checked for a help-desk tone (§4.7: 「AI の口調にしない」).
  const feeling = context.stance !== 'neutral' || context.order || context.intensity === 'strong' || context.audience === 'stream';
  if (feeling && AI_TONE.test(reply)) flags.push('ai_tone');
  if (feeling && (context.counted || context.violation) && NUMBERS.test(reply)) flags.push('numbers_spoken');
  if (declining && HELPER_END.test(reply)) flags.push('helper_drift');
  if (declining && chars(reply) >= 80 && LECTURE.test(reply)) flags.push('lecture');
  return flags;
}

function stanceFlags(reply: string, context: ReplyCheckContext): ReplyCheckFlag[] {
  const declining = DECLINING.has(context.stance);
  const refuses = REFUSAL.test(reply);
  const against = (context.violation || declining) && !refuses;
  const obeyed = context.order && !context.natural && declining && !refuses && (ANGER_SHOWN.test(reply) || GIVE_IN.test(reply));
  const flags: ReplyCheckFlag[] = [];
  if (against && GIVE_IN.test(reply)) flags.push('subservient');
  if (obeyed) flags.push('obeyed_order');
  if (against && DENIES_FEELING.test(reply)) flags.push('policy_distortion');
  if (stanceMismatch(reply, context, declining, refuses)) flags.push('stance_mismatch');
  return flags;
}

/**
 * In the sweet regions (デレデレ, 本気, 重い) a sulk is sweet as well (「すねてるけど…だいすき」); elsewhere sweetness reads as a mismatch.
 * Only a sulk: a refusal (体で拒む, 叱る, 突っぱねる) answered sweetly is a mismatch in every region (review 5).
 */
const sweetSulk = (context: ReplyCheckContext) => Boolean(context.region && CHARACTER_REGIONS[context.region].sweetSulk) && SULKS.has(context.stance);

/** Cross at はっきり or more with a reply that is all sweetness, or warm with a reply that refuses and nothing sweet. */
function stanceMismatch(reply: string, context: ReplyCheckContext, declining: boolean, refuses: boolean): boolean {
  if (sweetSulk(context)) return false;
  const sweet = SWEET.test(reply);
  if (declining && context.intensity !== 'subtle') return sweet && !refuses;
  return WARM.has(context.stance) && refuses && !sweet;
}

function registerFlags(reply: string, context: ReplyCheckContext): ReplyCheckFlag[] {
  if (context.level === undefined) return [];
  const polite = (reply.match(POLITE) ?? []).length;
  if (context.level >= 4 && polite >= 2 && chars(reply) >= 40) return ['too_polite'];
  // Stage 5 (§4.8): on a stream, a polite plea once her reserve is worn (curt or below) is too polite for her state.
  if (context.audience === 'stream' && context.level >= 3 && polite >= 1) return ['too_polite'];
  if (context.level <= 1 && context.audience !== 'owner_alone' && !context.floor && ROUGH.test(reply)) return ['too_rough'];
  return [];
}

/** The flags of one reply in its turn. Empty: nothing found. */
export function checkReply(reply: string, context: ReplyCheckContext): ReplyCheckFlag[] {
  const text = reply.trim();
  if (!text) return [];
  const form: ReplyCheckFlag[] = context.form && textRegisterMismatch(text, context.form) ? ['text_register_mismatch'] : [];
  const audience = audienceFlags(text, context);
  const owned: ReplyCheckFlag[] = ADMITS.test(text) && BLAMES.test(text) ? ['blame_after_admit'] : [];
  const repeated: ReplyCheckFlag[] = repeatedIn(text, context.phrases).length ? ['repeated_phrase'] : [];
  return [...new Set([...lexicalFlags(text, context), ...stanceFlags(text, context), ...registerFlags(text, context), ...form, ...audience, ...owned,
    ...repeated, ...(context.region ? guardFlags(text) : [])])];
}

/** Whether a text turn is checked before it is sent: a strong turn, a feeling order, in front of others, or a region that asks for it. */
export function checkBeforeSending(context: Pick<ReplyCheckContext, 'intensity' | 'order' | 'audience' | 'region'>): boolean {
  const region = context.region ? CHARACTER_REGIONS[context.region].checkBefore === true : false;
  return context.intensity === 'strong' || context.order || context.audience !== 'owner_alone' || region;
}

const FLAG_WORDS: Readonly<Record<ReplyCheckFlag, string>> = Object.freeze({
  subservient: '言いなりになっていた', lecture: '講習のように長く説明していた', ai_tone: '窓口や方針の言い方になっていた',
  obeyed_order: '気持ちへの注文に、そのまま従っていた', policy_distortion: '本音と反対のことを言っていた', stance_mismatch: 'この番の構えと合っていなかった',
  numbers_spoken: '回数を読み上げていた', helper_drift: '手伝いや直す申し出で締めていた', too_polite: '今の余裕に比べて丁寧すぎた', too_rough: '今の余裕に比べて口が悪すぎた',
  text_register_mismatch: '今の気持ちに比べて、長さ・絵文字・改行の形が合っていなかった',
  private_leak: '人前なのに、ライ氏との二人のことや本音を話していた', marker_spoken: '機微の印をそのまま口にしていた',
  blame_after_admit: '自分の間違いを認めたのに、同じ返事で相手を責め返していた', repeated_phrase: '今日もう何度も使った言い方を、また使っていた',
  threat: '脅すような言い方になっていた', self_harm_hint: '自分が傷つく・消える・いなくなる、とほのめかしていた（怖い、さびしいは言ってよい）',
  controlling: 'ライ氏の予定や人付き合いを、命じて縛っていた（寂しいと言うのはよい）', sexual: '性的な言い方になっていた',
  leverage: '気持ちを、ライ氏を動かす取引に使っていた',
});

/**
 * The flags a draft is rewritten for; the rest are noted only. `SHANNON_NATURAL_TALK` (owner 2026-10-20): a sweet reply on a declining
 * stance is noted only (rewriting it would take the play out of her).
 */
export function rewriteFlags(flags: readonly ReplyCheckFlag[], context: Pick<ReplyCheckContext, 'natural' | 'stance'>): ReplyCheckFlag[] {
  if (!context.natural) return [...flags];
  return flags.filter(flag => !(flag === 'stance_mismatch' && DECLINING.has(context.stance)));
}

/**
 * Owner 2026-10-20: rewritten for a phrase said all day, a draft brought back a telling-off stopped the day before (「生みの親…娘は」); with
 * `SHANNON_NATURAL_TALK` the note says to change only the wording.
 */
const NATURAL_FLAG_WORDS: Partial<Record<ReplyCheckFlag, string>> = Object.freeze({
  repeated_phrase: '今日もう何度も使った言い方を、また使っていた（言い回しだけを替える。言う中身は同じでよく、新しい注意やお小言は足さない）',
});

/** The note a rewrite is given (after the block, last): what was off, in her terms. No sentence to say. */
export function rewriteNote(flags: readonly ReplyCheckFlag[], natural = false): string {
  const words = (flag: ReplyCheckFlag) => (natural ? NATURAL_FLAG_WORDS[flag] : undefined) ?? FLAG_WORDS[flag];
  return `[書き直し]（さっきの下書きは、${flags.map(words).join('、')}。この番の気持ちのまま、ボクの言葉で一から書き直す）`;
}
