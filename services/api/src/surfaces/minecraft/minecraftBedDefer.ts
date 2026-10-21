/**
 * The bed waits when the sheep are far (mb-r23, Minecraft run 23: one sheep at 34 m, the next at 159 m, the third at 88 m; the bed came at
 * 330 s and the iron began at 334 s, 180 s later than the iron of run 22 that had sheep at hand; the walks to the sheep were 40 s and the
 * search 50 s of it). The bed is not what the first half hour is spent on: under ground, where the iron, the diamonds and the lava are,
 * the night does not matter, and the armour (not the bed) is what opens the night gate of the body. So with daylight to spare, when the
 * sheep search shows the nearest sheep farther than `BED_DEFER.sheepFar`, the procedure leaves the bed (`ProcedureTaskStore.bedWaits`),
 * takes the step 「食料と羊とベッド」 as done once the food is, and goes on to the iron. The bed is made when a sheep comes near (the
 * furnaces' waits and the detours after a call take one within 12-40 m, `minecraftFillers.ts`), or at dusk: below
 * `BED_DEFER.darkInSeconds` the step is open again and the hunt is the planner's as before.
 *
 * The flag lives in the task's store (the procedures' and the planner's lines read it through `bedMayWait`); the daylight is read from the frame.
 */
export const BED_DEFER = Object.freeze({
  /** The daylight left (s) at which the bed may still wait; below it the bed is wanted before the night. */
  darkInSeconds: 240,
  /** The nearest sheep is farther than this (m, along the ground): the walk and the hunt are not made now. */
  sheepFar: 70,
  /** A sheep this near is taken in a furnace's wait or after a call when no bed is carried (`nextFiller`). */
  fillerReach: 40,
});

const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Whether the bed waits now: the procedure left it, it is the overworld, and the day has `BED_DEFER.darkInSeconds` or more left. */
export function bedMayWait(waits: boolean | undefined, world: Record<string, unknown> | null | undefined): boolean {
  if (!waits || !world) return false;
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : 'overworld';
  const darkIn = record(world.margin)?.darkInSeconds;
  return dimension === 'overworld' && typeof darkIn === 'number' && darkIn >= BED_DEFER.darkInSeconds;
}
