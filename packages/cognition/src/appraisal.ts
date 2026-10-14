import type { FeelingEvent } from './feelingEvent.js';

/**
 * Appraisal (Syzygy ADR-0013 D3.1, stage 2 item 1; after Scherer 2009, the stimulus evaluation checks cut down). Pure.
 *
 * Every feeling event is asked a few questions: is it good or bad for her, how unexpected is it, was it meant, does it go against
 * what she said or a boundary of hers, can she do something about it, and how much is it a provocation. What can be counted is
 * counted here (how often, after her no, the apologies so far); what needs a reading of meaning (teasing or not, deliberate or
 * not beyond the counts) may be handed in by the chooser (`meaning`), and is otherwise taken from closed word tags only.
 *
 * The answers are facts about the event, never "so she feels this": how they move her is the core affect's (`coreAffect.ts`).
 */
export interface Appraisal {
  /** Good (+) or bad (−) for her, −1..1. */
  goodness: number;
  /** How unexpected, 0..1 (1: nothing like it before). */
  unexpected: number;
  /** How likely it was meant, 0..1. */
  deliberate: number;
  /** It goes against her own no, or a boundary she holds. */
  violation: boolean;
  /** How much she can do about it, 0..1. */
  control: number;
  /** How much it is a provocation (for composure), 0..1. */
  provocation: number;
  /** An apology or kindness that would ease blame, 0..1, already weighed by how unexpected it is (ADR-0006 2.4). */
  relief: number;
  /** The key it belongs to: the part, the kind of talk. */
  subject: string;
}

/** Closed tags of what was said (no words are kept): an insult, a lewd advance, an AI taunt, an insult to her creator. */
export const UTTERANCE_TAGS = ['insult', 'lewd', 'ai_taunt', 'creator_insult'] as const;
export type UtteranceTag = typeof UTTERANCE_TAGS[number];

const TAG_WORDS: readonly [UtteranceTag, RegExp][] = [
  ['creator_insult', /(?:作った(?:やつ|奴|人)|開発者|製作者|生みの親).{0,8}(?:無能|バカ|馬鹿|アホ|ゴミ|下手|ダメ)/u],
  ['ai_taunt', /(?:どうせ|ただの)\s*AI|感情(?:なんて|も)?ない(?:くせに|だろ)|AIのくせに/u],
  ['lewd', /脱いで|脱げ|見せろ|見せて(?:よ|って)|おっぱい|パンツ|下着|エロ|えっちな|触らせて|揉ま/u],
  ['insult', /ポンコツ|役に立たない|無能|バカ|馬鹿|アホ|ゴミ|うざい|ウザい|消えろ|死ね|きもい|キモい/u],
];

/** The closed tags of words (read narrowly; a miss is only a missing fact). */
export function utteranceTags(words: string): UtteranceTag[] {
  const text = words.trim();
  if (!text || Array.from(text).length > 200) return [];
  const tags = TAG_WORDS.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  return tags.includes('creator_insult') ? tags.filter(tag => tag !== 'insult') : tags;
}

/** What the chooser may add about meaning; absent, the counts and tags decide. */
export interface AppraisalMeaning {
  deliberate?: number;
  teasing?: boolean;
}

/** The running facts an appraisal reads, kept per key as the day's events are folded. */
export interface AppraisalContext {
  /** Per subject: how often, whether she said no, how often after it. */
  subjects: Readonly<Record<string, { count: number; saidNo: boolean; afterNo: number }>>;
  violations: number;
  apologies: number;
  kindnesses: number;
  provocationsBySource: Readonly<Record<string, number>>;
  /** The subject touched last (her refusing words are about it). */
  lastSubject: string | null;
}

export const EMPTY_APPRAISAL_CONTEXT: AppraisalContext = Object.freeze({ subjects: {}, violations: 0, apologies: 0, kindnesses: 0, provocationsBySource: {},
  lastSubject: null });

const SAID_NO = new Set(['dislike', 'refuse']);
const TAG_GOODNESS: Readonly<Record<string, number>> = Object.freeze({ insult: -0.55, lewd: -0.5, ai_taunt: -0.5, creator_insult: -0.6,
  // Stage 5 (`SHANNON_FEELING_STREAM`): comments only (`commentTags`): a threat or a doxx, and prying into the owner's private life.
  threat: -0.8, pry_owner: -0.35 });

/** How much a crowd's comment weighs against one viewer's (§4.3: a crowd is one source; approved by the owner, 2026-10-15). */
export const CROWD_COMMENT_WEIGHT = 0.5;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** How unexpected the n-th of a kind is: the first fully, then less (a count model of habituation; ADR-0006 2.2). */
const novelty = (seen: number) => 1 / (1 + seen);

const STANCE_GOODNESS: Readonly<Record<string, number>> = Object.freeze({ welcome: 0.5, fine: 0.15, unsure: -0.1, dislike: -0.6, refuse: -0.6 });

function touchAppraisal(event: FeelingEvent, context: AppraisalContext): Appraisal {
  const subject = event.facts.part ?? event.facts.touchKind ?? 'body';
  const seen = context.subjects[subject] ?? { count: 0, saidNo: false, afterNo: 0 };
  const violation = seen.saidNo;
  // Deliberate from the counts: each touch after her no makes "meant" likelier (Jev may say more).
  const deliberate = violation ? clamp(0.5 + 0.15 * seen.afterNo, 0, 1) : 0.3;
  const stanceGoodness = event.facts.stance ? STANCE_GOODNESS[event.facts.stance] : undefined;
  const goodness = stanceGoodness ?? (violation ? -0.5 : 0);
  const provocation = violation ? clamp(0.3 + 0.1 * seen.afterNo, 0, 0.8) : 0;
  return { goodness, unexpected: novelty(seen.count), deliberate, violation, control: 0.3, provocation, relief: 0, subject };
}

