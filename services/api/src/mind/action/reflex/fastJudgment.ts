/**
 * The image-free fast judgment of Syzygy ADR-0011 stage 2 (`SHANNON_MINECRAFT_FAST_JUDGMENT`, default off): from a body's own state
 * (hostiles and their distances, health and its trend, night, a recent respawn) it picks one of the body's existing defensive skills
 * in well under a millisecond, with no image and no model. Minecraft run 11 (2026-10-15, task 7e4c437a): at night a danger reflex
 * stopped her `attack-continuously`, could not get a picture and stood still while a zombie took her from 17 health to 0; then she
 * died five more times right after each respawn, each time before anything decided for her. Pure: no clock, body or network here.
 * Design: Syzygy `notes/adr0011-stage2-fast-judgment.md`.
 */
export const FAST_JUDGMENT_LIMITS = Object.freeze({
  /** A reachable hostile this close opens the judgment (by night `nightDistance`). */
  closeDistance: 6, nightDistance: 8,
  /** Health lower than `healthWindowMs` ago, with a hostile this close, opens it too. */
  damageDistance: 12, healthWindowMs: 3_000,
  /** After a respawn (or login), a hostile this close opens it, and the first move is to take shelter. */
  respawnDistance: 16, respawnWindowMs: 30_000,
  /** An ignited creeper this close belongs to the body's floor (`retreat`, priority 350), never to this judgment. */
  floorCreeperDistance: 4.5,
  /** A frame older than this is never acted on: the answer would be stale. */
  maxStateAgeMs: 1_000,
});

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'drowned_trident']);
const WEAPON = /(_sword|_axe|^trident|^mace)$/u;
/** Skills that already defend her: a fast judgment never cuts one off (run 11: a danger reflex stopped her fight and she died). */
export const DEFENSIVE_SKILLS: ReadonlySet<string> = new Set(['attack-continuously', 'attack-nearest', 'retreat-attack', 'flee-from',
  'dig-shelter', 'build-around-self']);

export interface FastThreat { name: string; distance: number; canReachMe: boolean; ignited: boolean }
export interface FastBodyState {
  health: number | null; threats: readonly FastThreat[]; night: boolean; respawnedRecently: boolean; healthDropped: boolean;
  hasWeapon: boolean;
  /**
   * Whether the body's floor holds its safety lease; `floorKnown` is false when the body does not report `floorActive` at all
   * (see `floorMayRun`).
   */
  floorActive: boolean; floorKnown: boolean;
  /** Her `dig-shelter` already failed in this danger episode: the next move is to flee, not to dig again. */
  shelterFailed: boolean;
}
export type FastKind = 'fight' | 'flee' | 'shelter';
export type FastEntry = 'close' | 'damage' | 'respawn';
export interface FastDecision {
  kind: FastKind; skill: string; arguments: Record<string, string | number | boolean>;
  /** The closed rule that chose it; `ambiguous` when only the default decided (an image-free arbiter may later choose). */
  rule: 'respawn_shelter' | 'low_health_shelter' | 'low_health_flee' | 'creeper_flee' | 'outnumbered_shelter' | 'ranged_shelter'
    | 'melee_fight' | 'ambiguous_shelter' | 'shelter_failed_flee';
  ambiguous: boolean;
}
export type FastHold = 'no_threat' | 'floor_active' | 'floor_unknown' | 'floor_creeper';
export type FastVerdict = { entry: FastEntry; decision: FastDecision } | { entry: FastEntry | null; hold: FastHold };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The state the judgment reads from a frame (`state.world`, `facts`), with what the caller remembers: the health `healthWindowMs`
 * ago and the time since the body last arrived. Unknown values read as the safer side (no weapon, health unknown).
 */
export function fastBodyState(observation: { facts: Readonly<Record<string, unknown>>; state: unknown },
  memory: { earlierHealth: number | null; sinceArrivalMs: number | null; shelterFailed?: boolean }): FastBodyState {
  const world = record(record(observation.state)?.world) ?? {};
  const health = finite(world.health) && world.health > 0 ? world.health : null;
  const threats = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).flatMap(item => {
    const threat = record(item);
    if (!threat || typeof threat.name !== 'string' || !finite(threat.distance) || threat.distance < 0) return [];
    return [{ name: threat.name.slice(0, 40), distance: threat.distance, canReachMe: threat.canReachMe !== false, ignited: threat.ignited === true }];
  });
  const tick = Number(world.time);
  const night = Number.isFinite(tick) && ((tick % 24000) + 24000) % 24000 >= 13_000 && ((tick % 24000) + 24000) % 24000 < 23_000;
  const inventory = Array.isArray(world.inventory) ? world.inventory : [];
  return { health, threats, night,
    respawnedRecently: memory.sinceArrivalMs !== null && memory.sinceArrivalMs < FAST_JUDGMENT_LIMITS.respawnWindowMs,
    healthDropped: health !== null && memory.earlierHealth !== null && health < memory.earlierHealth,
    hasWeapon: inventory.some(item => typeof record(item)?.name === 'string' && WEAPON.test(String(record(item)!.name))),
    floorActive: observation.facts.floorActive === true, floorKnown: typeof observation.facts.floorActive === 'boolean',
    shelterFailed: memory.shelterFailed === true };
}

