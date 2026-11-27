import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carried, doneFacts, type DoneFacts } from './minecraftConditions.js';
import { createEyeLedger, frameFoundWords, type EyeLedger } from './minecraftEyeLedger.js';
import { bearingBetween, compassWord } from './minecraftEyeTriangulation.js';
import { createBlazeWatch, footingLine } from './minecraftBlazeFacts.js';
import { createDescentTrail } from './minecraftDescentTrail.js';
import { createDeathWatch, deathReturnLine, givenUpBy, type DeathKnown } from './minecraftDeathReturn.js';
import { createEnderHunt } from './minecraftEnderHunt.js';
import { createClimbWatch, crystalLine, deathLine, dragonApproachLine, dragonLine, dragonWaitUrgentLine, enclosedLine, endFightLines, frameLine, pillarLine, placeLine } from './minecraftEndFacts.js';
import { endViewOf, type EndView } from './minecraftEndView.js';
import { FETCH_ENTRY_WORDS, fetchingNetherDrops } from './minecraftLlmcGateEntry.js';
import { nightArmsLine, nightBedLine } from './minecraftNightArms.js';
import { deathLossLine, pearlLine, pearlSearchLines, searchingForPearls, type PearlSearch } from './minecraftPearlFacts.js';
import { readActResult } from '../../contracts/minecraftActContract.js';
import { rememberedFramesOf } from './minecraftSeenMarks.js';
import { undergroundInOverworld } from './minecraftPlanDone.js';
import { createWoolWatch } from './minecraftWoolFacts.js';

/**
 * What a task that goes for the dragon keeps and says of the way after the Nether, as facts for the live state (one object a task, made
 * from its checkpoint like the journey and the worksite memory):
 * - the ledger of the thrown eyes and the stronghold they give (`minecraftEyeLedger.ts`), the one thing here the head keeps itself;
 * - the dragon, the crystals, the breath, the fireballs and the perch in the End (the body's own fields, `minecraftEndView.ts`), the frames of
 *   the portal room and the eyes they still need, her last death with where it was, and the places the body remembers for the way
 *   (`minecraftEndFacts.ts`), read from the frame each time.
 * It decides nothing and sends nothing; a field the body does not send leaves its line out.
 */
export interface EndgameLines {
  /** The normal version's lines, and the shorter set an urgent or a shortened live state keeps. */
  lines: string[];
  short: string[];
}
const NONE: EndgameLines = { lines: [], short: [] };
const HAZARD_HEADS = ['竜の息の雲:', '火の玉:'];

const worldOf = (observation: BodyObservation | null): Record<string, unknown> | null => {
  const world = observation?.state.world;
  return world && typeof world === 'object' && !Array.isArray(world) ? world as Record<string, unknown> : null;
};
const some = (line: string | null): string[] => line ? [line] : [];

/** The lines of one decision from the frame and the ledger's lines (pure). */
function compose(world: Record<string, unknown>, end: EndView | null, facts: DoneFacts, eyeLines: readonly string[],
  watched: { blaze: string | null; hunt: string | null; trail?: string | null; wool?: string | null; climb?: ((shooting: boolean | null) => string | null); pearlNow?: boolean; search?: PearlSearch;
    dropsGivenUp?: string | null; deathKnown?: DeathKnown | null }): EndgameLines {
  const { blaze, hunt } = watched;
  const arrows = ['arrow', 'spectral_arrow', 'tipped_arrow'].reduce((sum, item) => sum + (facts.counts.get(item) ?? 0), 0);
  const shooting = facts.counts.size ? (facts.counts.get('bow') ?? 0) > 0 && arrows > 0 : null;
  const fight = endFightLines(end, [...facts.counts.keys()].find(item => item.endsWith('_bed') && (facts.counts.get(item) ?? 0) > 0) ?? null, shooting);
  const stall = some(watched.climb?.(shooting) ?? null);
  const supply = { pearls: carried(facts.counts, 'ender_pearl'), powder: carried(facts.counts, 'blaze_powder'), rods: carried(facts.counts, 'blaze_rod') };
  const frames = some(frameLine(world, carried(facts.counts, 'ender_eye'), supply));
  // G01 (the review of 11/10): the Nether's entry gates let a return for a Nether death's drops through; the death's line says so and what it costs.
  // 11/15c: a death in another dimension whose drops wait is said as the way back to them (`minecraftDeathReturn.ts`), in place of the death's line.
  const away = deathReturnLine(world, facts, watched.dropsGivenUp ?? null, watched.deathKnown ?? null);
  const death = some(away ?? deathLine(world)).map(line => (facts.dimension === 'overworld' && fetchingNetherDrops(world) ? `${line}。${FETCH_ENTRY_WORDS}` : line));
  const night = [...some(nightArmsLine(world, facts.counts, facts.dimension, undergroundInOverworld(facts))),
    ...some(nightBedLine(world, facts.counts, facts.dimension, watched.pearlNow)), ...some(watched.trail ?? null)];
  const places = some(placeLine(world, carried(facts.counts, 'bed')));
  const footing = some(footingLine(facts.counts, facts.dimension));
  const enclosed = [...some(enclosedLine(world)), ...some(pillarLine(world))];
  const pearls = [...some(pearlLine(facts.counts, facts.dimension)), ...some(deathLossLine(facts.counts, facts.dimension)), ...pearlSearchLines(world, facts.counts, facts.dimension, watched.search ?? { scans: 0, goes: 0 })];
  const urgent = [...some(dragonLine(end, true)), ...some(crystalLine(end, true)),
    ...fight.filter(line => HAZARD_HEADS.some(head => line.startsWith(head))), ...some(dragonApproachLine(end, true)),
    ...some(dragonWaitUrgentLine(end))];
  return { lines: [...night, ...some(watched.wool ?? null), ...enclosed, ...fight, ...footing, ...stall, ...some(blaze), ...eyeLines, ...pearls, ...some(hunt), ...frames, ...death, ...places],
    short: [...night, ...enclosed, ...urgent, ...footing, ...stall, ...some(blaze), ...frames, ...death] };
}

