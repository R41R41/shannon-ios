/** End entry remembered within one task; the body's death history also works after a head restart. */
const entered = new Set<string>();
const inEnd = (dimension: unknown): boolean => dimension === 'the_end' || dimension === 'minecraft:the_end';
const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  ? value as Record<string, unknown> : null;

/** Only an observed End dimension or the body's End death establishes a return; a plan title or an open portal does not. */
export function returningToEnd(world: Record<string, unknown>, dimension: string | null, taskId?: string): boolean {
  if (taskId && inEnd(dimension)) {
    entered.add(taskId);
    if (entered.size > 32) entered.delete(entered.values().next().value as string);
  }
  if (taskId && entered.has(taskId)) return true;
  const deaths = Array.isArray(world.deaths) ? world.deaths : [];
  if (deaths.some(death => inEnd(objectOf(death)?.dimension))) return true;
  return typeof world.lastDeath === 'string' && /(?:^|\s)(?:minecraft:)?the_end(?:\s|$)/u.test(world.lastDeath);
}
