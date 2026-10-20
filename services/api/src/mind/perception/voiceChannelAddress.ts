import { guestAddressDecision, type GuestAddressReason } from '../../surfaces/voice/voiceGuestCall.js';

/**
 * Whether she answers an utterance heard in a Discord voice channel (dc-voice, 2026-10-20). With one person in the channel every
 * utterance is to her; with several, the shared-table rule of 「友人も一緒」 (`guestAddressDecision`) decides: she answers when named,
 * asked, requested, greeted, or reacted to just after she spoke, and stays quiet for people talking to each other. Local rules only:
 * this runs before anything is read or paid for.
 */
export type VoiceAddressReason = GuestAddressReason | 'solo' | 'fragment';

export interface VoiceAddress {
  respond: boolean;
  reason: VoiceAddressReason;
}

/** Sounds a speech recogniser makes of breath, a cough or a key press; and a lone acknowledgement nobody waits on. */
const NOISE = /^(?:[あえいおうんぁぃぅぇぉっー〜、。.…!！?？\s]|はい|ええ|えー|あー|うー|んー)+$/u;
const MINIMUM_CHARACTERS = 2;

const spokenLength = (text: string): number => Array.from(text.replace(/[\s、。,.!！?？…「」『』（）()]/gu, '')).length;

export function voiceAddress(input: { transcript: string; humans: number; followsShannonTurn: boolean }): VoiceAddress {
  const text = input.transcript.trim();
  if (spokenLength(text) < MINIMUM_CHARACTERS) return { respond: false, reason: 'fragment' };
  // Right after she spoke even a bare 「うん」 or 「はい」 is an answer; otherwise it is a sound, not a turn.
  if (NOISE.test(text) && !input.followsShannonTurn) return { respond: false, reason: 'fragment' };
  if (input.humans <= 1) return { respond: true, reason: 'solo' };
  return guestAddressDecision(text, {
    turns: [], addressedByName: false, followsShannonTurn: input.followsShannonTurn, introductionStart: false,
  }, 'speech');
}