/** Why the judgment opens for this state, or null. */
export function fastEntry(state: FastBodyState): FastEntry | null {
  const near = (distance: number) => state.threats.some(threat => threat.canReachMe && threat.distance <= distance);
  if (state.respawnedRecently && near(FAST_JUDGMENT_LIMITS.respawnDistance)) return 'respawn';
  if (state.healthDropped && near(FAST_JUDGMENT_LIMITS.damageDistance)) return 'damage';
  if (near(state.night ? FAST_JUDGMENT_LIMITS.nightDistance : FAST_JUDGMENT_LIMITS.closeDistance)) return 'close';
  return null;
}

const decision = (kind: FastKind, rule: FastDecision['rule'], target = 'hostile'): FastDecision => ({
  kind, rule, ambiguous: rule === 'ambiguous_shelter',
  ...(kind === 'fight' ? { skill: 'attack-continuously', arguments: { entityName: 'hostile', maxAttacks: 12 } }
    : kind === 'flee' ? { skill: 'flee-from', arguments: { target, minDistance: 16, timeout: 6000 } }
      : { skill: 'dig-shelter', arguments: {} }),
});

/** The deterministic rules, in order (the design's table). Never eats: the floor does (`eat`, priority 200). */
export function fastJudgment(state: FastBodyState): FastVerdict {
  const entry = fastEntry(state);
  if (state.floorActive) return { entry, hold: 'floor_active' };
  // An older body does not say whether its floor runs: hold only while its `retreat` could be running (`floorMayRun`).
  if (!state.floorKnown && entry && floorMayRun(state)) return { entry, hold: 'floor_unknown' };
  if (state.threats.some(threat => threat.ignited && threat.name === 'creeper' && threat.distance <= FAST_JUDGMENT_LIMITS.floorCreeperDistance)) {
    return { entry, hold: 'floor_creeper' };
  }
  if (!entry) return { entry, hold: 'no_threat' };
  return { entry, decision: afterFailedShelter(state, ruled(state, entry)) };
}

/**
 * Unknown floor (the body sends no `floorActive`; Minebot's TI-REQ is not yet delivered). The choice: hold only when the floor could
 * hold its lease, i.e. when its priority-350 `retreat` could be running: an ignited creeper (unknown too on such a body, so any
 * creeper within `floorCreeperDistance` counts) or a ranged attacker within `rangedDistance` (arrows). Otherwise act, so stage 2 is
 * not useless on the bodies in production today: the floor's `eat` does not run with an enemy within 5 m (unless health is at most 6)
 * and its other reflexes (lava, breathing, armour) are not about the enemies this judgment answers. Cost: on such a body a ranged
 * attacker's shelter and a creeper's close flee wait for the field; the melee fights and shelters of run 11 do not.
 */
export const FLOOR_UNKNOWN_HOLDS = Object.freeze({ rangedDistance: 16 });
function floorMayRun(state: FastBodyState): boolean {
  return state.threats.some(threat => (threat.name === 'creeper' && threat.distance <= FAST_JUDGMENT_LIMITS.floorCreeperDistance)
    || (RANGED.has(threat.name) && threat.distance <= FLOOR_UNKNOWN_HOLDS.rangedDistance));
}

/** The rules after the entry, in the design's order. */
function ruled(state: FastBodyState, entry: FastEntry): FastDecision {
  const reachable = state.threats.filter(threat => threat.canReachMe);
  const within = (distance: number) => reachable.filter(threat => threat.distance <= distance);
  const health = state.health ?? 0;
  if (entry === 'respawn') return decision('shelter', 'respawn_shelter');
  if (health <= 6) return within(3).length ? decision('shelter', 'low_health_shelter') : decision('flee', 'low_health_flee');
  if (within(6).some(threat => threat.name === 'creeper')) return decision('flee', 'creeper_flee', 'creeper');
  if (within(8).length >= 3) return decision('shelter', 'outnumbered_shelter');
  const melee = within(6).filter(threat => !RANGED.has(threat.name));
  if (!melee.length && state.threats.some(threat => RANGED.has(threat.name) && threat.distance <= 16)) return decision('shelter', 'ranged_shelter');
  if (melee.length >= 1 && melee.length <= 2 && health >= (state.hasWeapon ? 9 : 12)) return decision('fight', 'melee_fight');
  return decision('shelter', 'ambiguous_shelter');
}

/** Hiding failed in this danger episode: flee instead (the design's "if hiding failed, flee next"). */
function afterFailedShelter(state: FastBodyState, chosen: FastDecision): FastDecision {
  if (!state.shelterFailed || chosen.kind !== 'shelter') return chosen;
  const creeper = state.threats.some(threat => threat.canReachMe && threat.name === 'creeper' && threat.distance <= 6);
  return decision('flee', 'shelter_failed_flee', creeper ? 'creeper' : 'hostile');
}

/** How long each skill may run before its command expires. */
export function fastSkillMilliseconds(skill: string): number {
  return skill === 'attack-continuously' ? 15_000 : skill === 'flee-from' ? 8_000 : 10_000;
}
