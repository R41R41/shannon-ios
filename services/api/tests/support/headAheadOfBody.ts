/**
 * Kinds of hand the head knows before the body's catalog does (2026-11-28: `bed_standby`, the booking of the bed burst, written on the head's side first so the head's
 * texts and checks are ready when the body's hand arrives). The two catalog comparisons (`continueProduced.test.ts`, `minecraftBodyActCatalog.test.ts`) accept exactly these as
 * extra on the head's side. When the body's catalog is synced (`scripts/sync-body-produced.sh`) and holds the kind, the comparison says so and the kind is removed from this list.
 * The body's field set for the kind has to be the head's: `on` (true books, false cancels) and `count` (1 to 5) are fields the hand already has, so no new property is added.
 */
export const HEAD_AHEAD_OF_BODY: readonly string[] = ['bed_standby'];

/** What the body's catalog lists plus the kinds the head is ahead with; fails when the body already has one of them (the list is then out of date). */
export function bodyKindsWithHeadAhead(bodyKinds: readonly string[]): string[] {
  const already = HEAD_AHEAD_OF_BODY.filter(kind => bodyKinds.includes(kind));
  if (already.length) throw new Error(`the body's catalog already has ${already.join(', ')}: remove it from HEAD_AHEAD_OF_BODY`);
  return [...bodyKinds, ...HEAD_AHEAD_OF_BODY];
}
