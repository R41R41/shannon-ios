import { FIGHT_SKILLS } from '../../mind/action/reflex/fastJudgment.js';

/**
 * Who owns a fight (mb-r21, owner 2026-10-21: 「戦いの持ち主を 1 つに決める」). Minecraft run 21: one skeleton in a cave, a creeper beside
 * it, and iron armour and an iron sword on her. The fast judgment took the archer for a ranged enemy and hid from it, the body's floor
 * fled and caged, and her own three fights (`combat`, `combat-engage`, `attack-nearest`) were each dropped as "the body's state changed"
 * because every flight and cage of the reflexes moved the body's revision: nobody struck once in 140 s, and she fell from 20 to 5.
 *
 * The decision is: a fight she chooses is hers (`FIGHT_SKILLS`), and
 * - the revision of the body (what a decision made earlier is checked against) moves two ways: `hard` (her own tool was cut off, an
 *   explicit session) and `soft` (a reflex acted beside it). A fight she chose goes on past soft touches (`current`), never past a
 *   hard one; every other call is checked against both, as before;
 * - while a fight is hers (from the check that lets it go on to its call, while it runs, and a few seconds after) the fast judgment
 *   starts nothing above the floor of the rules (`owned`).
 * Pure: the clock is the caller's.
 */
export const FIGHT_OWNER = Object.freeze({
  /** How long a fight stays hers after its call ends (the next decision takes about this long to ask). */
  afterMs: 6_000,
  /** From the check that lets a fight go on to its call being noted (a moment). */
  claimMs: 3_000,
  /** The longest a fight she chose is taken to run (a call that never reports does not hold the body for ever). */
  longestMs: 60_000,
});

/** A body tool (`mc.<skill>`) that is a fight she chooses. */
export const fightCall = (name: string) => name.startsWith('mc.') && FIGHT_SKILLS.has(name.slice(3));

export function createBodyRevisions() {
  let revision = 0, hard = 0;
  return {
    get revision() { return revision; },
    /** Her own tool was cut off, or an explicit session ran: every decision made earlier is stale. */
    hard() { revision += 1; hard = revision; return revision; },
    /** A reflex acted beside her tool: a decision made earlier is stale unless it is a fight she chose. */
    soft() { revision += 1; return revision; },
    /** Whether a decision made at `version` is current: exactly, or (a fight she chose) with only soft touches since. */
    current(version: number, fight = false) { return version === revision || (fight && version >= hard); },
    /** How many touches have come since `version`. */
    since(version: number) { return revision - version; },
  };
}

export function createFightOwner(now: () => number) {
  let startedAt = -Infinity, endedAt = -Infinity, claimedAt = -Infinity, running = false;
  return {
    /** The check that lets a fight go on to its call. */
    claim() { claimedAt = now(); },
    /** The fight's call began. */
    began() { running = true; startedAt = now(); },
    /** The fight's call ended (whatever the result). */
    ended() { running = false; endedAt = now(); },
    owned(): boolean {
      const at = now();
      return (running && at - startedAt < FIGHT_OWNER.longestMs) || at - endedAt < FIGHT_OWNER.afterMs || at - claimedAt < FIGHT_OWNER.claimMs;
    },
  };
}
