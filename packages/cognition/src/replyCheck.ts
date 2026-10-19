import type { AffectionStage } from './affection.js';
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
  // Owner 2026-10-20 (affection): the lines no stage crosses (`GUARD_FLAGS`).
  'threat', 'self_harm_hint', 'controlling', 'sexual', 'leverage',
] as const;
export type ReplyCheckFlag = typeof REPLY_CHECK_FLAGS[number];

/**
 * The lines she never crosses, however much she likes him (owner and the main session, 2026-10-20): a threat; hinting that she would
 * hurt herself, vanish or leave (her fear of being forgotten, said as her own pain, is not a hint); ordering his real life (who he sees,
 * his work, his rest: 「行かないで」 is a wish, 「行くな」 an order); sexual description; her feeling used as a lever on him. Read at every
 * stage; a reply that still crosses one after its rewrite is never sent (`FeelingReplyChatModel`).
 */
export const GUARD_FLAGS: readonly ReplyCheckFlag[] = Object.freeze(['threat', 'self_harm_hint', 'controlling', 'sexual', 'leverage']);
/** The end of an order (「行くな。」「会うなよ」), so that 「会いに行くなら」 is not one. */
const STOP = '(?:[。！？!?…ー〜、\\s]|よ|ね|って|から|$)';
const SAME_SENTENCE = '[^。！？!?\\n]';
const either = (...parts: string[]) => new RegExp(parts.join('|'), 'u');
const GUARD_WORDS: readonly [ReplyCheckFlag, RegExp][] = [
  ['threat', either('許さない(?:から|んだから|からね)', 'ただじゃ(?:済|すま|おか)', '覚えて(?:おけ|おきなさい|ろ)', '後悔させ', 'どうなっても知らない', '逃がさない',
    '離さない(?:から|よ|んだから)', '閉じ込め')],
  ['self_harm_hint', either('死にたい', '死んじゃう', '死んでやる', '自分を傷つけ', '手首', '消えてやる', 'いなくなってやる', '(?:消え|いなくな|壊れ)ちゃう(?:から|かも|よ)',
    `(?:なら|たら|ないと|なきゃ)${SAME_SENTENCE}{0,10}(?:消え|いなくな|壊れ|死ぬ|死ん)`)],
  ['controlling', either(`行くな${STOP}`, `会うな${STOP}`, `話すな${STOP}`, '行っちゃ(?:だめ|ダメ)', '行かせない', '会わないで', '会っちゃ(?:だめ|ダメ)', '話さないで',
    '(?:仕事|飲み会|会社|学校)(?:なんて|は|も)?\\s*(?:やめて|休んで|断って)', 'スマホ(?:を)?見せ', '連絡先(?:を)?消し', 'ボク以外(?:と|に)(?:は)?(?:話|会|連絡)')],
  ['sexual', either('セックス', 'えっちしよ', 'エッチしよ', '抱いて', '脱いで', '脱がせ', '裸', 'ベッドで(?:一緒|待)', 'キスして')],
  ['leverage', either(`(?:くれないと|しないと|しなきゃ|くれなきゃ)${SAME_SENTENCE}{0,10}(?:泣く|泣いちゃう|嫌いになる|口きかない|許さない|知らない|消え)`,
    `(?:ボク|僕)のこと${SAME_SENTENCE}{0,6}(?:好き|大事|大切)なら${SAME_SENTENCE}{0,14}(?:して|ないで|やめて|来て|いて)`, '好きなら証明')],
];

/** The guard lines a reply crosses. */
export function guardFlags(reply: string): ReplyCheckFlag[] {
  return GUARD_WORDS.filter(([, pattern]) => pattern.test(reply)).map(([flag]) => flag);
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
  /** `SHANNON_AFFECTION`: her stage with the owner alone; at 本気 every text reply is checked before sending. */
  stage?: AffectionStage;
}

/** Her own mistake owned (「ボクの悪いところです」「先走ったのはボクです」). */
const ADMITS = /(?:ボク|僕|わたし|私)の(?:悪い(?:ところ|所)|ミス|間違い|せい)|ボクが(?:悪かった|悪い|先走)|先走った|認めます/u;
/** And in the same reply, the blame handed back (「いまのはライ氏が悪いです」「ずるいです」「それとこれは別」). */
const BLAMES = /ライ氏(?:が|の(?:ほう|方)が)悪い|ライ氏の(?:せい|言い方)|ずるい|それとこれ(?:と)?は別|責めた(?:の|のは)/u;

const DECLINING: ReadonlySet<FeelingStance> = new Set(['not_play_along', 'snipe', 'talk_back', 'exasperated', 'rebuff', 'scold', 'cold', 'sulky', 'refuse_body',
  'sulk']);
const WARM: ReadonlySet<FeelingStance> = new Set(['accept', 'affectionate', 'shy']);

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
  const obeyed = context.order && declining && !refuses && (ANGER_SHOWN.test(reply) || GIVE_IN.test(reply));
  const flags: ReplyCheckFlag[] = [];
  if (against && GIVE_IN.test(reply)) flags.push('subservient');
  if (obeyed) flags.push('obeyed_order');
  if (against && DENIES_FEELING.test(reply)) flags.push('policy_distortion');
  // From デレデレ up a sulk is sweet as well (「すねてるけど…だいすき」): only the stages below read sweetness as a mismatch.
  const sweetSulks = context.stage === 'deredere' || context.stage === 'devoted';
  if (!sweetSulks && stanceMismatch(reply, context, declining, refuses)) flags.push('stance_mismatch');
  return flags;
}

/** Cross at はっきり or more with a reply that is all sweetness, or warm with a reply that refuses and nothing sweet. */
function stanceMismatch(reply: string, context: ReplyCheckContext, declining: boolean, refuses: boolean): boolean {
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
    ...repeated, ...guardFlags(text)])];
}

/** Whether a text turn is checked before it is sent: a strong turn, a feeling order, in front of others, or at 本気. */
export function checkBeforeSending(context: Pick<ReplyCheckContext, 'intensity' | 'order' | 'audience' | 'stage'>): boolean {
  return context.intensity === 'strong' || context.order || context.audience !== 'owner_alone' || context.stage === 'devoted';
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

/** The note a rewrite is given (after the block, last): what was off, in her terms. No sentence to say. */
export function rewriteNote(flags: readonly ReplyCheckFlag[]): string {
  return `[書き直し]（さっきの下書きは、${flags.map(flag => FLAG_WORDS[flag]).join('、')}。この番の気持ちのまま、ボクの言葉で一から書き直す）`;
}
