import { ADOPTION_TAGS } from './minecraftAdoptionTags.js';
import type { GistAdoptionState } from './minecraftGistAdoption.js';
import { MILESTONE_NAMES } from './minecraftMilestoneLog.js';

/**
 * The closed, bounded state of one task's measurement (`minecraftTaskMetrics.ts`), kept in the task's checkpoint under
 * `minecraftMetrics` because each decision is a new step with a new adapter. Read back defensively: anything unexpected is
 * dropped, so a damaged value starts that part afresh and never throws.
 */
export interface MetricsState {
  /** Decisions measured so far. */
  d: number;
  /** Milestones first reached (`MILESTONE_NAMES`), and adoption tags seen at least once. */
  reached: string[]; tags: string[];
  /** The ordered tools made, each once, in the order first made. */
  made: string[];
  ironDone: boolean; gist: GistAdoptionState;
  /** Lowest health seen while alive, deaths, decisions hungry with food carried and none eaten. */
  hpMin: number | null; deaths: number; hungryNoEat: number; alive: boolean | null;
  /** The nearest village's distance at the last decision, and whether that decision moved (`mc.move-to`). */
  village: number | null; moved: boolean;
  /** Cooked food items and whether a bed was carried at the last observation. */
  food: number; bed: boolean;
}

export const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const finite = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(number) ? number : null;
};
export const count = (value: unknown, limit = 999): number => {
  const number = finite(value);
  return number !== null && number >= 0 ? Math.min(Math.floor(number), limit) : 0;
};
const SKILL = /^[a-z0-9-]{1,64}$/u;
const TOOLS_MADE = ['wooden_pickaxe', 'stone_pickaxe', 'stone_axe'];
const only = (value: unknown, allowed: readonly string[]): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && allowed.includes(item)).slice(0, 32) : [];

function readGist(value: unknown): GistAdoptionState {
  const gist = record(value) ?? {}, tracks: GistAdoptionState['tracks'] = {}, ignored: GistAdoptionState['ignored'] = {};
  for (const [skill, raw] of Object.entries(record(gist.tracks) ?? {}).slice(0, 8)) {
    const track = record(raw);
    if (!track || !SKILL.test(skill)) continue;
    const followed = finite(track.followedAt);
    tracks[skill] = { shownAt: count(track.shownAt, 1e6), base: count(track.base, 1e6), followedAt: followed === null ? null : count(followed, 1e6),
      followedLogged: track.followedLogged === true };
  }
  for (const [skill, raw] of Object.entries(record(gist.ignored) ?? {}).slice(0, 16)) {
    if (SKILL.test(skill)) ignored[skill] = count(raw);
  }
  return { tracks, ignored };
}

export function readMetricsState(kept: unknown): MetricsState {
  const value = record(kept) ?? {};
  return { d: count(value.d, 1e6), reached: only(value.reached, MILESTONE_NAMES), tags: only(value.tags, ADOPTION_TAGS), made: only(value.made, TOOLS_MADE),
    ironDone: value.ironDone === true, gist: readGist(value.gist), hpMin: finite(value.hpMin), deaths: count(value.deaths),
    hungryNoEat: count(value.hungryNoEat), alive: typeof value.alive === 'boolean' ? value.alive : null, village: finite(value.village),
    moved: value.moved === true, food: count(value.food, 9_999), bed: value.bed === true };
}
