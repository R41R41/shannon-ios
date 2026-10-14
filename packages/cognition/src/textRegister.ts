import type { FeelingAudience, FeelingRegister } from './feelingEvent.js';
import type { FeelingIntensity, FeelingStance } from './feelingTurn.js';

/**
 * Her text register and pacing (Syzygy ADR-0013 stage 2 item 10; owner's choice from the comparison page, 2026-10-14: 「B. 形＋間と分け方」;
 * `SHANNON_TEXT_REGISTER`). Pure. From the feeling turn and the register her composure holds, one directive per text reply: the form the
 * model is asked to write in (length, punctuation and 「……」, emoji, sentence endings, line breaks), and how a device paces it (a pause
 * before the typing indicator when she sulks, at most 20 s; how long the indicator shows; two messages, the first sentence and then the
 * rest). The model writes every word; nothing here is a line to say. Urgent, safety and promise notices, and system notices, bypass the
 * pacing (`TEXT_PACING_BYPASSES`), and a system notice never gets an emoji.
 */
export const TEXT_REGISTER_LIMITS = Object.freeze({ maximumPauseMilliseconds: 20_000, maximumTypingMilliseconds: 8_000 });

export type TextLength = 'short' | 'medium' | 'free';
export type TextEmoji = 'free' | 'rare' | 'none';
export type TextEndings = 'soft' | 'polite' | 'flat' | 'firm' | 'curt' | 'rough';
export type TextPunctuation = 'ordinary' | 'clipped' | 'trailing';
export const TEXT_PACING_BYPASSES = ['urgent', 'safety', 'promise', 'system'] as const;
export type TextPacingBypass = typeof TEXT_PACING_BYPASSES[number];

export interface TextRegisterDirective {
  version: 1;
  /** The form the model was asked to write in. `maxCharacters` 0: no limit (an ordinary turn keeps its length). */
  length: TextLength;
  maxCharacters: number;
  punctuation: TextPunctuation;
  emoji: TextEmoji;
  endings: TextEndings;
  lineBreaks: boolean;
  /** The least time from his message to her typing indicator (her sulking silence), 0..20 000 ms. */
  pauseMs: number;
  /** The least time her typing indicator shows before her first message. */
  typingMs: number;
  /** Two messages when the reply has two sentences or more: the first sentence, then the rest. */
  split: boolean;
  /** The typing between the two messages. */
  gapMs: number;
}

export interface TextRegisterInput {
  stance: FeelingStance;
  intensity: FeelingIntensity;
  /** The register her composure holds now (D16), or the turn's. */
  register: FeelingRegister;
  audience: FeelingAudience;
}

type Shape = Omit<TextRegisterDirective, 'version'>;

const ORDINARY: Shape = { length: 'free', maxCharacters: 0, punctuation: 'ordinary', emoji: 'rare', endings: 'polite', lineBreaks: true,
  pauseMs: 0, typingMs: 0, split: false, gapMs: 0 };
const WARM: Shape = { ...ORDINARY, length: 'medium', maxCharacters: 120, emoji: 'free', endings: 'soft', typingMs: 1_200, split: true, gapMs: 900 };
const CROSS: Shape = { length: 'short', maxCharacters: 50, punctuation: 'clipped', emoji: 'none', endings: 'flat', lineBreaks: false, pauseMs: 0,
  typingMs: 4_000, split: true, gapMs: 1_600 };
const FIRM: Shape = { ...CROSS, maxCharacters: 70, endings: 'firm', typingMs: 2_000, split: false, gapMs: 0 };
const SULK: Shape = { ...CROSS, maxCharacters: 30, punctuation: 'trailing', typingMs: 4_000 };

const WARM_STANCES: ReadonlySet<FeelingStance> = new Set(['accept', 'shy', 'affectionate', 'tease', 'cover_up', 'worry']);
const CROSS_STANCES: ReadonlySet<FeelingStance> = new Set(['sulky', 'exasperated', 'snipe', 'cold', 'talk_back', 'not_play_along']);
const FIRM_STANCES: ReadonlySet<FeelingStance> = new Set(['scold', 'rebuff', 'refuse_body']);

/** How much later she starts typing, per intensity: sulking keeps quiet longest (capped at 20 s), being miffed a little. */
const SULK_PAUSE: Readonly<Record<FeelingIntensity, number>> = Object.freeze({ subtle: 5_000, moderate: 12_000, strong: 20_000 });
const CROSS_PAUSE: Readonly<Record<FeelingIntensity, number>> = Object.freeze({ subtle: 0, moderate: 2_000, strong: 4_000 });
const CROSS_TYPING: Readonly<Record<FeelingIntensity, number>> = Object.freeze({ subtle: 3_000, moderate: 5_000, strong: 6_000 });

function stanceShape(input: TextRegisterInput): Shape {
  const { stance, intensity } = input;
  if (stance === 'sulk') return { ...SULK, pauseMs: SULK_PAUSE[intensity] };
  if (CROSS_STANCES.has(stance)) {
    return { ...CROSS, pauseMs: CROSS_PAUSE[intensity], typingMs: CROSS_TYPING[intensity], maxCharacters: intensity === 'strong' ? 30 : 50,
      endings: intensity === 'strong' ? 'curt' : 'flat' };
  }
  if (FIRM_STANCES.has(stance)) return FIRM;
  return WARM_STANCES.has(stance) ? WARM : ORDINARY;
}

