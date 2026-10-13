import { isMemoryInquiry } from '@shannon/cognition';
import { asksForDeviceAction } from '../../mind/tools/shannonToolSession.js';
import { LOOK_VERB_ASK, lookRequest } from './voiceRoomLook.js';

/**
 * A request to perceive or to act now (a look through the camera, a timer, a reminder, music, an event) is answered from the
 * moment, not from her memory: no model-assisted memory search runs for it (owner's Windows call, 2026-10-14: a camera request
 * picked the conversation-memory skill and waited 2.2 s for a memory rerank before her first word). A question about what she
 * remembers (`isMemoryInquiry`, or words of remembering) keeps its search.
 */
export function perceptionOrActionRequest(transcript: string): boolean {
  if (isMemoryInquiry(transcript) || /覚えて|おぼえて|思い出/u.test(transcript)) return false;
  return lookRequest(transcript) !== null || LOOK_VERB_ASK.test(transcript.normalize('NFKC')) || asksForDeviceAction(transcript);
}
