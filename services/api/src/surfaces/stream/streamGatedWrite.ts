import { neverByWords } from '../../mind/selectors/conversationRoute.js';
import type { GateDecision } from './streamGate.js';
import type { WrittenLine } from './streamAuthor.js';

/**
 * The gate (Jev, at most 0.9 s) and the writer side by side (owner's choice of 2026-11-02, latency plan D): her answer is written while
 * the gate reads the comment. When the gate declines, the decline is written at once and the first answer is never said: one more writer
 * call for a declined comment (about one reply in twenty). A comment the words alone decline, or a tell-off, is never written twice; an
 * event the ear described is not gated at all.
 */
export async function gatedWrite(input: {
  event: boolean; text: string; tellOff: boolean;
  gate: () => Promise<Pick<GateDecision, 'declined'>>;
  write: (decline: boolean) => Promise<WrittenLine | null>;
  track: (job: Promise<unknown>) => unknown;
}): Promise<{ written: WrittenLine | null; declined: boolean }> {
  if (input.event) return { written: await input.write(false), declined: false };
  if (neverByWords(input.text)) {
    const { declined } = await input.gate();
    return { written: await input.write(declined), declined };
  }
  const first = input.write(false);
  const { declined } = await input.gate();
  if (!declined || input.tellOff) return { written: await first, declined };
  input.track(first);
  return { written: await input.write(true), declined: true };
}
