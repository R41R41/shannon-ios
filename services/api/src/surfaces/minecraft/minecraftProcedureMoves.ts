import type { ProcedureMemory, ProcedureMove } from '@shannon/mind';
import type { MinecraftWorkItem } from './minecraftFillers.js';
import { carried, cellsInText, inPack, largest, nearestNeed, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';

/**
 * The small moves the procedures share (session mb-arch, `minecraftProcedures.ts`): planks from logs, sticks from planks, logs from the
 * trees in reach, stone with a pickaxe, a craft. Each is one body call (or a short chain) with the body's own tool names and arguments
 * (Minebot catalog: `craft-one` sets its own table down, `mine-block` walks, digs with the right tool and picks the drops up).
 */
export type McMove = ProcedureMove<MinecraftWorkItem>;
export type McDo = Extract<McMove, { kind: 'do' }>;
export const LOGS = /_(?:log|stem)$/u;
export const PLANKS = /_planks$/u;
export const STICK = /^stick$/u;
export const COBBLE = /^(?:cobblestone|cobbled_deepslate|blackstone)$/u;
export const ANY_LOG_NAMES = 'oak_log,birch_log,spruce_log,jungle_log,acacia_log,dark_oak_log,mangrove_log,cherry_log';

export const doing = (item: MinecraftWorkItem): McDo => ({ kind: 'do', item, key: item.key, why: item.why });
export const stuck = (why: string): McMove => ({ kind: 'stuck', why });

export function craft(itemName: string, why: string, count = 1, key = `craft:${itemName}`): McDo {
  return doing({ tool: 'mc.craft-one', input: { itemName, count }, why, expectMs: 4_000, key });
}

/** Planks counted as planks: a log makes four. */
export const plankWorth = (facts: MinecraftProcedureFacts) => carried(facts, PLANKS) + 4 * carried(facts, LOGS);

/** Logs to dig: the kind of the nearest tree she knows of (one kind, the run-18 rule), else any kind near. */
export function digLogs(facts: MinecraftProcedureFacts, count: number, why = '原木を掘る'): McDo {
  const tree = nearestNeed(facts, 'wood');
  const blockName = tree && LOGS.test(tree.name) ? tree.name : ANY_LOG_NAMES;
  return doing({ tool: 'mc.mine-block', input: { blockName, count: Math.max(1, Math.min(count, 8)), searchRadius: 48 }, why, expectMs: 8_000 * count,
    key: `logs:${carried(facts, LOGS)}` });
}

/** Planks enough (`least`): planks from a log carried, else logs dug. */
export function planksFor(facts: MinecraftProcedureFacts, least: number): McMove | null {
  if (carried(facts, PLANKS) >= least) return null;
  const log = largest(facts, LOGS);
  if (!log) return digLogs(facts, Math.ceil((least - carried(facts, PLANKS)) / 4) + 1);
  const logs = Math.min(inPack(facts, LOGS), Math.ceil((least - carried(facts, PLANKS)) / 4) + 1);
  return craft(log.replace(/^stripped_/u, '').replace(LOGS, '_planks'), '原木を板にする', 4 * logs, `planks:${carried(facts, PLANKS)}`);
}

/** Two sticks or more for a tool: sticks from planks (planks first). */
export function sticksFor(facts: MinecraftProcedureFacts, least = 2): McMove | null {
  if (carried(facts, STICK) >= least) return null;
  return planksFor(facts, 2) ?? craft('stick', '棒を作る', Math.max(4, least), `sticks:${carried(facts, STICK)}`);
}

/** Cobblestone enough (`least`): stone dug with the pickaxe she has (none: the procedure before this one is not done). */
export function cobbleFor(facts: MinecraftProcedureFacts, least: number, more = 0): McMove | null {
  const have = carried(facts, COBBLE);
  if (have >= least) return null;
  return doing({ tool: 'mc.mine-block', input: { blockName: 'stone', count: Math.min(24, least - have + more), searchRadius: 24 }, why: '石を掘る',
    expectMs: 2_500 * (least - have + more), key: `stone:${have}` });
}

/** A tool made from sticks and a head material: sticks first, the head material (`material`) first of all. */
export function toolOf(facts: MinecraftProcedureFacts, itemName: string, material: McMove | null): McMove {
  return material ?? sticksFor(facts) ?? craft(itemName, `${itemName}を作る`);
}

/** The step a chain of a found block's coordinates takes: the first cell the result names, made into the next item; null when none. */
export function fromFirstCell(memory: ProcedureMemory, note: string, make: (cell: { x: number; y: number; z: number }) => MinecraftWorkItem | null) {
  return (text: string): MinecraftWorkItem | null => {
    const cell = cellsInText(text)[0];
    if (!cell) memory.notes.set(note, true);
    return cell ? make(cell) : null;
  };
}
