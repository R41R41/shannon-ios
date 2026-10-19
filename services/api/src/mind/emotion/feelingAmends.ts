import {
  FEELING_AMENDS_FROM, SHANNON_OWNER_NAME, livingLingering, presentShannonFeeling, shannonEmotionSign, soothingIn,
  type CompanionStateSnapshot, type FeelingRegister, type FeelingTurnDecision, type ShannonEmotionKind,
} from '@shannon/cognition';
import { emotionTiming } from './emotionTiming.js';
import { feelingTurnWithin } from './feelingTurn.js';

/**
 * His apology or amends, read by its meaning (owner 2026-10-19). Core: emotion.
 *
 * The narrow words (`soothingIn`, `apologyIn`) never saw a long apology (「本当に勝手に触ったのはごめん」) or 「どうやったら埋め合わせ
 * できる？」, and a sulk of one evening lasted five days. While she holds something against him, the feeling turn's Jev call also reads
 * whether his words apologise or make amends (`feeling_amends.v1`); when it does, what she holds is eased as an apology always eased it,
 * and her inner note hears it as his apology. Never waits for the response, never throws.
 */

/** Where an easing is written, handed once when the port is attached (the kernel's state store and her note). */
export interface AmendsEase {
  state: { apply(scopeKey: string, event: { type: 'feeling-eased'; by: 'apology' }): unknown };
  note: () => { turnAmended?(turn: AmendedTurn): void } | null | undefined;
}

export interface AmendedTurn {
  scopeKey: string; surface: 'text' | 'voice'; alone: boolean; at: string; userMessage: string; reply: string; feeling: null; sourceId?: string;
}

const EASES = new WeakMap<object, AmendsEase>();

/** The port's easing target, kept beside it (a port has no state store of its own). */
export function useAmendsEase(port: object, ease: AmendsEase | undefined): void {
  if (ease) EASES.set(port, ease);
}

/**
 * She holds something unpleasant against the owner now (underneath, or the feeling of the moment): only then is Jev asked whether his
 * words make amends, so a calm day asks nothing more.
 */
export function holdsAgainstOwner(snapshot: CompanionStateSnapshot, at: string): boolean {
  try {
    const timing = emotionTiming();
    const against = (kind: ShannonEmotionKind, target: string | undefined) => target === SHANNON_OWNER_NAME && shannonEmotionSign(kind) < 0;
    if (livingLingering(snapshot, at, timing).some(item => against(item.feeling.kind, item.feeling.target))) return true;
    const present = presentShannonFeeling(snapshot, at, timing);
    return against(present.primary, present.target);
  } catch { return false; }
}

/** Whether a decision read his words as amends; a turn whose reply did not wait may still find it, at most `waitMilliseconds` on. */
export async function amendedIn(turn: { decision: FeelingTurnDecision | null; pending: Promise<FeelingTurnDecision> | null; register: FeelingRegister },
  waitMilliseconds = 1_500): Promise<boolean> {
  if (turn.decision?.amends !== undefined) return turn.decision.amends >= FEELING_AMENDS_FROM;
  if (!turn.pending) return false;
  const late = await feelingTurnWithin(turn.pending, turn.register, waitMilliseconds).catch(() => null);
  return (late?.amends ?? 0) >= FEELING_AMENDS_FROM;
}

/**
 * An apology or amends by meaning eases what she holds against him, as the narrow words always did (`soothingIn`, applied after the
 * turn by its background update; nothing again when they saw it), and her note hears it. For a turn of the owner's own only.
 */
export function easeOnAmends(port: object, amended: Promise<boolean>, turn: Omit<AmendedTurn, 'alone' | 'feeling'>): void {
  const ease = EASES.get(port);
  if (!ease) return;
  void amended.then(yes => {
    if (!yes) return;
    if (!soothingIn(turn.userMessage) && emotionTiming().clock === 'awake') ease.state.apply(turn.scopeKey, { type: 'feeling-eased', by: 'apology' });
    ease.note()?.turnAmended?.({ ...turn, alone: true, feeling: null });
  }).catch(() => undefined);
}
