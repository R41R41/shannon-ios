/**
 * A bed or a village she already knows of, put ahead of the sheep (owner 2026-10-20, Minecraft run 19): an igloo's bed was in her
 * remembered places as 「bed: 72m 東 (69,66,4) ×2」 from D1 on, 13 m away at D10, and a village from D35 (171 m east), yet in 64
 * decisions she never went to either. She looked for sheep 130 m to the south in snowy plains, where none spawn, and saw none.
 * A placed bed is had by breaking it. The body's rows (`world.rememberedPlaces`, kind → `<n>m <方角> (x,y,z)` and whatever follows)
 * are read by their start only, so words the body adds after it change nothing here. Equipment such as a bed is broken to be carried
 * only with `takeEquipment=true` (Minebot `digBlockAt`: without it the body leaves equipment alone).
 */
export const BED_LEAD = Object.freeze({ bedDistance: 200, villageDistance: 400 });

/**
 * Where sheep do not spawn (Java 1.18 and later): the snowy plains and slopes, frozen and icy ground, the bare badlands, deserts, the
 * oceans and their shores, caves. Narrow on purpose: a biome left out keeps the sheep search as before (the review of run 19).
 */
const NO_SHEEP = new RegExp('^(?:snowy_plains|snowy_slopes|snowy_beach|frozen_peaks|frozen_river|.*frozen_ocean|ice_spikes|badlands|eroded_badlands'
  + '|desert|.*ocean|beach|stony_shore|deep_dark|dripstone_caves|lush_caves|mushroom_fields)$', 'u');
const ROW = /^(\d{1,5})m\s+(\S{1,4})\s+\((-?\d{1,8}),\s*(-?\d{1,4}),\s*(-?\d{1,8})\)/u;

interface Place { distance: number; direction: string; x: number; y: number; z: number }
function place(value: unknown): Place | null {
  const found = typeof value === 'string' ? ROW.exec(value.trim()) : null;
  if (!found) return null;
  const [, distance, direction, x, y, z] = found;
  return { distance: Number(distance), direction: direction!, x: Number(x), y: Number(y), z: Number(z) };
}
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const at = (row: Place) => `x=${row.x}、y=${row.y}、z=${row.z}`;

/** Whether she sees a sheep now (`world.nearbyEntities`). */
function sheepInSight(world: Record<string, unknown>): boolean {
  return (Array.isArray(world.nearbyEntities) ? world.nearbyEntities : []).some(entity => record(entity)?.name === 'sheep');
}

/**
 * The line that goes ahead of the sheep for a bed she has not got (the caller knows she has none): a remembered bed within
 * `bedDistance`, else a remembered village within `villageDistance` when no sheep is in sight and her biome has none. Null otherwise.
 */
export function bedLead(world: Record<string, unknown>): string | null {
  const places = record(world.rememberedPlaces) ?? {};
  const bed = place(places.bed), village = place(places.village);
  if (bed && bed.distance <= BED_LEAD.bedDistance) {
    return `置かれたベッドが場所の記憶にある（${bed.distance}m ${bed.direction}、${bed.x},${bed.y},${bed.z}）。羊を探すより先に取りに行く: `
      + `mc.move-to（${at(bed)}、goalType=near、range=2）→ mc.dig-block-at（${at(bed)}、takeEquipment=true）。壊すとベッドが手に入る（イグルーや村の家のベッドも同じ）`;
  }
  const name = typeof world.biome === 'string' ? world.biome.replace(/^minecraft:/u, '') : '';
  const biome = /^[a-z_]{1,40}$/u.test(name) ? name : null;
  if (village && village.distance <= BED_LEAD.villageDistance && !sheepInSight(world) && biome && NO_SHEEP.test(biome)) {
    return `村が場所の記憶にある（${village.distance}m ${village.direction}、${village.x},${village.y},${village.z}）。ここ（${biome}）は羊が出ないので、`
      + `羊を探すより先に村へ: mc.move-to（${at(village)}、goalType=near、range=8）。村には家のベッドがあり、まわりの草地に羊がいる`;
  }
  return null;
}
