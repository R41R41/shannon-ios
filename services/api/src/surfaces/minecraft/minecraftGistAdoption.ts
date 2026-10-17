import { argumentWords } from './minecraftAdoptionTags.js';
import { BED_ITEM, COOKED_FOOD, countMatching, type ItemCounts } from './minecraftItems.js';

/**
 * Observation redesign P1 (design v1 D-3, v2 P1): whether a shown skill gist is taken up, measured by code over decisions.
 * `followedWithinN`: a call that the gist names (its specific tools, or the argument predicates below for the generic tools it uses)
 * within the next N = 3 decisions of its being shown. Ignored streak: gists in a row (per skill) whose window ended with no follow.
 * `followedByOutcome`: after a follow, the count of the skill's relevant items rose above what she carried when it was shown (within
 * 10 decisions). Closed values only; a gist's text is never read or logged.
 */
export const FOLLOW_WITHIN_DECISIONS = 3;
export const OUTCOME_WITHIN_DECISIONS = 10;

/** The items whose count rising counts as a skill's outcome; a skill with none has no outcome measure. */
const RELEVANT: Readonly<Record<string, (counts: ItemCounts) => number>> = {
  'mc-bed-before-night': counts => countMatching(counts, BED_ITEM),
  'mc-nether-portal': counts => countMatching(counts, /^(?:obsidian|flint_and_steel)$/u),
  'mc-blaze-rods': counts => countMatching(counts, /^blaze_rod$/u),
  'mc-food-and-pace': counts => countMatching(counts, COOKED_FOOD),
  'mc-low-health': counts => countMatching(counts, COOKED_FOOD),
};

/**
 * Generic body tools used by a skill's procedure, attributed to it by their arguments (a tool that is specific to a skill is
 * attributed by `followedGists`, which this adds to; `mc.find-nearest-entity` and `mc.craft-one` are generic and were never counted).
 */
export function predicateSkills(name: string, input: unknown): string[] {
  const words = argumentWords(input), skills: string[] = [];
  if ((name === 'mc.find-nearest-entity' && words.includes('sheep')) || (name === 'mc.craft-one' && words.some(word => BED_ITEM.test(word)))
    || name === 'mc.sleep-in-bed') skills.push('mc-bed-before-night');
  const obsidian = /^mc\.(?:mine|dig|collect)/u.test(name) && words.includes('obsidian');
  if (obsidian || (name === 'mc.craft-one' && words.includes('flint_and_steel'))) skills.push('mc-nether-portal');
  return skills;
}

export interface GistTrack { shownAt: number; base: number; followedAt: number | null; followedLogged: boolean }
export interface GistAdoptionState { tracks: Record<string, GistTrack>; ignored: Record<string, number> }
export const emptyGistAdoption = (): GistAdoptionState => ({ tracks: {}, ignored: {} });

export interface GistAdoptionEvent {
  skill: string; shownAt: number; followed: 'yes' | 'no' | 'pending'; outcome: 'yes' | 'no' | 'pending' | '-'; ignoredStreak: number;
}
const relevant = (skill: string, counts: ItemCounts) => RELEVANT[skill]?.(counts) ?? 0;

/** A rise in a followed gist's relevant items, or the end of its outcome window: the outcome event. Call at a decision's observation. */
export function observeGistOutcomes(state: GistAdoptionState, decision: number, counts: ItemCounts): GistAdoptionEvent[] {
  const events: GistAdoptionEvent[] = [];
  for (const [skill, track] of Object.entries(state.tracks)) {
    if (track.followedAt === null || !track.followedLogged) continue;
    const rose = relevant(skill, counts) > track.base, over = decision - track.shownAt > OUTCOME_WITHIN_DECISIONS;
    if (!rose && !over) continue;
    events.push({ skill, shownAt: track.shownAt, followed: 'yes', outcome: rose ? 'yes' : 'no', ignoredStreak: state.ignored[skill] ?? 0 });
    delete state.tracks[skill];
  }
  return events;
}

/** The skills whose gist this decision shows: each without an open window opens one (a `pending` event). */
export function showGists(state: GistAdoptionState, decision: number, shown: readonly string[], counts: ItemCounts): GistAdoptionEvent[] {
  const events: GistAdoptionEvent[] = [];
  for (const skill of shown.slice(0, 8)) {
    if (state.tracks[skill] || Object.keys(state.tracks).length >= 8) continue;
    state.tracks[skill] = { shownAt: decision, base: relevant(skill, counts), followedAt: null, followedLogged: false };
    events.push({ skill, shownAt: decision, followed: 'pending', outcome: 'pending', ignoredStreak: state.ignored[skill] ?? 0 });
  }
  return events;
}

/** A call of this decision attributed to these skills (only those shown at this decision, within their window, count). */
export function noteGistCall(state: GistAdoptionState, decision: number, skills: readonly string[]): void {
  for (const skill of skills) {
    const track = state.tracks[skill];
    if (track && track.followedAt === null && decision - track.shownAt < FOLLOW_WITHIN_DECISIONS) track.followedAt = decision;
  }
}

/** The end of a decision: a follow is reported (and ends the ignored streak); a window that ran out unfollowed lengthens it. */
export function closeGistDecision(state: GistAdoptionState, decision: number): GistAdoptionEvent[] {
  const events: GistAdoptionEvent[] = [];
  for (const [skill, track] of Object.entries(state.tracks)) {
    if (track.followedAt !== null && !track.followedLogged) {
      track.followedLogged = true;
      state.ignored[skill] = 0;
      const measured = RELEVANT[skill] !== undefined;
      events.push({ skill, shownAt: track.shownAt, followed: 'yes', outcome: measured ? 'pending' : '-', ignoredStreak: 0 });
      if (!measured) delete state.tracks[skill];
    } else if (track.followedAt === null && decision - track.shownAt >= FOLLOW_WITHIN_DECISIONS - 1) {
      state.ignored[skill] = Math.min((state.ignored[skill] ?? 0) + 1, 999);
      events.push({ skill, shownAt: track.shownAt, followed: 'no', outcome: '-', ignoredStreak: state.ignored[skill]! });
      delete state.tracks[skill];
    }
  }
  return events;
}

/**
 * `Shannon Minecraft gist adoption task=<id> d=<decision> skill=<name> shownAt=<d> followedWithinN=<yes|no|pending>
 * outcome=<yes|no|pending|-> ignoredStreak=<n>`
 */
export function gistAdoptionLine(task: string, decision: number, event: GistAdoptionEvent): string {
  const skill = /^[a-z0-9-]{1,64}$/u.test(event.skill) ? event.skill : '-';
  return `Shannon Minecraft gist adoption task=${task} d=${decision} skill=${skill} shownAt=${event.shownAt} followedWithinN=${event.followed} `
    + `outcome=${event.outcome} ignoredStreak=${event.ignoredStreak}`;
}
