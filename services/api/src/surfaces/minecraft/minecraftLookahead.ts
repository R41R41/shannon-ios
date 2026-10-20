import { createFcaLookahead, type FcaLookahead } from '../../mind/action/fca/fcaLookahead.js';
import { agendaActedSince } from './minecraftAgenda.js';

/**
 * Which of her calls are long enough to ask the next decision while they run (session mb-arch, `SHANNON_MINECRAFT_AGENDA`): a decision
 * takes about 3 s of the model and these take 10 s to minutes, so the next one is ready when the body is free again. A craft or a place
 * ends before the answer would come, and a search's next step needs its result (the coordinates it finds), so neither is asked ahead.
 */
const LONG: ReadonlySet<string> = new Set(['mc.mine-block', 'mc.move-to', 'mc.stair-mine', 'mc.attack-continuously', 'mc.wait-time',
  'mc.dig-shelter', 'mc.sleep-in-bed', 'mc.leave-water', 'mc.build-around-self', 'mc.fish', 'mc.tower-up', 'mc.dig-block-at']);

export function minecraftLongCall(call: { name: string; input: unknown }): boolean {
  if (call.name === 'mc.withdraw-from-furnace') {
    return !!call.input && typeof call.input === 'object' && (call.input as { waitForCompletion?: unknown }).waitForCompletion === true;
  }
  return LONG.has(call.name);
}

/** A decision asked ahead is not taken once the executor did anything for the task after it was asked (the world it saw moved). */
export function createMinecraftLookahead(log: (line: string) => void): FcaLookahead {
  return createFcaLookahead({ wanted: minecraftLongCall, log, fresh: (taskId, preparedAt) => !agendaActedSince(taskId, preparedAt) });
}

/** The Minecraft wiring with its agenda's switch and its one lookahead (kept across the steps of every task). */
export function withMinecraftAgendaParts<M extends object>(minecraft: M | null, on: boolean, log: (line: string) => void = line => console.info(line))
  : (M & { agenda: { on: boolean; lookahead?: FcaLookahead } }) | null {
  if (!minecraft) return null;
  return Object.assign(minecraft, { agenda: on ? { on, lookahead: createMinecraftLookahead(log) } : { on } });
}
