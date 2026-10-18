/**
 * The structure of a transient live state that can be left out when the request does not fit (observation redesign P3, review 4, M2),
 * before any text is cut: a text cut makes a name or a pointer unreadable, a missing far entity or late fact costs the model much less.
 * The live state is the body's (`minecraftTransientBody.ts`): `body.observation` with `nearbyEntities` and `facts`.
 *
 * Only low-value structure goes, in this order of levels, and what went is named in `observation.trimmed` (the count of each):
 *   - the entities beyond the nearest N (`entityKinds` still counts every kind in view with its nearest distance, and the threats are
 *     a list of their own that is never trimmed);
 *   - the facts after the first N (the adapter lists its own first).
 * Never trimmed: the inventory, the threats, the entity kinds, the position and vitals, the skill pointers and gists, the pace, the phase
 * facts, the jobs, the clock and the wait fact.
 */
type Row = Record<string, unknown>;
/** From the lightest trim to the heaviest. */
const STEPS: ReadonlyArray<{ entities: number; facts: number }> = [
  { entities: 10, facts: 40 }, { entities: 6, facts: 20 }, { entities: 3, facts: 10 }, { entities: 1, facts: 5 }, { entities: 0, facts: 0 }];

const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const distanceOf = (item: unknown): number => isRow(item) && typeof item.distance === 'number' && Number.isFinite(item.distance) ? item.distance : Infinity;

/** The nearest `keep` of the entities, in the order they were listed. */
function nearest(list: readonly unknown[], keep: number): unknown[] {
  if (list.length <= keep) return [...list];
  const chosen = new Set(list.map((item, index) => ({ index, distance: distanceOf(item) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index).slice(0, keep).map(item => item.index));
  return list.filter((_, index) => chosen.has(index));
}

/** The live state with the structure of trim level `level` (1 to 5) left out; the live state itself when that changes nothing. */
export function trimLive(live: Row, level: number): Row {
  const step = STEPS[Math.min(Math.max(level, 1), STEPS.length) - 1]!;
  const body = isRow(live.body) ? live.body : null, observation = body && isRow(body.observation) ? body.observation : null;
  if (!body || !observation) return live;
  const next: Row = { ...observation }, trimmed: string[] = [];
  if (Array.isArray(observation.nearbyEntities) && observation.nearbyEntities.length > step.entities) {
    next.nearbyEntities = nearest(observation.nearbyEntities, step.entities);
    trimmed.push(`nearbyEntities(${observation.nearbyEntities.length - step.entities})`);
  }
  if (isRow(observation.facts)) {
    const keys = Object.keys(observation.facts);
    if (keys.length > step.facts) {
      if (step.facts > 0) next.facts = Object.fromEntries(Object.entries(observation.facts).slice(0, step.facts));
      else delete next.facts;
      trimmed.push(`facts(${keys.length - step.facts})`);
    }
  }
  if (!trimmed.length) return live;
  next.trimmed = trimmed;
  return { ...live, body: { ...body, observation: next } };
}

/** The levels (1 to 5) at which the live state differs from the level before it: none when it has nothing to trim. */
export function trimLevels(live: Row): number[] {
  const levels: number[] = [];
  let before = JSON.stringify(live);
  for (let level = 1; level <= STEPS.length; level++) {
    const text = JSON.stringify(trimLive(live, level));
    if (text !== before) levels.push(level);
    before = text;
  }
  return levels;
}
