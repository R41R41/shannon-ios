import type { RoomLookChoice } from '../../contracts/bodyLookContract.js';
import type { BodyLookUnavailable } from './bodyLookLines.js';
interface RoomLookContextLine { role: 'user' | 'assistant'; content: string }
export * from './bodyLookLines.js';
export * from './appLookLines.js';

/** What a voice turn is told about looking (`voiceRoomLook.ts`). */
export interface BodyLookVoiceTurn {
  /** Why she cannot look now, or null when she can. */
  unavailable: BodyLookUnavailable | null;
  /**
   * Opens the look once the reply is written; the conditions are checked again. `spoken` is this turn as it was said,
   * for the model that sees the frame: the client stores a voice turn in a request of its own, which may come later.
   */
  open(threadId: string, choice: RoomLookChoice, spoken?: readonly RoomLookContextLine[], turnId?: string): boolean;
  /** The call was cut off after she had begun to say she would look: no look, and one honest line once the turn (`said`: his words; `turnId`: the client's utterance id) is stored. */
  cutOff(threadId: string, said: string, turnId?: string): void;
}

/**
 * The owner's words ask her to look. This only decides whether the turn is told that she
 * cannot look right now; it never starts a look. Starting one is the model's choice.
 */
export function asksToLook(message: string): boolean {
  return /(?:部屋|まわり|周り|こっち|ここ|これ|机|外|カメラ)[^。！？\n]{0,12}(?:見て|見える|見えて|見れる|見られる|のぞいて|写して)|見て(?:みて|ほしい|くれ)|カメラ(?:で|を)/u.test(message);
}