/**
 * A hypothesis from one run (2026-11-26), said as a fact to compare with the overland walk, never a rule: the point in the Nether's coordinates, the obsidian a new
 * gate needs, and the Nether walk measured once (0.36 m/s over 14.5 minutes). What the ground is where the Nether side comes out is not known.
 * The Nether side gate's distance is not known to this ledger, so it is not said.
 */
function netherCompareLines(ledger: EyeLedger, facts: DoneFacts, now: number): string[] {
  const fix = ledger.fix(now);
  if (!fix) return [];
  const obsidian = facts.counts.get('obsidian') ?? 0;
  return [`ネザー経由で比べる材料（1 回の観測で、出口の地形は未確認）: 交点のネザー座標 (${Math.round(fix.x / 8)},${Math.round(fix.z / 8)})。`
    + `ゲートを作り直すなら、ゲート用の黒曜石 10 が要る（今 ${obsidian}＋回収。竜の戦い用の 12 とは別の話）。実測のネザーの歩きは 0.36 m/s。選ぶのは地上の見込み秒数との比べで決める`];
}

/** The ledger before the portal room is found, with a single coordinate conversion for travel through the Nether. */
function eyeLinesOf(ledger: EyeLedger, facts: DoneFacts, now: number, world: Record<string, unknown>): string[] {
  if (facts.seen?.has('end_portal_frame') === true) return [];
  // The frames the body remembers in this world (not yet in the map's marks): the ledger says where they are and that nothing is thrown from here.
  const known = facts.dimension === 'overworld' ? rememberedFramesOf(world) : null;
  if (facts.dimension === 'overworld' && known) {
    const held = carried(facts.counts, 'ender_eye'), lines = ledger.lines(facts.feet, now, { frames: known, held });
    return lines.length ? lines : [frameFoundWords(known, facts.feet, held)];
  }
  if (facts.dimension === 'overworld') return [...ledger.lines(facts.feet, now), ...netherCompareLines(ledger, facts, now)];
  if (facts.dimension !== 'the_nether') return [];
  const fix = ledger.fix(now);
  if (!fix) return [];
  const target = { x: fix.x / 8, z: fix.z / 8 };
  const distance = facts.feet ? Math.round(Math.hypot(target.x - facts.feet.x, target.z - facts.feet.z)).toLocaleString('en-US') : null;
  const there = facts.feet ? `・あなたから ${compassWord(bearingBetween(facts.feet, target))} ${distance}m` : '';
  return [`要塞の交点 (${fix.x},${fix.z}) のネザー座標 (${target.x},${target.z})${there}（ネザーの座標で）`];
}

