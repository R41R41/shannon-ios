import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { toolFailure } from '../../mind/tools/toolRegistryPorts.js';
import { heldBeforeSend, heldOfFrame, heldTail, heldWhole, sentPart, type BeforeSend, type Held } from './minecraftLlmcPartial.js';
import { standAfterHands } from './minecraftLlmcPreflight.js';

/**
 * The guards before an item goes to the body, with the items ahead of it (task queue). An item that follows others starts in the world they leave,
 * so its hands are walked after theirs: the guards read the ahead items' hands first and the new item's after them (a dig of the ahead items opens
 * its cells on the map, a place fills them), and only a stop in the new item's own hands holds it. An ahead item that repeats or ends on a condition
 * leaves a world the map cannot say: no guard then (the body says its own stop at the hand's start, as for any act).
 */
const say = (line: string): void => { console.info(line); };
/** "手 4 walk …" with the number counted from the new item's first hand. */
const rebased = (line: string, ahead: number): string => line.replace(/^手 (\d+)/u, (_all, n: string) => `手 ${Number(n) - ahead}`);

export function heldBeforeSendQueued(urgent: boolean, input: ActInput, frame: BodyObservation | null, taskId: string,
  ahead: readonly ActInput[]): BeforeSend | null {
  if (!ahead.length) return heldBeforeSend(urgent, input, frame, taskId);
  if (ahead.some(item => item.repeat !== undefined || item.done !== undefined)) return null;
  const before = ahead.flatMap(item => [...item.hands]);
  const combined: ActInput = { ...input, hands: [...before, ...input.hands] };
  const notes: string[] = [];
  const found = heldOfFrame(combined, frame, taskId, urgent, notes);
  const note = notes.length ? { note: notes.join('\n') } : null;
  // A stop in the hands that went before is theirs (they are sent); the new item is held only by its own hands.
  if (!found || found.hand <= before.length) return note;
  const held: Held = { ...found, hand: found.hand - before.length, line: rebased(found.line, before.length) };
  const part = sentPart(input, held);
  if (part === null) {
    say(`Shannon Minecraft act held before send task=${taskId} hand=${held.hand} do=${held.kind} code=${held.code} ahead=${before.length}`);
    return { result: toolFailure('refused', heldWhole(held), { retryable: true }) };
  }
  say(`Shannon Minecraft act held partway task=${taskId} hand=${held.hand} sent=${held.hand - 1} code=${held.code} ahead=${before.length}`);
  return { input: part, tail: heldTail(held, input.hands.length, standAfterHands(combined, frame, taskId, found.hand - 1)) };
}
