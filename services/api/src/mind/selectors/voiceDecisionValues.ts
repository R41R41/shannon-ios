import { mentionsSuiteProduct } from '@shannon/cognition';
import { memoNotForAether } from '../action/respond/memoPlace.js';
import { wantsPlaceDiscovery } from '../../integrations/places/placeDiscovery.js';
import {
  explicitWebRequestPattern, internalStatusPattern, mandatorySkillPatterns, VOICE_SKILLS,
  type VoiceConversationClass, type VoiceDecisionInput, type VoiceSkill,
} from '../../contracts/voiceDecisionContract.js';

export function applyMandatorySkillFloors(
  scores: Record<VoiceSkill, number>,
  input: VoiceDecisionInput,
): void {
  // 「メモを作って」 is not a request about Aether unless Aether is named: her study and her folder take memos too.
  const memoElsewhere = memoNotForAether(input.transcript);
  for (const skill of VOICE_SKILLS) {
    if (skill === 'aether_notes' && memoElsewhere) continue;
    if (mandatorySkillPatterns[skill]?.test(input.transcript)) scores[skill] = Math.max(scores[skill], 1);
  }
  // Aether/Voyager/Shannon status lives in the owner's own notes, tasks and agent work, not on
  // the public web. A freshness word next to a product name must not send the turn to web search.
  if (asksInternalSuiteStatus(input.transcript)) scores.current_web = 0;
  if (input.requestedLocation) scores.device_context = 1;
  if (wantsPlaceDiscovery(input.transcript)) scores.place_discovery = 1;
  if (input.participantMode === 'guest') {
    scores.conversation_memory = 0;
    scores.daily_mind = 0;
    scores.aether_notes = 0;
    scores.voyager_tasks = 0;
    scores.agent_status = 0;
  }
}

/** True for "エーテルとボイジャーの最新の開発状況", false once the owner asks for the web explicitly. */
export function asksInternalSuiteStatus(transcript: string): boolean {
  return (mentionsSuiteProduct(transcript, 'aether') || mentionsSuiteProduct(transcript, 'voyager'))
    && internalStatusPattern.test(transcript)
    && !explicitWebRequestPattern.test(transcript);
}

export function selectedSkills(
  scores: Readonly<Record<VoiceSkill, number>>,
  threshold: number,
  participantMode: VoiceDecisionInput['participantMode'],
): VoiceSkill[] {
  const privateSkills = new Set<VoiceSkill>([
    'conversation_memory', 'daily_mind', 'aether_notes', 'voyager_tasks', 'agent_status',
  ]);
  return VOICE_SKILLS.filter(skill => scores[skill] >= threshold
    && !(participantMode === 'guest' && privateSkills.has(skill)));
}

export function normalizedConversationClass(
  value: VoiceConversationClass,
  replyRequiredProbability: number,
  skills: readonly VoiceSkill[],
  transcript: string,
): VoiceConversationClass {
  if (acknowledgementOnly(transcript)) return 'no_response';
  if (value === 'no_response' && replyRequiredProbability >= 0.4) {
    return skills.length ? 'skill_simple' : 'direct';
  }
  if (skills.length && value === 'direct') return 'skill_simple';
  return value;
}

export function shouldRespondToTurn(
  conversationClass: VoiceConversationClass,
): boolean {
  return conversationClass !== 'no_response';
}

function acknowledgementOnly(transcript: string): boolean {
  return /^(?:うん|はい|へえ|なるほど|そうなんだ|ふーん|了解|わかった|オッケー|ok)[。！!…]*$/iu
    .test(transcript.trim());
}

export function noulValue(value: unknown): number {
  if (!value || typeof value !== 'object') throw new Error('JEV_RESPONSE_INVALID');
  const probability = (value as { noul?: unknown }).noul;
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('JEV_RESPONSE_INVALID');
  }
  return probability;
}

export function probabilityValue(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('VOICE_DECISION_PROBABILITY_INVALID');
  }
  return value;
}

export function choiceValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (!value || typeof value !== 'object') throw new Error('JEV_RESPONSE_INVALID');
  const choice = (value as { choice?: unknown }).choice;
  if (typeof choice !== 'string' || !allowed.includes(choice)) throw new Error('JEV_RESPONSE_INVALID');
  return choice as T[number];
}

export function directChoiceValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('VOICE_DECISION_CHOICE_INVALID');
  return value as T[number];
}

/** The three steps by which a model says how strong a feeling is. Voice (Jev) and the text reply share this one scale. */
export const AFFECT_INTENSITY_STEPS = ['subtle', 'moderate', 'strong'] as const;
export type AffectIntensityStep = typeof AFFECT_INTENSITY_STEPS[number];

export function affectIntensityOf(step: AffectIntensityStep): number {
  return step === 'subtle' ? 0.25 : step === 'moderate' ? 0.6 : 0.9;
}

export function affectIntensityValue(value: unknown): number {
  return affectIntensityOf(choiceValue(value, AFFECT_INTENSITY_STEPS));
}

export function optionalProbability(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

export function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function boundedProbability(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}
