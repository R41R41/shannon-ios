import type { MinecraftWorkItem } from './minecraftFillers.js';
import type { MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { waterPlaces } from './minecraftProcedureMap.js';

/**
 * A procedure's run that goes round one purpose (mb-r25, Minecraft run 25: seven tries to fill the bucket inside one procedure, each
 * stopped by the same cause, 483 s, and the decision above saw one "failed" and no review). The executor counts the failures of a
 * purpose together (`ProcedureLimits.failuresPerPurpose`); at the third the run ends, the decision is told which purpose and what each
 * failure was (`failureReview` reads it), and the water the body knows of is laid out as the planner needs it to choose: how far, how
 * much higher or lower, and whether the water lies in the open or in rock.
 */
export const WATER_PURPOSE = '水を汲む';
const PURPOSES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^water:/u, WATER_PURPOSE],
  [/^iron:/u, '鉄を掘る'],
  [/^(?:withdraw|wait|furnace|smelt|coal):/u, 'かまどと鉄の焼き'],
  [/^(?:diamond|cave|up):/u, 'ダイヤの深さへ行く・掘る'],
  [/^(?:obsidian|lava):/u, '黒曜石を作る'],
];

/** Failures that are an answer or a cut, not a failure of the work: a look that found nothing, a call the arbiter or a reflex cut off. */
const NOT_COUNTED = new Set(['target_not_found', 'cut', 'interrupted', 'interrupted_by_reflex', 'waiting_external']);

/** What an item is for, by its key's first word (a closed list: other items are not counted together); null for a failure that does not count. */
export function purposeOfItem(item: Pick<MinecraftWorkItem, 'key'>, failure = 'failed'): string | null {
  return NOT_COUNTED.has(failure) ? null : PURPOSES.find(([pattern]) => pattern.test(item.key))?.[1] ?? null;
}

/** Water at or above this height lies on the surface (the sea's surface is 62, a pond's about 60); below it is a cave's, a ravine's or the sea floor's. */
const OPEN_WATER_Y = 60;
const MOST_CANDIDATES = 5;

/**
 * The water sources the body's map lists, nearest first, each with its distance, its height against hers, and whether it lies in the open
 * (the planner chooses; a bank in rock cannot be reached by a tunnel that will not dig beside water, run 25).
 */
export function waterCandidateLines(facts: MinecraftProcedureFacts): string[] {
  const at = facts.at;
  const places = waterPlaces(facts).slice(0, MOST_CANDIDATES);
  if (!at || !places.length) return [];
  const words = places.map(place => {
    const rise = Math.round(place.at.y - at.y);
    const open = place.at.y >= OPEN_WATER_Y ? '地上・開けている' : '洞窟・地下（岸が岩の中）';
    return `${place.distance}m (${place.at.x},${place.at.y},${place.at.z}) 高さの差${rise >= 0 ? '+' : ''}${rise}・${open}`;
  });
  return [`水の候補（遠さ・高さの差・開けているか）: ${words.join('／')}`];
}
