import { lavaTraits } from './minecraftMapRead.js';
import { cellsInText, type Cell } from './minecraftProcedureFacts.js';

/**
 * Which lava pool to pour the water on (mb-r24, Minecraft run 24: the first pool, 29 m off, was covered by rock: the pour made 0 twice, and
 * a run cut by a creeper forgot it; the larger pool at 44 m was never tried while the plan's old place 76 m away was walked to). The
 * pools a find lists, nearest first, are ranked by what the body says of each (how many sources it holds, whether rock covers it) beside
 * how far it is; a pool where the water made nothing is not asked again.
 */
export const NO_OBSIDIAN = /水をかけられる溶岩も|黒曜石を0個|黒曜石を作れ(?:ません|なかっ)/u;
/** Pools this close to a dud are the same pool. */
const SAME_POOL = 3;
/** A covered pool costs this many metres more (the cover is dug open first); each source it lacks for the obsidian wanted costs `LACKING` more. */
const COVERED = 10, LACKING = 3;

const farFrom = (cell: Cell, at: Cell | null) => at ? Math.hypot(cell.x - at.x, cell.y - at.y, cell.z - at.z) : 30;

/** The cells a find lists, best first: not a dud, near before far, covered and too small after, the order given breaking ties. */
export function rankedPools(text: string, wanted: number, at: Cell | null, duds: readonly Cell[]): Cell[] {
  const lines = text.split('\n').filter(line => cellsInText(line).length > 0);
  const rows = lines.length > 1 ? lines.map(line => ({ cell: cellsInText(line)[0]!, line })) : cellsInText(text).map(cell => ({ cell, line: '' }));
  return rows.filter(row => !duds.some(dud => Math.hypot(dud.x - row.cell.x, dud.y - row.cell.y, dud.z - row.cell.z) <= SAME_POOL))
    .map((row, index) => {
      const traits = lavaTraits(row.line), listed = /距離\s*([\d.]+)\s*m/u.exec(row.line);
      const cost = (listed ? Number(listed[1]) : farFrom(row.cell, at)) + (traits.covered ? COVERED : 0)
        + (traits.size !== null && traits.size < wanted ? (wanted - traits.size) * LACKING : 0);
      return { cell: row.cell, cost, index };
    }).sort((a, b) => a.cost - b.cost || a.index - b.index).map(row => row.cell);
}
