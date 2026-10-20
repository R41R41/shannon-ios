import { createFcaLookahead, type FcaLookahead } from '../../mind/action/fca/fcaLookahead.js';

/**
 * Which of her calls are long enough to ask the next decision while they run (session mb-arch, `SHANNON_MINECRAFT_AGENDA`): a decision
 * takes about 3 s of the model and these take 10 s to minutes, so the next one is ready when the body is free again. A craft or a place
 * ends before the answer would come, so it is not asked ahead of (the step after it asks as before).
 */
const LONG: ReadonlySet<string> = new Set(['mc.mine-block', 'mc.move-to', 'mc.stair-mine', 'mc.attack-continuously', 'mc.explore-for-structure',
  'mc.find-structure', 'mc.wait-time', 'mc.dig-shelter', 'mc.sleep-in-bed', 'mc.leave-water', 'mc.build-around-self', 'mc.fish', 'mc.tower-up',
  'mc.dig-block-at']);

export function minecraftLongCall(call: { name: string; input: unknown }): boolean {
  if (call.name === 'mc.withdraw-from-furnace') {
    return !!call.input && typeof call.input === 'object' && (call.input as { waitForCompletion?: unknown }).waitForCompletion === true;
  }
  return LONG.has(call.name);
}

export function createMinecraftLookahead(log: (line: string) => void): FcaLookahead {
  return createFcaLookahead({ wanted: minecraftLongCall, log });
}

/** The Minecraft wiring with its agenda's switch and its one lookahead (kept across the steps of every task). */
export function withMinecraftAgendaParts<M extends object>(minecraft: M | null, on: boolean, log: (line: string) => void = line => console.info(line))
  : (M & { agenda: { on: boolean; lookahead?: FcaLookahead } }) | null {
  if (!minecraft) return null;
  return Object.assign(minecraft, { agenda: on ? { on, lookahead: createMinecraftLookahead(log) } : { on } });
}
