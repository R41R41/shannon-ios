import { isGameFeeling, messageEmotionKind, presentShannonFeeling, type CompanionStateSnapshot, type ShannonEmotionKind } from '@shannon/cognition';
import { emotionTiming } from './emotionTiming.js';

/**
 * The kind of the feeling she has now when a game moment brought it (`isGameFeeling`) and it shows; nothing otherwise (also when it
 * cannot be read). Moved out of `feelingPorts.ts` (the 500-line ceiling).
 */
export function gameFeelingFace(snapshot: CompanionStateSnapshot, at: string): { feeling?: ShannonEmotionKind } {
  try {
    const present = presentShannonFeeling(snapshot, at, emotionTiming());
    const kind = isGameFeeling(present) ? messageEmotionKind(present) : undefined;
    return kind ? { feeling: kind } : {};
  } catch { return {}; }
}