/** The register her composure holds narrows the form: a worn reserve is short, plain and without emoji (D16, §4.8). */
function withRegister(shape: Shape, register: FeelingRegister): Shape {
  if (register === 'demure') {
    return { ...shape, endings: shape.endings === 'soft' ? 'polite' : shape.endings, emoji: shape.emoji === 'free' ? 'rare' : shape.emoji };
  }
  if (register === 'strained_smile') return { ...shape, endings: 'polite', emoji: shape.emoji === 'none' ? 'none' : 'rare' };
  if (register === 'normal') return shape;
  const short = shape.maxCharacters === 0 ? 80 : Math.min(shape.maxCharacters, 80);
  return { ...shape, length: shape.length === 'free' ? 'medium' : shape.length, maxCharacters: short, emoji: 'none', lineBreaks: false,
    endings: register === 'curt' ? 'curt' : 'rough' };
}

/** The directive of one text reply. In front of others her emoji stay rare at most (the owner-only warmth is his). */
export function textRegisterFor(input: TextRegisterInput): TextRegisterDirective {
  const shaped = withRegister(stanceShape(input), input.register);
  const emoji = input.audience !== 'owner_alone' && shaped.emoji === 'free' ? 'rare' : shaped.emoji;
  const pauseMs = Math.min(TEXT_REGISTER_LIMITS.maximumPauseMilliseconds, shaped.pauseMs);
  return Object.freeze({ version: 1, ...shaped, emoji, pauseMs, typingMs: Math.min(TEXT_REGISTER_LIMITS.maximumTypingMilliseconds, shaped.typingMs) });
}

/** A bypassed reply (urgent, safety, promise, system): delivered at once, whole, and a system notice without emoji. */
export function bypassedTextRegister(directive: TextRegisterDirective, bypass: TextPacingBypass): TextRegisterDirective {
  return Object.freeze({ ...directive, pauseMs: 0, typingMs: 0, split: false, gapMs: 0, ...(bypass === 'system' ? { emoji: 'none' as const } : {}) });
}

const LENGTH_WORDS = (directive: TextRegisterDirective) => (directive.maxCharacters
  ? `${directive.length === 'short' ? '短く' : 'ほどほどに'}（${directive.maxCharacters}字くらいまで）` : '');
const EMOJI_WORDS: Readonly<Record<TextEmoji, string>> = Object.freeze({ free: '使ってよい', rare: '使うなら一つまで', none: '使わない' });
const ENDING_WORDS: Readonly<Record<TextEndings, string>> = Object.freeze({
  soft: 'やわらかく（「〜ですよ」「〜かな」）', polite: 'ていねいに', flat: '平らに言い切る（「〜ません。」）', firm: 'きっぱり言い切る',
  curt: 'そっけなく短く切る', rough: 'ぶっきらぼうに',
});
const PUNCTUATION_WORDS: Readonly<Record<TextPunctuation, string>> = Object.freeze({
  ordinary: '', clipped: '「。」で短く切る', trailing: '「……」で言いよどんでよい',
});

/** The form, as lines for the reply model (after the feeling turn's block). The words stay hers. */
export function textRegisterLines(directive: TextRegisterDirective): string {
  return [
    '[この番の書き方]（気持ちに合わせた文字の形。言葉はボクが決める）',
    directive.maxCharacters ? `- 長さ: ${LENGTH_WORDS(directive)}` : '',
    `- 絵文字: ${EMOJI_WORDS[directive.emoji]}`,
    `- 文末: ${ENDING_WORDS[directive.endings]}`,
    PUNCTUATION_WORDS[directive.punctuation] ? `- 句読点: ${PUNCTUATION_WORDS[directive.punctuation]}` : '',
    directive.lineBreaks ? '' : '- 改行: しない',
    directive.split ? '- 二通に分けて届くことがある（最初の一文が先に届く）。一文目だけでも通じるように書く' : '',
  ].filter(Boolean).join('\n');
}

/** The form a reply is checked against (D8): its length band, emoji and line breaks. */
export type TextRegisterForm = Pick<TextRegisterDirective, 'maxCharacters' | 'emoji' | 'lineBreaks'>;

const EMOJI = /\p{Extended_Pictographic}/gu;

/** Whether a reply's form is not the one her state asked for: far too long, emoji where none (or more than one where rare), line breaks. */
export function textRegisterMismatch(reply: string, form: TextRegisterForm): boolean {
  const text = reply.trim();
  const emoji = (text.match(EMOJI) ?? []).length;
  const long = form.maxCharacters > 0 && Array.from(text).length > Math.ceil(form.maxCharacters * 1.5);
  const emojiOff = (form.emoji === 'none' && emoji > 0) || (form.emoji === 'rare' && emoji > 1);
  return long || emojiOff || (!form.lineBreaks && /\n\s*\S/u.test(text));
}

const URGENT = /緊急|至急|今すぐ(?:に)?(?:逃げ|避難|連絡|電話)|地震|津波|火事|火災|避難|救急|119|110番|警察/u;
const SAFETY = /死にたい|消えたい|自殺|自傷|命に関わ|危険です|危ないので|助けて/u;

/** Whether this turn's words (his or hers) are an urgent or safety matter: delivered at once, whatever her mood. */
export function textPacingBypassIn(message: string, reply: string): TextPacingBypass | null {
  if (SAFETY.test(message) || SAFETY.test(reply)) return 'safety';
  return URGENT.test(message) || URGENT.test(reply) ? 'urgent' : null;
}
