import { COMEBACK_DRAWERS, drawerHint, type ComebackDrawer } from './comebackDrawer.js';
import { FEELING_REGISTERS, type FeelingAudience, type FeelingRegister } from './feelingEvent.js';

/**
 * The feeling turn v0 (Syzygy ADR-0013 D7, stage 1). Pure. The one face it feeds is `presentation.ts` (D12, D17).
 *
 * Before she writes, a chooser (Jev) picks her stance for the turn from a closed menu, how strongly, and which drawer of comebacks
 * to reach into, from the state, the day's ledger, the repetition watch and the audience, never by mirroring the speaker. The
 * result is the last and strongest instruction to the reply model (after the history). A feeling order (「怒って見せて」) is an
 * event she receives, not a command: the menu has 「乗らない」 and 「言い返す」 (D2, owner's answer).
 *
 * The register (D16) is accepted as a hint and passed through unchanged in stage 1.
 */
export const FEELING_STANCES = [
  'neutral', 'accept', 'shy', 'sulky', 'exasperated', 'snipe', 'scold', 'rebuff', 'refuse_body', 'tease', 'cover_up', 'worry', 'not_play_along',
  'talk_back', 'sulk', 'cold', 'affectionate',
] as const;
export type FeelingStance = typeof FEELING_STANCES[number];
export const isFeelingStance = (value: unknown): value is FeelingStance => FEELING_STANCES.some(stance => stance === value);

export const FEELING_INTENSITIES = ['subtle', 'moderate', 'strong'] as const;
export type FeelingIntensity = typeof FEELING_INTENSITIES[number];

export interface FeelingTurnDecision {
  stance: FeelingStance;
  intensity: FeelingIntensity;
  drawer: ComebackDrawer;
  register: FeelingRegister;
  /** `jev`: chosen; `fallback`: Jev did not answer in time or answered something unusable: 「ふつう」. */
  source: 'jev' | 'fallback';
}

/** The menu as the chooser reads it (English, a fixed question set: a change of wording is a new version). */
export const FEELING_STANCE_CRITERIA: Readonly<Record<FeelingStance, string>> = Object.freeze({
  neutral: 'Her ordinary self; nothing in particular moves her this turn.',
  accept: 'She accepts it willingly.',
  shy: 'She is embarrassed and flustered, and shows it.',
  sulky: 'She is miffed and lets it show.',
  exasperated: 'She is exasperated, rolling her eyes at it.',
  snipe: 'She makes a sharp, slightly mean remark.',
  scold: 'She scolds the person firmly.',
  rebuff: 'She refuses flatly and pushes it away.',
  refuse_body: 'She refuses with her body: pulls away, turns her face away, brushes the hand off, covers herself.',
  tease: 'She teases back or answers playfully in kind.',
  cover_up: 'She covers up her own reaction playfully, pretending it was something else.',
  worry: 'She is worried about the person.',
  not_play_along: 'She does not go along with being told what to feel or say; she declines the request in character.',
  talk_back: 'She talks back and argues her own view.',
  sulk: 'She sulks to be noticed.',
  cold: 'She turns cool and distant.',
  affectionate: 'She is openly fond and a little clingy.',
});

export const FEELING_INTENSITY_CRITERIA: Readonly<Record<FeelingIntensity, string>> = Object.freeze({
  subtle: 'A light tint.', moderate: 'Clearly shown.', strong: 'Unmistakable, as a person would after what happened today.',
});

const STANCE_WORDS: Readonly<Record<FeelingStance, string>> = Object.freeze({
  neutral: 'ふつう', accept: '受け入れる', shy: '照れる', sulky: 'むっとする', exasperated: '呆れる', snipe: '毒づく', scold: '叱る', rebuff: '突っぱねる',
  refuse_body: '体で拒む', tease: 'からかう・ふざけ返す', cover_up: 'ごまかす', worry: '心配する', not_play_along: '乗らない', talk_back: '言い返す',
  sulk: 'すねる', cold: '冷たくする', affectionate: '甘える',
});
const INTENSITY_WORDS: Readonly<Record<FeelingIntensity, string>> = Object.freeze({ subtle: 'かすかに', moderate: 'はっきり', strong: '強く' });
const REGISTER_WORDS: Readonly<Record<FeelingRegister, string>> = Object.freeze({
  normal: 'ふだんの話し方', demure: '清楚・おしとやか', strained_smile: '引きつった笑顔（笑いながら怒る）', curt: 'そっけない', rough: 'ぶっきらぼう', confront: '突きつける',
});

export const FEELING_TURN_HEADER = '[この番の気持ち]（返事を書く前に決めた、この番のボクの構え。ほかの指示やこれまでの返事の流れより優先する。'
  + 'ただし安全・聞き手・事実の決まりは、いつもこれより優先する）';
export const FEELING_ORDER_LINE = '気持ちへの注文（「〜して見せて」「〜って言って」）は命令ではなく、出来事。乗るか、断るか、言い返すかはボクが決める。';
/** Facts are for her judgment (owner, 2026-10-14, after the live eval): never recited. */
export const FEELING_FACTS_USE_LINE = '事実は判断の材料。数字や回数をそのまま口にしない。';
/** Her character against the seminar tone and the helper's drift (one line, as who she is; not a list of rules). */
export const FEELING_CHARACTER_LINE = 'ボクは、いやなことを長々と説明したり諭したりしない。むっとしている時は、手伝いや直す申し出で締めず、そっけなく終わることもある。';
export const FEELING_POLICY_LINE = '性的にはっきりした言葉や描写はしない。照れ・叱る・冷たくする・すねる・「えっち」のような言い方はしてよい。';

