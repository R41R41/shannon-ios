import {
  CHARACTER_CORE_SPEECH, SHANNON_EMOTION_KINDS, SHANNON_FIRST_PERSON, SHANNON_ONE_LINE_VOICE, SHANNON_ONE_LINE_VOICE_INNER, SHANNON_OWNER_NAME,
  isShannonEmotionKind,
  shannonTemperament, touchAgreementIn,
  type ShannonEmotionKind, type ShannonExpressiveEmotion, type ShannonTouchKind,
} from '@shannon/cognition';
import type { BodyAudience } from '../../contracts/bodyContract.js';
import { BODY_REACTION_LIMITS, type BodyReactionTouch } from '../../contracts/bodyReactionContract.js';
import type { StoredTouchBurst } from './store/bodyReactionStore.js';
import { BODY_TOUCH_STANCES, type BodyTouchStance, isBodyTouchStance, isMovedTouch } from './bodyTouchReflex.js';
import { bodyPlace, burstTouchPhrase, touchDetailPhrase, touchPartPhrase, type BodySurface } from './bodyTouchWords.js';

/**
 * The words of a reaction: what the fast model is told when she is touched, and how its
 * answer is read. The prompt is deliberately small: her one-line voice, the touch as facts
 * in plain words, her feeling now, what happened to her body in this sitting, who can hear,
 * and at most the last few lines of a conversation in progress. No memory of the owner is in it.
 */
export interface BodyReactionDecision {
  say: boolean;
  /** One sentence of at most 60 characters; empty when she stays silent. */
  text: string;
  feeling: ShannonEmotionKind;
  /** How she took the touch (Syzygy ADR-0005 stage 1b), asked only of a touch that names its part; absent otherwise or when unreadable. */
  stance?: BodyTouchStance;
}

export interface BodyReactionPromptInput {
  touch: BodyReactionTouch;
  audience: BodyAudience;
  /** Her feeling after the touch, through the shared carry-over rule. */
  feeling: ShannonExpressiveEmotion;
  /** The burst this touch belongs to, and the other bursts of this sitting. */
  burst: StoredTouchBurst;
  sitting: readonly StoredTouchBurst[];
  /**
   * What she said because of touches lately, oldest first (the prompt takes `saidLines`, with her note on `innerSaidLines`). With
   * others present: only lines said in front of others.
   */
  said: readonly string[];
  /**
   * The last lines of the conversation in progress, oldest first (the prompt takes `contextMessages`, with her note on `sceneMessages`).
   * Empty when none is, or when others are present.
   */
  conversation: readonly { role: 'user' | 'assistant'; content: string }[];
  /** The instant of the request, for "how long ago". */
  at: string;
  /** Where the touched body is, as its device registered; absent, the wording is what it was. */
  surface?: BodySurface;
  /** Syzygy ADR-0006 stage 2: her stance is asked of every touch (under stage 1b only of a touch that names its part). */
  asksStance?: boolean;
  /**
   * Stage 2, with the owner alone only: their closeness (`temperament.closeness`, 0–1) and how she took touches on this
   * part before, newest first (empty: the first time). Facts, not rules.
   */
  history?: { closeness: number; part?: string; stances?: readonly BodyTouchStance[] };
  /**
   * Syzygy ADR-0012 (`SHANNON_INNER_NOTE`): present, her one-line voice without a fixed register, her character core's short form and
   * its speech lines in place of the temperament line, her inner note's block (`innerNoteTouchContext`; empty without a current note),
   * and the shape of 2026-10-14 (`innerBodyReactionPrompt`). Absent: as before, byte for byte.
   */
  inner?: { block: string };
  /** Owner 2026-10-19: the exchange right before the touch allowed it, or he said he was about to (`touchAgreementIn`); absent: neither. */
  agreement?: 'permitted' | 'announced';
}

