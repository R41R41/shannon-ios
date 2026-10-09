import type { FcaVoiceInput, FcaVoicePort } from '../../mind/action/fca/fcaVoicePorts.js';
import type { FcaConversationTurn } from '../../mind/action/fca/fcaConversationPorts.js';
import type { ToolMenuChooser } from '../../mind/tools/toolsPorts.js';
import type { UserUtterance } from '../../mind/action/respond/conversationCommands.js';

/** No ID is inferred from words: old clients keep ordinary voice without task attachment. */
export function confirmedFcaVoiceInput(scopeKey: string, threadId: string, deviceId: string | undefined, utterance: UserUtterance | undefined, transcript: string): FcaVoiceInput | null {
  return deviceId && utterance?.id && utterance.historyReceipt === 'utterance-id' ? { scopeKey, threadId, deviceId, utteranceId: utterance.id,
    userTranscript: utterance.rawText ?? transcript } : null;
}
export function voiceFcaChooser(chooser: ToolMenuChooser | null | undefined, active: boolean): ToolMenuChooser | null | undefined {
  return active && chooser ? { difficulty: chooser.difficulty, choose: request => chooser.choose({ ...request, menu: [] }) } : chooser;
}
export function voiceFcaDuplicate(port: FcaVoicePort | null | undefined, input: FcaVoiceInput | null) {
  const state = port && input ? port.inspect(input) : 'new';
  return state === 'new' ? null : { status: 409, body: { error: state === 'duplicate' ? 'FCA_VOICE_ALREADY_HANDLED' : 'FCA_VOICE_INPUT_CONFLICT' } };
}
export function stageFcaVoice(turn: FcaConversationTurn | null | undefined): void {
  if (!turn) return;
  if (!turn.stageDelivery) throw new Error('FCA_VOICE_STAGE_UNAVAILABLE');
  turn.stageDelivery();
}