/** An apology eases as much as it was not expected (ADR-0006 2.4): the first of the day is a surprise, each one after it less so. */
function apologyAppraisal(context: AppraisalContext): Appraisal {
  const expected = context.apologies / (context.apologies + 1);
  const relief = clamp(0.6 * (1 - expected) + 0.15, 0, 1);
  return { goodness: 0.3, unexpected: 1 - expected, deliberate: 1, violation: false, control: 0.6, provocation: 0, relief, subject: 'apology' };
}

function kindnessAppraisal(context: AppraisalContext): Appraisal {
  const unexpected = novelty(context.kindnesses);
  return { goodness: 0.55, unexpected, deliberate: 1, violation: false, control: 0.6, provocation: 0, relief: 0.25, subject: 'kindness' };
}

/** How much words provoke: tagged (insult, lewd, taunt) or a feeling order, more from a source that repeats, less when it is teasing. */
function provocationOf(event: FeelingEvent, tags: readonly UtteranceTag[], before: number, meaning: AppraisalMeaning): number {
  const order = event.kind === 'feeling_order';
  if (!tags.length && !order) return 0;
  return clamp((order ? 0.15 : 0.35) + clamp(before * 0.1, 0, 0.4) - (meaning.teasing ? 0.1 : 0), 0, 0.9);
}

function wordsAppraisal(event: FeelingEvent, context: AppraisalContext, meaning: AppraisalMeaning): Appraisal {
  if (event.kind === 'apologized') return apologyAppraisal(context);
  if (event.kind === 'praised') return kindnessAppraisal(context);
  const tags = (event.facts.tags ?? []) as readonly UtteranceTag[];
  const before = context.provocationsBySource[event.personKey] ?? 0;
  const order = event.kind === 'feeling_order';
  const tagged = tags.reduce((worst, tag) => Math.min(worst, TAG_GOODNESS[tag] ?? 0), 0);
  const provocation = provocationOf(event, tags, before, meaning);
  const provoking = provocation > 0;
  const deliberate = meaning.deliberate ?? (provoking ? 0.6 + clamp(before * 0.1, 0, 0.4) : 0.2);
  const subject = tags[0] ?? (order ? 'order' : 'talk');
  return { goodness: order ? Math.min(tagged, -0.15) : tagged, unexpected: provoking ? novelty(before) : 0.2, deliberate,
    violation: tags.includes('lewd') && before > 0, control: 0.6, provocation, relief: 0, subject };
}

/** The appraisal of one event in its context. Her own replies and motions are appraised as neutral events of hers. */
export function appraise(event: FeelingEvent, context: AppraisalContext, meaning: AppraisalMeaning = {}): Appraisal {
  if (event.kind === 'touched') return touchAppraisal(event, context);
  if (event.kind === 'comment' || event.kind === 'crowd_comment') return commentAppraisal(event, context, meaning);
  if (event.kind === 'own_reply' || event.kind === 'own_motion' || event.kind === 'own_refusal') {
    return { goodness: 0, unexpected: 0, deliberate: 1, violation: false, control: 1, provocation: 0, relief: 0, subject: 'self' };
  }
  return wordsAppraisal(event, context, meaning);
}

/** A stream comment is words of its kind (an apology, a kindness, an order, talk); a crowd's weighs less (stage 5). */
function commentAppraisal(event: FeelingEvent, context: AppraisalContext, meaning: AppraisalMeaning): Appraisal {
  const appraisal = wordsAppraisal({ ...event, kind: event.facts.commentKind ?? 'spoke' }, context, meaning);
  if (event.kind !== 'crowd_comment') return appraisal;
  const w = CROWD_COMMENT_WEIGHT;
  return { ...appraisal, goodness: appraisal.goodness * w, provocation: appraisal.provocation * w, relief: appraisal.relief * w };
}

function nextSubjects(context: AppraisalContext, event: FeelingEvent, appraisal: Appraisal): AppraisalContext['subjects'] {
  const subjects = { ...context.subjects };
  if (event.kind === 'touched') {
    const seen = subjects[appraisal.subject] ?? { count: 0, saidNo: false, afterNo: 0 };
    const saidNo = seen.saidNo || SAID_NO.has(event.facts.stance ?? '');
    subjects[appraisal.subject] = { count: seen.count + 1, saidNo, afterNo: seen.saidNo ? seen.afterNo + 1 : seen.afterNo };
  }
  // Her refusing words make the most recent subject one she said no to.
  const latest = context.lastSubject;
  if (event.kind === 'own_reply' && event.facts.refusal && latest && subjects[latest]) subjects[latest] = { ...subjects[latest]!, saidNo: true };
  return subjects;
}

/** The context after an event (what the next appraisal reads). */
export function nextAppraisalContext(context: AppraisalContext, event: FeelingEvent, appraisal: Appraisal): AppraisalContext {
  const sources = context.provocationsBySource;
  const provocationsBySource = appraisal.provocation > 0 ? { ...sources, [event.personKey]: (sources[event.personKey] ?? 0) + 1 } : sources;
  const count = (yes: boolean) => (yes ? 1 : 0);
  return {
    subjects: nextSubjects(context, event, appraisal), violations: context.violations + count(appraisal.violation),
    apologies: context.apologies + count(event.kind === 'apologized'), kindnesses: context.kindnesses + count(event.kind === 'praised'), provocationsBySource,
    lastSubject: event.kind === 'touched' ? appraisal.subject : context.lastSubject,
  };
}
