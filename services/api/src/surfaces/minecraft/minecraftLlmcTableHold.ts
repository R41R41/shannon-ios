import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { countMatching } from './minecraftItems.js';
import { DESCENT, feetOf, lowestReach, readinessOf, TABLE_PLANKS } from './minecraftLlmcReadiness.js';

/**
 * No table to go down with (run62, 11/5, +1,834 s: the line said 「作業台 無・板 0」 and she went down to y=-11 all the same; at the diamonds the wood
 * was gone, the iron pickaxe broke on stone and she climbed 28 blocks bare-handed, 706 s to the diamond pickaxe). In the overworld with no table,
 * fewer than 4 planks and no log, the first hand that goes 10 or more blocks below the feet is held. Bounded like the sleep hold: `TABLE_HOLDS`
 * in `TABLE_WINDOW_MS` for a task, past which it goes (no wood within reach below). It moves no node (its code is not `gate_required`).
 */
export const TABLE_HOLDS = 3;
export const TABLE_WINDOW_MS = 15 * 60_000;
const holds = new Map<string, number[]>();

/** For tests: no task has held a descent. */
export function forgetTableHolds(): void { holds.clear(); }

/** The hold (the hand, 1-based, its kind and its line) of a descent without a table, or null; `commit` counts it when it stops the act. */
export function tableDescentHold(input: unknown, frame: BodyObservation | null, taskId: string, now: () => number = Date.now):
  { hand: number; kind: string; line: string; commit(): void } | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const facts = readinessOf(frame), feet = facts ? feetOf(facts.world) : null;
  if (!Array.isArray(hands) || !facts || !feet || facts.dimension !== 'overworld') return null;
  const planks = countMatching(facts.counts, /_planks$/u), logs = countMatching(facts.counts, /_(?:log|stem|wood|hyphae)$/u);
  if (countMatching(facts.counts, /^crafting_table$/u) > 0 || planks >= TABLE_PLANKS || logs > 0) return null;
  const at = hands.findIndex(hand => feet.y - lowestReach([hand], feet.y) >= DESCENT);
  if (at < 0) return null;
  const clock = now(), recent = (holds.get(taskId) ?? []).filter(when => clock - when < TABLE_WINDOW_MS);
  if (recent.length >= TABLE_HOLDS) return null;
  const line = `作業台 無・板 ${planks}・原木 0 で 10 段以上下りる手は送らない（${recent.length + 1}/${TABLE_HOLDS} 回目）: 下では木が見つかりにくく、`
    + '作業台の要る物（ダイヤのツルハシ・鉄の道具・ツルハシの作り直し）が作れない。先に原木（村の木の物・地表の木）を取って作業台か板 4 を持つ';
  const kind = String((hands[at] as { do?: unknown } | null)?.do ?? 'go');
  return { hand: at + 1, kind, line, commit: () => { holds.set(taskId, [...recent, clock]); } };
}