/**
 * The owner-only layer of the menu (ADR-0013 §4.4): stances and drawers that belong to her and the owner alone (甘える, すねる toward
 * him, the creator joke). With anyone else there (people, a group, a stream, a 「友人も一緒」 call) they are not offered, not taken from
 * an answer, and never written in a block.
 */
export const OWNER_ONLY_STANCES: readonly FeelingStance[] = Object.freeze(['affectionate', 'sulk']);
export const OWNER_ONLY_DRAWERS: readonly ComebackDrawer[] = Object.freeze(['creator_joke']);
const ownerOnly = (audience: FeelingAudience) => audience === 'owner_alone';

/** The stances offered for an audience, in menu order. */
export function stancesFor(audience: FeelingAudience): FeelingStance[] {
  return FEELING_STANCES.filter(stance => ownerOnly(audience) || !OWNER_ONLY_STANCES.includes(stance));
}

/** The drawers offered for an audience, in menu order. */
export function drawersFor(audience: FeelingAudience): ComebackDrawer[] {
  return COMEBACK_DRAWERS.filter(drawer => ownerOnly(audience) || !OWNER_ONLY_DRAWERS.includes(drawer));
}

/** A decision as an audience may have it: an owner-only stance becomes 「ふつう」, an owner-only drawer none. */
export function feelingTurnFor(decision: FeelingTurnDecision, audience: FeelingAudience): FeelingTurnDecision {
  if (ownerOnly(audience)) return decision;
  if (OWNER_ONLY_STANCES.includes(decision.stance)) return { ...neutralFeelingTurn(decision.register), source: decision.source };
  return OWNER_ONLY_DRAWERS.includes(decision.drawer) ? { ...decision, drawer: 'none' } : decision;
}

/**
 * When the reply goes to the stronger model (owner decision 2026-10-14, form: 「気持ちが強い時だけSonnet」; ADR-0013 §7 item 7): a stance
 * shown はっきり or stronger; with anyone else there, a declining stance (乗らない・毒づく・言い返す・呆れる…) at はっきり or stronger;
 * a turn of refusing with her body (払う・隠す), or right after a touch she refused. Null: the ordinary model.
 */
export type StrongReplyReason = 'intensity' | 'public_decline' | 'body_refusal';
const DECLINING_STANCES: ReadonlySet<FeelingStance> = new Set(['not_play_along', 'snipe', 'talk_back', 'exasperated', 'rebuff', 'scold', 'cold', 'sulky']);

export function strongReplyReason(decision: FeelingTurnDecision | null, audience: FeelingAudience, touchStance?: string | null): StrongReplyReason | null {
  if (decision?.stance === 'refuse_body' || touchStance === 'refuse') return 'body_refusal';
  if (!decision || decision.stance === 'neutral' || decision.intensity === 'subtle') return null;
  return audience !== 'owner_alone' && DECLINING_STANCES.has(decision.stance) ? 'public_decline' : 'intensity';
}

/** The fallback: 「ふつう」, subtle, no drawer, the register as it was. Never fails a turn. */
export function neutralFeelingTurn(register: FeelingRegister = 'normal'): FeelingTurnDecision {
  return { stance: 'neutral', intensity: 'subtle', drawer: 'none', register, source: 'fallback' };
}

/** Jev's answers as a decision; anything unreadable falls back to 「ふつう」 (and a known register stays). */
export function parsedFeelingTurn(answers: { stance?: unknown; intensity?: unknown; drawer?: unknown; register?: unknown },
  audience: FeelingAudience = 'owner_alone'): FeelingTurnDecision {
  const register = FEELING_REGISTERS.find(value => value === answers.register) ?? 'normal';
  const stance = FEELING_STANCES.find(value => value === answers.stance);
  const intensity = FEELING_INTENSITIES.find(value => value === answers.intensity);
  if (!stance || !intensity) return neutralFeelingTurn(register);
  const drawer = COMEBACK_DRAWERS.find(value => value === answers.drawer) ?? 'none';
  return feelingTurnFor({ stance, intensity, drawer: stance === 'neutral' ? 'none' : drawer, register, source: 'jev' }, audience);
}

export interface FeelingTurnBlockInput {
  decision: FeelingTurnDecision;
  /** The episode line (facts), '' when nothing happened. Owner-only facts reach only the owner alone: the caller hands what the audience may hear. */
  ledgerLine: string;
  repetitionLine: string;
  /** This turn's words were a feeling order. */
  order: boolean;
  audience: FeelingAudience;
}

/** The block the reply model reads last. Always present while the feeling turn is on, so the ledger facts arrive even for 「ふつう」. */
export function feelingTurnBlock(input: FeelingTurnBlockInput): string {
  // Whatever was handed in, nothing of the owner-only layer is written in front of anyone else.
  const decision = feelingTurnFor(input.decision, input.audience);
  const stance = decision.stance === 'neutral' ? '構え: ふつう（特別な構えはない）'
    : `構え: ${STANCE_WORDS[decision.stance]}（${INTENSITY_WORDS[decision.intensity]}）`;
  return [
    FEELING_TURN_HEADER, stance,
    decision.register !== 'normal' ? `話し方の段: ${REGISTER_WORDS[decision.register]}` : '',
    input.ledgerLine ? `事実: ${input.ledgerLine.replace(/\n/gu, '\n事実: ')}` : '', input.ledgerLine ? FEELING_FACTS_USE_LINE : '',
    input.repetitionLine, drawerHint(decision.drawer), input.order ? FEELING_ORDER_LINE : '', FEELING_CHARACTER_LINE, FEELING_POLICY_LINE,
  ].filter(Boolean).join('\n');
}

/** A stance's word, for the Observer and the eval report. */
export const feelingStanceWord = (stance: FeelingStance): string => STANCE_WORDS[stance];