export function createEndgame(saved: unknown, now: () => number = Date.now) {
  const ledger = createEyeLedger((saved as { minecraftEyes?: unknown } | null)?.minecraftEyes);
  const blaze = createBlazeWatch((saved as { minecraftBlazeWatch?: unknown } | null)?.minecraftBlazeWatch);
  const hunt = createEnderHunt((saved as { minecraftEnderHunt?: unknown } | null)?.minecraftEnderHunt);
  const wool = createWoolWatch();
  const climb = createClimbWatch();
  const trail = createDescentTrail((saved as { minecraftDescentTrail?: unknown } | null)?.minecraftDescentTrail);
  /** What she carried of the road's things before a death and the gates of each dimension, for the way back to its drops (`minecraftDeathReturn.ts`). */
  const deaths = createDeathWatch(saved);
  const savedSearch = (saved as { minecraftPearlSearch?: Partial<PearlSearch> } | null)?.minecraftPearlSearch;
  const search: PearlSearch = { scans: Math.max(0, Math.floor(Number(savedSearch?.scans) || 0)), goes: Math.max(0, Math.floor(Number(savedSearch?.goes) || 0)) };
  const goIds: string[] = [];
  let scansAtLastSearch = search.scans;
  /** The death whose drops she gave up (`givenUpBy`: an act's why said so), by its key; its way back is no longer said. */
  let dropsGivenUp = typeof (saved as { minecraftDropsGivenUp?: unknown } | null)?.minecraftDropsGivenUp === 'string'
    ? (saved as { minecraftDropsGivenUp: string }).minecraftDropsGivenUp.slice(0, 80) : null;
  return {
    /** An act's result (the receipt's id and its result JSON): a thrown eye goes in the ledger. */
    noteResult(id: string | undefined, resultJson: string | undefined, observation: BodyObservation | null): void {
      ledger.note(id, resultJson, doneFacts(observation)?.dimension ?? null, now());
      deaths.note(worldOf(observation), doneFacts(observation), now());
      blaze.note(id, resultJson, now());
      hunt.note(id, resultJson, now());
      // The search for a warped forest: one search is a scan followed by a finished `go`; an act counts at most once, and only when a scan
      // came since the last search (the gold's, the pickups' and the failed gos are not searches).
      const facts = doneFacts(observation);
      if (facts && searchingForPearls(facts.counts, facts.dimension) && !(id && goIds.includes(id))) {
        const moved = readActResult(resultJson)?.lines.some(line => line.do === 'go' && line.status === 'done') ?? false;
        if (moved) {
          if (search.scans > scansAtLastSearch) { search.goes += 1; scansAtLastSearch = search.scans; }
          if (id) goIds.push(id);
          if (goIds.length > 20) goIds.shift();
        }
      }
    },
    /** An act that ran: a why that gives up the drops of a death in another dimension ends their block (`minecraftDeathReturn.ts`). */
    noteWhy(why: unknown, observation: BodyObservation | null): void {
      const given = givenUpBy(why, worldOf(observation), doneFacts(observation)?.dimension ?? null);
      if (given) dropsGivenUp = given;
    },
    /** A probe's input came back completed: a scan counts as a search while the pearls are being looked for (`pearlSearchLines`). */
    noteProbe(input: unknown, observation: BodyObservation | null): void {
      const facts = doneFacts(observation);
      if ((input as { kind?: unknown } | null)?.kind === 'scan' && facts && searchingForPearls(facts.counts, facts.dimension)) search.scans += 1;
    },
    /** The lines of this decision: empty for a task that is not after the dragon. */
    lines(observation: BodyObservation | null, dragonTask: boolean, pearlNow = false, footingDrop: number | null = null): EndgameLines {
      const world = worldOf(observation);
      const facts = doneFacts(observation);
      if (!dragonTask || !world || !facts) return NONE;
      deaths.note(world, facts, now());
      // The eyes the body kept on this world before this task (its `eyeThrows`): read in once, when the ledger is empty; absent from an older body (nothing happens).
      if (facts.dimension === 'overworld') ledger.seed(world.eyeThrows, now());
      if (facts.seen?.has('end_portal_frame') || facts.dimension === 'the_end') ledger.clear();
      const viewed = endViewOf(observation);
      const end = viewed && footingDrop !== null ? { ...viewed, drop: footingDrop } : viewed;
      return compose(world, end, facts, eyeLinesOf(ledger, facts, now(), world), { blaze: blaze.line(world, facts.counts, facts.dimension, now()),
        hunt: hunt.line(world, facts.counts, facts.dimension, now()), trail: trail.line(facts),
        wool: wool.line(world, facts.counts, facts.dimension), climb: shooting => climb.line(end, shooting, now()), pearlNow, search, dropsGivenUp,
        deathKnown: deaths.known() });
    },
    /** The eyes' ledger, for the hold that keeps the frames' eyes (`minecraftEyeThrowHold.ts`). */
    ledger,
    checkpoint: () => ({ ...ledger.checkpoint(), ...blaze.checkpoint(), ...hunt.checkpoint(), ...trail.checkpoint(), ...deaths.checkpoint(), minecraftPearlSearch: { ...search }, minecraftDropsGivenUp: dropsGivenUp }),
  };
}
export type Endgame = ReturnType<typeof createEndgame>;
