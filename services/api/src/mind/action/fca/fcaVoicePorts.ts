import type { FcaConversationPort, FcaConversationTurn } from './fcaConversationPorts.js';

/** Identity of a confirmed native input batch, bound to the paired device that submitted it. */
export interface FcaVoiceInput {
  scopeKey: string; threadId: string; deviceId: string; utteranceId: string; userTranscript: string;
}
/** `shannonReply`: her words the client stored; a bound receipt with another reply is a new utterance under a reused id. */
export interface FcaVoiceHistoryInput extends FcaVoiceInput { companionPresent: boolean; shannonReply?: string }
export interface FcaVoicePort {
  inspect(input: FcaVoiceInput): 'new' | 'duplicate' | 'conflict';
  begin(input: Parameters<FcaConversationPort['begin']>[0] & FcaVoiceInput): FcaConversationTurn | null;
  /** A turn saved in canonical visible history is not a playback acknowledgement. */
  history(input: FcaVoiceHistoryInput): { status: 'untracked' | 'ready' | 'rejected' } | { status: 'duplicate'; experienceId: string };
  recorded(input: FcaVoiceHistoryInput & { experienceId: string }): boolean;
}
export { createFcaVoiceBridge } from './fcaVoice.js';
