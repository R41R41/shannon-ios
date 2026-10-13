/**
 * 「うん、お願い」 after her own offer to look something up (owner decision 2026-10-13, from the conversation audit: she offered
 * 「調べてみましょうか？」, he said 「お願いします」, and the router, seeing only those words, gave her no search, so she said she
 * could not look it up). A short yes to her immediately preceding offer carries what the offer was about into the turn: the
 * capabilities its words call for (the web when none is named), for Jev's answer and the local rules alike, and the request
 * itself for the research it starts. Deterministic; nothing but the last two lines of the recent context is read.
 */
import { mandatorySkillPatterns, type VoiceDecisionInput, type VoiceSkill } from '../../contracts/voiceDecisionContract.js';

/** A yes and nothing more: 「うん」「はい、お願いします」「ぜひ見て」「調べて」「いいよ」. A no, or a new question, is not one. */
const AFFIRMATIVE = new RegExp('^(?:(?:うん|はい|ええ|おう|じゃあ|そうだね|そうですね|ぜひ|是非)[、,。！!\\s]*)*'
  + '(?:お願い(?:します|ね)?|おねがい(?:します)?|頼む|頼みます|よろしく(?:お願いします)?|見て(?:みて)?|調べて(?:みて)?|確認して|確かめて'
  + '|探して|検索して|そうして|やって|いいよ|いいね|オッケー|OK|オーケー|うん|はい|ええ|ぜひ)'
  + '(?:ください|くれる|ほしい|ね|よ)?[。！!〜ー…\\s]*$', 'iu');

/** Her offer to look something up, as the question her reply ended on: 「調べてみましょうか？」「東京の天気も見ますか？」. */
const OFFER = /(?:調べ|見|確認し|確かめ(?:直し)?|探し|検索し|チェックし)(?:て(?:み|お|き)?)?(?:ましょうか|ますか|ようか)[?？]?\s*$/u;

/** Capabilities that are the owner's own memory or her day: never carried by an offer's wording. */
const NOT_CARRIED = new Set<VoiceSkill>(['conversation_memory', 'daily_mind', 'device_context']);

export interface CarriedOffer {
  /** Her offer, the question her last reply ended on. */
  offer: string;
  /** What the owner had said before it (the request the offer was about), when there was one. */
  before: string;
  skills: readonly VoiceSkill[];
}

function lastSentence(text: string): string {
  const sentences = text.trim().match(/[^。！？!?]+[。！？!?]*/gu) ?? [];
  return sentences.at(-1)?.trim() ?? '';
}

/** The offer a short yes accepts, with the capabilities it carries; null when the words are not such a yes. */
export function carriedOffer(input: Pick<VoiceDecisionInput, 'transcript' | 'context' | 'participantMode'>): CarriedOffer | null {
  const words = input.transcript.normalize('NFKC').trim();
  if (!words || [...words].length > 24 || !AFFIRMATIVE.test(words)) return null;
  const context = input.context ?? [];
  const last = context.at(-1);
  if (last?.role !== 'assistant') return null;
  const offer = lastSentence(last.content);
  if (!OFFER.test(offer)) return null;
  const named = (Object.entries(mandatorySkillPatterns) as Array<[VoiceSkill, RegExp]>)
    .filter(([skill, pattern]) => !NOT_CARRIED.has(skill) && pattern.test(offer)).map(([skill]) => skill);
  const before = [...context].reverse().find(item => item.role === 'user')?.content ?? '';
  return { offer, before, skills: named.length ? named : ['current_web'] };
}

/** What the research started by such a yes is asked to find: his request, her offer, and his yes. */
export function carriedRequest(carried: CarriedOffer, transcript: string): string {
  return [carried.before ? `ライ氏「${carried.before.slice(0, 300)}」` : '', `ボク「${carried.offer}」`, `ライ氏「${transcript.trim()}」`]
    .filter(Boolean).join(' → ');
}