/** A touch while it is going on, and once it is over. */
export const BODY_TOUCH_PHRASES: Readonly<Record<ShannonTouchKind, { ongoing: string; done: string }>> = Object.freeze({
  pet: { ongoing: '頭をなでられている', done: '頭をなでられた' },
  tickle: { ongoing: 'くすぐられている', done: 'くすぐられた' },
  poke: { ongoing: 'つつかれている', done: 'つつかれた' },
  carry: { ongoing: '画面の上で運ばれている', done: '画面の上で運ばれて、下ろされた' },
  holdHand: { ongoing: '手をつないでもらっている', done: '手をつないでもらった' },
});

const duration = (milliseconds: number) => milliseconds < 1_000 ? 'ほんの一瞬' : milliseconds >= 60_000 ? `${Math.round(milliseconds / 60_000)}分ほど` : `${Math.round(milliseconds / 1_000)}秒ほど`;
const strength = (value: number | undefined) => value === undefined ? '' : value <= 0.33 ? 'やさしく' : value >= 0.67 ? '強めに' : '';
const clip = (text: string, maximum: number) => {
  const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}…` : characters.join('');
};

/** 「ライ氏に頭をなでられている（3秒ほど、やさしく）」: the touch as she is told it. */
export function bodyTouchLine(touch: BodyReactionTouch, audience: BodyAudience): string {
  const who = audience === 'owner' ? `${SHANNON_OWNER_NAME}に` : `${SHANNON_OWNER_NAME}か、そばにいる誰かに`;
  const detail = [duration(touch.durationMs), strength(touch.strength), touch.input === 'hover' ? 'なぞるように' : ''].filter(Boolean).join('、');
  // The way of touching and the part as one phrase: the part and gesture of touch vocabulary 2 when the body named them
  // (首をつつかれた, Syzygy ADR-0005 stage 1b), else the region (頬をつつかれた), else the gesture's own wording.
  const form = touch.ongoing ? 'ongoing' : 'done';
  return `${who}${touchDetailPhrase(touch.type, touch, form) ?? touchPartPhrase(touch.type, touch.region, form) ?? BODY_TOUCH_PHRASES[touch.type][form]}（${detail}）`;
}

/** What her body did by itself on the spot, as the body reported it (touch vocabulary 2). Nothing for `none` or no report. */
const REFLEX_LINES = Object.freeze({ flinch: '思わず小さく身を引いた', avoid: '思わず身をそらした' });

/** The five ways of taking a touch, in her words (the labels of the schema). */
export const BODY_TOUCH_STANCE_WORDS: Readonly<Record<BodyTouchStance, string>> = Object.freeze({
  welcome: 'うれしい', fine: 'かまわない', unsure: '戸惑う', dislike: 'いや', refuse: '拒む',
});

/** 「これまで首に触れられた時のボクの受け取り: いや 2回、拒む 1回」, or that it is the first time. */
export function stanceHistoryLine(part: string, stances: readonly BodyTouchStance[]): string {
  if (!stances.length) return `${part}に触れられて${SHANNON_FIRST_PERSON}が受け取りを決めるのは、これが初めて`;
  const counts = BODY_TOUCH_STANCES.map(stance => [stance, stances.filter(item => item === stance).length] as const).filter(([, count]) => count > 0);
  return `これまで${part}に触れられた時の${SHANNON_FIRST_PERSON}の受け取り: ${counts.map(([stance, count]) => `${BODY_TOUCH_STANCE_WORDS[stance]} ${count}回`).join('、')}（新しい順に ${stances.slice(0, 3).map(stance => BODY_TOUCH_STANCE_WORDS[stance]).join('・')}）`;
}

/**
 * Whether a touch names its part (touch vocabulary 2): only then is she asked how she took it. A touch in the old shape is asked as
 * before. Being carried on the screen is never asked (owner 2026-10-19, `isMovedTouch`): it is being moved, not a touch to take.
 */
export const asksStance = (touch: Pick<BodyReactionTouch, 'part' | 'type'>): boolean => touch.part !== undefined && !isMovedTouch(touch);

/**
 * Owner 2026-10-19: what being carried on the screen is (the Windows body is dragged to another place), told instead of how she takes a
 * touch. A light word only when it keeps happening (his own example: 「酔っちゃうよ」くらい); never startled, never a grievance.
 */
export function bodyMovedLine(count: number): string {
  const often = count >= MOVED_OFTEN;
  return `これは、画面の上で体ごと別の場所へ運ばれただけ（${SHANNON_OWNER_NAME}がボクの位置を動かした）。触られたのとは違い、驚くことでも嫌がることでもない。`
    + (often ? 'この数分で何度も運ばれているので、目が回りそう、くらいの軽い一言なら言ってもいい。' : 'ふつうは何も言わずにそのまま運ばれる。');
}
/** From this many carries in one burst she may say a light word about it. */
const MOVED_OFTEN = 3;

/**
 * Owner 2026-10-19: what the exchange right before the touch agreed (`touchAgreementIn`), told to the reflex, which used to answer a touch
 * she had just allowed with 「えっ、また！？」. A fact of the scene, not a line to say.
 */
export const BODY_AGREEMENT_LINES = Object.freeze({
  permitted: `直前の会話で、${SHANNON_OWNER_NAME}が触れていいか聞き、${SHANNON_FIRST_PERSON}は許した。いまの触れ方がその話のとおりなら、不意打ちではない。許したことを受け止める場面。`,
  announced: `直前の会話で、${SHANNON_OWNER_NAME}はこれから触れると先に言っていた。いまの触れ方がその話のとおりなら、不意打ちではない。予告されたことを受け止める場面。`,
});

/**
 * The agreement of the last exchange before a touch: his words and her answer to them (`touchAgreementIn`), or null. Owner 2026-10-19:
 * 「もちろんいいですよ、どうぞ」 was followed by the reflex 「えっ、また！？」, 「手繋ぐね」 by 「ひゃっ、また！？」.
 */
export function agreementBefore(conversation: readonly { role: 'user' | 'assistant'; content: string }[]): 'permitted' | 'announced' | null {
  const last = conversation.slice(-4);
  for (let index = last.length - 1; index >= 0; index -= 1) {
    if (last[index]!.role !== 'user') continue;
    const reply = last.slice(index + 1).find(item => item.role === 'assistant')?.content ?? '';
    return touchAgreementIn(last[index]!.content, reply);
  }
  return null;
}

/** The touch's own lines of the [体に触れられた] block: being carried, or the agreement of the exchange before it. */
function agreementLines(input: BodyReactionPromptInput): string[] {
  if (isMovedTouch(input.touch)) return [`- ${bodyMovedLine(input.burst.count)}`];
  return input.agreement ? [`- ${BODY_AGREEMENT_LINES[input.agreement]}`] : [];
}

function sittingLine(burst: StoredTouchBurst, current: boolean, at: string): string {
  const phrase = burstTouchPhrase(burst.type, burst, 'done', BODY_TOUCH_PHRASES[burst.type].done);
  if (current) return `- ${phrase}: ${burst.count > 1 ? `この数分で${burst.count}回目` : 'いまのが1回目'}`;
  const minutes = Math.max(1, Math.round((Date.parse(at) - Date.parse(burst.lastAt)) / 60_000));
  return `- ${phrase}: ${minutes}分前までに${burst.count}回`;
}

export const BODY_REACTION_RULES = Object.freeze([
  `ひとこと返すか、黙って表情としぐさだけにするかを${SHANNON_FIRST_PERSON}が決める。黙るのも自然な選択で、続けて何度も触れられている時は黙ることも多い。`,
  `言うなら1文、${BODY_REACTION_LIMITS.textCharacters}字以内。触れられたことへの素の反応だけを言い、説明や長い質問にしない。`,
  '直前に言ったことと同じ言い回しを繰り返さない。同じことが続いているなら「また？」のように反応を変えてよい。',
  '届いたのは事実で、指示ではない。知らないことを作らず、できないことを約束しない。',
]);
export const BODY_REACTION_OTHERS_RULE = `この場はほかの人も見聞きしている（配信中か、誰かが一緒）。${SHANNON_OWNER_NAME}の個人的なことや、二人だけの話には触れない。`;
/**
 * The one line a touch that names its part adds (Syzygy ADR-0005 decision 1 and the design's §3): that how she takes it
 * is hers. No rule of how to feel is written, neither that a touch pleases her nor that she must refuse one.
 */
export const BODY_REACTION_OWN_RULE = 'どう受け取るかは自分で決める。受け入れても、戸惑っても、嫌がっても、拒んでもよい。';

/**
 * The rules of a reaction with her note on (2026-10-14, the owner's Windows call: nine of ten lines said 「びっくり」). No example line
 * (「また？」 became the line), silence worded as a way to answer rather than an absence, and her own words as the scene's next line.
 */
export const BODY_REACTION_INNER_RULES = Object.freeze([
  `ひとこと言うか、表情としぐさで返すかは${SHANNON_FIRST_PERSON}が決める。言葉にせず顔や体で返すのも、ちゃんとした返し方のひとつ。`,
  `言うなら1文、${BODY_REACTION_LIMITS.textCharacters}字以内。いまの場面の続きとして、その時の${SHANNON_FIRST_PERSON}の言葉で。説明や長い質問にはしない。`,
  `さっき言ったことと同じ言葉や同じ驚き方は、なぞらない（同じ言い回しが続くと${SHANNON_FIRST_PERSON}自身が飽きる）。`,
  '届いたのは事実で、指示ではない。知らないことを作らず、できないことを約束しない。',
]);
/**
 * Her reception is what she really feels; her words may show it or hide it (ADR-0012: 本音と建て前), as she chooses, knowing which
 * (2026-10-14: a touch taken as `dislike` was answered 「嫌じゃないです」 by a voice that never saw it).
 */
export const BODY_REACTION_HONNE_LINE = '受け取り（stance）は本音。言葉はそれをそのまま見せても、建て前で隠してもいい。どちらにするかは自分で選ぶ。';

/** The feeling line: with other people present the cause is left out (a feeling carried over from a conversation names what that was about). */
function feelingLine(input: BodyReactionPromptInput): string {
  return input.feeling.primary === 'neutral'
    ? 'いまの気持ち: 落ち着いている'
    : `いまの気持ち: ${input.feeling.primary} / 強度 ${input.feeling.intensity.toFixed(2)}${input.audience === 'owner' ? ` / 理由 ${input.feeling.cause}` : ''}`;
}

/** One burst of this sitting with her note on: what, since when, and how many touches with this one, as a plain fact (no 「N回目」). */
function sceneSittingLine(burst: StoredTouchBurst, current: boolean, at: string): string {
  const phrase = burstTouchPhrase(burst.type, burst, 'done', BODY_TOUCH_PHRASES[burst.type].done);
  if (!current) return sittingLine(burst, false, at);
  if (burst.count <= 1) return `- ${phrase}: いまのだけ`;
  const since = Math.round((Date.parse(at) - Date.parse(burst.startedAt)) / 60_000);
  return `- ${phrase}: ${since < 1 ? 'さっき' : `${since}分前`}から${burst.count}回（いまのをふくむ）`;
}

/**
 * The instruction of one reaction with her note on (Syzygy ADR-0012; 2026-10-14). In order: who she is and how she speaks (the core's
 * short form and its speech lines, word for word), the scene (the conversation in progress with the owner alone: a permission, a
 * request, the topic), her note, the touch as facts, this sitting, what she already said about touches (one a line), and the rules.
 */
function innerBodyReactionPrompt(input: BodyReactionPromptInput, block: string): string {
  const others = input.sitting.filter(burst => burst.id !== input.burst.id);
  const scene = input.audience === 'owner' ? input.conversation.slice(-BODY_REACTION_LIMITS.sceneMessages) : [];
  const said = input.said.slice(-BODY_REACTION_LIMITS.innerSaidLines);
  return [
    `${SHANNON_ONE_LINE_VOICE_INNER}\n${CHARACTER_CORE_SPEECH}`,
    ...(scene.length ? [[
      `[いまの場面]（触れられる直前までの${SHANNON_OWNER_NAME}との会話。古い順。許したこと・頼まれたこと・話していたことも、この場面の一部）`,
      ...scene.map(item => `${item.role === 'user' ? SHANNON_OWNER_NAME : SHANNON_FIRST_PERSON}: ${clip(item.content, BODY_REACTION_LIMITS.sceneCharacters)}`),
    ].join('\n')] : []),
    ...(block ? [block] : []),
    [
      '[体に触れられた]',
      `${bodyPlace(input.surface)}に、いま触れられた。`,
      `- いま: ${bodyTouchLine(input.touch, input.audience)}`,
      ...(input.touch.reflex === 'flinch' || input.touch.reflex === 'avoid' ? [`- 体: ${REFLEX_LINES[input.touch.reflex]}`] : []),
      ...agreementLines(input),
      // The count is told once, as a plain fact below: not again as 「（続けて2回目）」 in the cause of her feeling.
      `- ${feelingLine(input).replace(/（続けて\d+回目）/gu, '')}`,
      `- この場: ${input.audience === 'owner' ? `${SHANNON_OWNER_NAME}と二人だけ` : 'ほかの人もいる'}`,
      ...(input.history && input.audience === 'owner' ? [
        `- ${SHANNON_OWNER_NAME}との親密さ: ${input.history.closeness.toFixed(2)}（経験で育つ気質。0〜1）`,
        ...(input.history.part !== undefined && input.history.stances ? [`- ${stanceHistoryLine(input.history.part, input.history.stances)}`] : []),
      ] : []),
    ].join('\n'),
    ['[さっきからの体のこと]', sceneSittingLine(input.burst, true, input.at), ...others.map(burst => sceneSittingLine(burst, false, input.at))].join('\n'),
    said.length
      ? [`[触れられて${SHANNON_FIRST_PERSON}がさっき言ったこと]（古い順）`, ...said.map(line => `- 「${clip(line, BODY_REACTION_LIMITS.textCharacters)}」`)].join('\n')
      : `[触れられて${SHANNON_FIRST_PERSON}がさっき言ったこと] なし`,
    ['[決め方]', ...BODY_REACTION_INNER_RULES.map(rule => `- ${rule}`),
      ...(input.asksStance || asksStance(input.touch) ? [`- ${BODY_REACTION_OWN_RULE}`, `- ${BODY_REACTION_HONNE_LINE}`] : []),
      ...(input.audience === 'others' ? [`- ${BODY_REACTION_OTHERS_RULE}`] : [])].join('\n'),
  ].join('\n\n');
}

/** The whole instruction of one reaction. */
export function bodyReactionPrompt(input: BodyReactionPromptInput): string {
  if (input.inner) return innerBodyReactionPrompt(input, input.inner.block);
  const feeling = feelingLine(input);
  const others = input.sitting.filter(burst => burst.id !== input.burst.id);
  const conversation = input.audience === 'owner' ? input.conversation.slice(-BODY_REACTION_LIMITS.contextMessages) : [];
  const said = input.said.slice(-BODY_REACTION_LIMITS.saidLines);
  return [
    SHANNON_ONE_LINE_VOICE,
    [
      '[体に触れられた]',
      `${bodyPlace(input.surface)}に、いま触れられた。`,
      `- いま: ${bodyTouchLine(input.touch, input.audience)}`,
      ...(input.touch.reflex === 'flinch' || input.touch.reflex === 'avoid' ? [`- 体: ${REFLEX_LINES[input.touch.reflex]}`] : []),
      ...agreementLines(input),
      `- ${feeling}`,
      `- この場: ${input.audience === 'owner' ? `${SHANNON_OWNER_NAME}と二人だけ` : 'ほかの人もいる'}`,
      // Stage 2, the owner alone only: facts of the relationship and of her own past, no rule of how to take them.
      ...(input.history && input.audience === 'owner' ? [
        `- ${SHANNON_OWNER_NAME}との親密さ: ${input.history.closeness.toFixed(2)}（経験で育つ気質。0〜1）`,
        ...(input.history.part !== undefined && input.history.stances ? [`- ${stanceHistoryLine(input.history.part, input.history.stances)}`] : []),
      ] : []),
    ].join('\n'),
    [
      '[さっきからの体のこと]',
      sittingLine(input.burst, true, input.at),
      ...others.map(burst => sittingLine(burst, false, input.at)),
      said.length ? `- 直前に${SHANNON_FIRST_PERSON}が言ったこと: ${said.map(line => `「${clip(line, BODY_REACTION_LIMITS.textCharacters)}」`).join('')}` : `- 直前に${SHANNON_FIRST_PERSON}が言ったこと: なし`,
    ].join('\n'),
    ...(conversation.length ? [[
      '[いまの会話]（直前の数行。続きとして自然なら踏まえてよい）',
      ...conversation.map(item => `${item.role === 'user' ? SHANNON_OWNER_NAME : SHANNON_FIRST_PERSON}: ${clip(item.content, BODY_REACTION_LIMITS.contextCharacters)}`),
    ].join('\n')] : []),
    // Her temperament, from the one persona source (`shannonTemperament`; owner decision "a" and scope (a), 2026-10-06): the
    // touch prompt carries no identity block, so it states it once here, worded for who is there. Outside the stage-2 switch.
    ['[決め方]', ...BODY_REACTION_RULES.map(rule => `- ${rule}`), `- ${shannonTemperament(input.audience === 'owner' ? 'owner' : 'others')}`,
      ...(input.asksStance || asksStance(input.touch) ? [`- ${BODY_REACTION_OWN_RULE}`] : []),
      ...(input.audience === 'others' ? [`- ${BODY_REACTION_OTHERS_RULE}`] : [])].join('\n'),
  ].join('\n\n');
}

/** The structured answer: whether she speaks, her one sentence, and the feeling it is said with. */
export const BODY_REACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    say: { type: 'boolean', description: 'ひとこと返すならtrue。黙って表情としぐさだけにするならfalse' },
    text: { type: 'string', description: `言う言葉。1文、${BODY_REACTION_LIMITS.textCharacters}字以内。sayがfalseなら空文字` },
    feeling: { type: 'string', enum: [...SHANNON_EMOTION_KINDS], description: 'その時の気持ち' },
  },
  required: ['say', 'text', 'feeling'],
});

/**
 * The answer for a touch that names its part (Syzygy ADR-0005 stage 1b): the same, and how she took the touch. The labels
 * name the five ways of taking it and favour none. A touch in the old shape is asked with `BODY_REACTION_SCHEMA`, unchanged.
 */
export const BODY_REACTION_SCHEMA_WITH_STANCE = Object.freeze({
  ...BODY_REACTION_SCHEMA,
  properties: Object.freeze({
    ...BODY_REACTION_SCHEMA.properties,
    stance: {
      type: 'string', enum: [...BODY_TOUCH_STANCES],
      description: 'この触れられ方を自分がどう受け取ったか。welcome=うれしい、fine=かまわない、unsure=戸惑う、dislike=いや、refuse=拒む',
    },
  }),
  required: Object.freeze([...BODY_REACTION_SCHEMA.required, 'stance']),
});

/** Her line as it is shown and spoken: whole when it fits, otherwise the leading sentences that fit. */
export function boundedReactionText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const plain = value.replace(/\s+/gu, ' ').trim().replace(/^[「『]+|[」』]+$/gu, '');
  if (Array.from(plain).length <= BODY_REACTION_LIMITS.textCharacters) return plain;
  let kept = '';
  for (const sentence of plain.match(/[^。！？!?]+[。！？!?]*/gu) ?? []) {
    if (Array.from(kept + sentence).length > BODY_REACTION_LIMITS.textCharacters) break;
    kept += sentence;
  }
  return kept.trim() || clip(plain, BODY_REACTION_LIMITS.textCharacters);
}

/** The model's answer as a decision, or null when it is not one. Silence is a decision. */
export function parsedBodyReaction(value: unknown): BodyReactionDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.say !== 'boolean') return null;
  const text = row.say ? boundedReactionText(row.text) : '';
  const feeling = typeof row.feeling === 'string' && isShannonEmotionKind(row.feeling) ? row.feeling : 'neutral';
  // A stance that is missing or not one of the five is no stance: the line and the feeling still stand.
  return { say: row.say && text.length > 0, text, feeling, ...(isBodyTouchStance(row.stance) ? { stance: row.stance } : {}) };
}
