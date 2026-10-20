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
  /**
   * A frame older than this is never acted on: the answer would be stale. As the adapter's own `maxStateAgeMs` (3 s): this is the
   * only place this limit is read, and 1 s dropped a `fight` against zombies at the body's door in run 12 (a skill's 2 s settle
   * alone can outlast it).
   */
  maxStateAgeMs: 3_000,
  /** At or below this health the rules shelter or flee before anything else (an unknown health counts as 0). */
  lowHealth: 6,
  /**
   * A fast skill that failed rests this long (Minecraft run 16, 2026-10-19: `dig-shelter` failed six times in 30 s on the same
   * "the floor of the hole is air", and each cut off her `mine-block`): within it the rules choose the next move instead.
   */
  restMs: 60_000,
  /**
   * A creeper this close opens the judgment and is fled, by day too, before it is near (owner 2026-10-19, Minecraft run 17: a
   * creeper at 6 m was fought, the flee from 6.2 m moved 2 m and failed, and it blew up at her side from full health).
   */
  creeperDistance: 10,
  /**
   * Two melee enemies or more at her, with health at this or lower or fewer than `bareArmor` pieces of armour on, are not fought
   * standing: she goes up a pillar or walls herself in first (run 20, 2026-10-20: a stone axe, no armour and 13 of 20 against two
   * zombies took her to 7 in 26 s and then to 0 while the cage was being built).
   */
  outnumberedHealth: 14, bareArmor: 2,
  /**
   * One or two archers at her, with a sword in hand, at least `bareArmor` pieces of armour on and this health or more, are fought, not
   * hidden from (run 21, 2026-10-21: one skeleton and a creeper in a cave at 20 of 20 in iron armour with an iron sword; the rules took
   * the archer for a ranged enemy, built cages and ran for 140 s, nobody struck once, and she was at 5 of 20). An archer is weak up close.
   */
  shooterFightHealth: 10, shooterFightMax: 2,
});
/** Three blocks up a pillar of her own blocks: what a creeper cannot reach when running from it failed (`tower-up`). */
const TOWER = Object.freeze({ skill: 'tower-up', height: 3, blocks: 3 });
/**
 * The cage the body builds where it stands (`build-around-self`, `slit_shelter`: about ten building blocks and four slabs, a few
 * seconds, no digging): the shelter once `dig-shelter` rests. The body's own list of building blocks (Minebot `buildAroundSelf.ts`).
 */
const CAGE = Object.freeze({ skill: 'build-around-self', structureName: 'slit_shelter', blocks: 10, slabs: 4 });
const BUILDING_BLOCKS: ReadonlySet<string> = new Set(['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite',
  'blackstone', 'tuff', 'basalt', 'nether_bricks', 'stone_bricks', 'end_stone', 'dirt', 'netherrack']);

/** Enemies that shoot from afar (shared with the refusal of her fights, minecraftOutcome.ts). */
export const RANGED_ENEMIES: ReadonlySet<string> = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'drowned_trident']);
const RANGED = RANGED_ENEMIES;
/** The archers that are walked up to and struck (the others shoot from where blows do not reach, or fly). */
export const WALK_UP_SHOOTERS: ReadonlySet<string> = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch']);
const WEAPON = /(_sword|_axe|^trident|^mace)$/u;
/**
 * The fights she chooses herself (`mc.combat` and the others): while one is hers the fast judgment does not take the body from her
 * (`minecraftFastJudgment.ts`), and a decision of this kind is not dropped because a reflex touched the body meanwhile (the adapter's
 * `guardFor`). Run 21: three of them were dropped as stale, one after the other, and nobody struck.
 */
export const FIGHT_SKILLS: ReadonlySet<string> = new Set(['attack-continuously', 'attack-nearest', 'retreat-attack', 'combat', 'combat-engage']);
/** Skills that already defend her: a fast judgment never cuts one off (run 11: a danger reflex stopped her fight and she died). */
export const DEFENSIVE_SKILLS: ReadonlySet<string> = new Set([...FIGHT_SKILLS, 'flee-from', 'dig-shelter', 'build-around-self', 'tower-up']);

/**
 * `canReachMe`: the body's word, true or false, or null when it said nothing (Minecraft run 18, 07:23:23 and 07:23:46 JST: a zombie
 * behind a wall, not marked, was read as reaching her and fought for 15 s twice, cutting off three of her decisions).
 */
export interface FastThreat { name: string; distance: number; canReachMe: boolean | null; ignited: boolean }
export interface FastBodyState {
  health: number | null; threats: readonly FastThreat[]; night: boolean; respawnedRecently: boolean; healthDropped: boolean;
  hasWeapon: boolean;
  /**
   * Whether the body's floor holds its safety lease; `floorKnown` is false when the body does not report `floorActive` at all
   * (see `floorMayRun`).
   */
  floorActive: boolean; floorKnown: boolean;
  /** Her `dig-shelter` failed within `restMs` (it rests): the next move is the cage, or to flee, not to dig again. */
  shelterFailed: boolean;
  /** The fast skills that failed within `restMs` and rest: none of them is chosen again until it is over. */
  resting: ReadonlySet<string>;
  /** She carries what the cage takes (`CAGE`: building blocks and slabs). */
  canCage: boolean;
  /** She carries the blocks of a pillar (`TOWER`). */
  canTower: boolean;
  /**
   * How many of the four armour slots hold something (`world.worn`, the body's one line of what she wears); absent when the body says
   * nothing of it (the rules then read her as armoured, as before).
   */
  armorPieces?: number;
}
export type FastKind = 'fight' | 'flee' | 'shelter';
export type FastEntry = 'close' | 'damage' | 'respawn';
export interface FastDecision {
  kind: FastKind; skill: string; arguments: Record<string, string | number | boolean>;
  /** The closed rule that chose it; `ambiguous` when only the default decided (an image-free arbiter may later choose). */
  rule: 'respawn_shelter' | 'low_health_shelter' | 'low_health_flee' | 'creeper_flee' | 'outnumbered_shelter' | 'ranged_shelter'
    | 'melee_fight' | 'ambiguous_shelter' | 'shelter_failed_flee' | 'shelter_failed_cage' | 'fight_resting_flee' | 'creeper_tower'
    | 'outnumbered_tower' | 'outnumbered_cage' | 'low_health_tower' | 'shooter_fight';
  ambiguous: boolean;
}
export type FastHold = 'no_threat' | 'floor_active' | 'floor_unknown' | 'floor_creeper';
export type FastVerdict = { entry: FastEntry; decision: FastDecision } | { entry: FastEntry | null; hold: FastHold };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const record = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The armour slots filled, from the body's one line of what she wears (`頭: iron_helmet(残り…)、胴: なし、…`); nothing when the body says none. */
function armorOf(worn: unknown): { armorPieces?: number } {
  if (typeof worn !== 'string') return {};
  return { armorPieces: [...worn.slice(0, 400).matchAll(/(?:頭|胴|脚|足):\s*[a-z][a-z0-9_]*/gu)].length };
}

/**
 * The state the judgment reads from a frame (`state.world`, `facts`), with what the caller remembers: the health `healthWindowMs`
 * ago and the time since the body last arrived. Unknown values read as the safer side (no weapon, health unknown).
 */
export function fastBodyState(observation: { facts: Readonly<Record<string, unknown>>; state: unknown },
  memory: { earlierHealth: number | null; sinceArrivalMs: number | null; shelterFailed?: boolean; resting?: ReadonlySet<string> }): FastBodyState {
  const world = record(record(observation.state)?.world) ?? {};
  const health = finite(world.health) && world.health > 0 ? world.health : null;
  const threats = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).flatMap(item => {
    const threat = record(item);
    if (!threat || typeof threat.name !== 'string' || !finite(threat.distance) || threat.distance < 0) return [];
    const canReachMe = typeof threat.canReachMe === 'boolean' ? threat.canReachMe : null;
    return [{ name: threat.name.slice(0, 40), distance: threat.distance, canReachMe, ignited: threat.ignited === true }];
  });
  const tick = Number(world.time);
  const night = Number.isFinite(tick) && ((tick % 24000) + 24000) % 24000 >= 13_000 && ((tick % 24000) + 24000) % 24000 < 23_000;
  const inventory = Array.isArray(world.inventory) ? world.inventory : [];
  const resting = memory.resting ?? new Set<string>();
  return { health, threats, night, ...armorOf(world.worn),
    respawnedRecently: memory.sinceArrivalMs !== null && memory.sinceArrivalMs < FAST_JUDGMENT_LIMITS.respawnWindowMs,
    healthDropped: health !== null && memory.earlierHealth !== null && health < memory.earlierHealth,
    hasWeapon: inventory.some(item => typeof record(item)?.name === 'string' && WEAPON.test(String(record(item)!.name))),
    floorActive: observation.facts.floorActive === true, floorKnown: typeof observation.facts.floorActive === 'boolean',
    shelterFailed: memory.shelterFailed === true || resting.has('dig-shelter'), resting,
    canCage: carried(inventory, name => BUILDING_BLOCKS.has(name)) >= CAGE.blocks && carried(inventory, name => name.endsWith('_slab')) >= CAGE.slabs,
    canTower: carried(inventory, name => BUILDING_BLOCKS.has(name)) >= TOWER.blocks };
}
/** How many of the items she carries pass `test` (`{name, count}` stacks; a stack without a count is one). */
function carried(inventory: readonly unknown[], test: (name: string) => boolean): number {
  return inventory.reduce<number>((total, item) => {
    const stack = record(item), name = typeof stack?.name === 'string' ? stack.name.replace(/^minecraft:/u, '') : '';
    const count = finite(stack?.count) ? stack!.count as number : 1;
    return name && test(name) ? total + Math.max(0, count) : total;
  }, 0);
}

/** Why the judgment opens for this state, or null. */
export function fastEntry(state: FastBodyState): FastEntry | null {
  // Health falling or a fresh respawn: one not marked may be what reaches her. Merely near: only one the body says reaches her.
  const near = (distance: number, unmarked: boolean) => state.threats.some(threat => reaches(threat, unmarked) && threat.distance <= distance);
  if (state.respawnedRecently && near(FAST_JUDGMENT_LIMITS.respawnDistance, true)) return 'respawn';
  if (state.threats.some(threat => reaches(threat, false) && threat.name === 'creeper' && threat.distance <= FAST_JUDGMENT_LIMITS.creeperDistance)) {
    return 'close';
  }
  if (state.healthDropped && near(FAST_JUDGMENT_LIMITS.damageDistance, true)) return 'damage';
  if (near(state.night ? FAST_JUDGMENT_LIMITS.nightDistance : FAST_JUDGMENT_LIMITS.closeDistance, false)) return 'close';
  return null;
}
/**
 * Reaches her: the body says so, or it said nothing either way and (`unmarked`) health falls or she just arrived. A creeper or an
 * archer the body said nothing of always counts: a blast or an arrow needs no path, and hiding from one behind a wall costs seconds,
 * not a life (the review of run 18's change).
 */
const reaches = (threat: FastThreat, unmarked: boolean) => threat.canReachMe === true
  || (threat.canReachMe === null && (unmarked || threat.name === 'creeper' || RANGED_ENEMIES.has(threat.name)));

const decision = (kind: FastKind, rule: FastDecision['rule'], target = 'hostile'): FastDecision => ({
  kind, rule, ambiguous: rule === 'ambiguous_shelter',
  ...(rule === 'creeper_tower' || rule === 'outnumbered_tower' || rule === 'low_health_tower' ? { skill: TOWER.skill, arguments: { height: TOWER.height } }
    : kind === 'fight' ? { skill: 'attack-continuously', arguments: { entityName: 'hostile', maxAttacks: 12 } }
    : kind === 'flee' ? { skill: 'flee-from', arguments: { target, minDistance: 16, timeout: 6000 } }
      : rule === 'shelter_failed_cage' || rule === 'outnumbered_cage' ? { skill: CAGE.skill, arguments: { structureName: CAGE.structureName } }
        : { skill: 'dig-shelter', arguments: {} }),
});

/** The deterministic rules, in order (the design's table). Never eats: the floor does (`eat`, priority 200). */
export function fastJudgment(state: FastBodyState): FastVerdict {
  const entry = fastEntry(state);
  if (state.floorActive) return { entry, hold: 'floor_active' };
  // An older body does not say whether its floor runs: hold only while its `retreat` could be running (`floorMayRun`).
  // Low health never waits for a floor that may not exist: shelter or flee below.
  if (!state.floorKnown && entry && (state.health ?? 0) > FAST_JUDGMENT_LIMITS.lowHealth && floorMayRun(state)) return { entry, hold: 'floor_unknown' };
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

/** She has the blocks for a pillar and has not climbed one within `restMs`. */
const towerFree = (state: FastBodyState) => state.canTower && !state.resting.has(TOWER.skill);

/**
 * At the floor of the rules: with one at her, a pillar if she can climb (a second or two) before a cage (five seconds of blows;
 * run 20: dead with the cage half built).
 */
function atTheFloor(state: FastBodyState, atHer: boolean): FastDecision {
  if (!atHer) return decision('flee', 'low_health_flee');
  return towerFree(state) ? decision('flee', 'low_health_tower') : decision('shelter', 'low_health_shelter');
}

/**
 * Two melee enemies at her, hurt or unarmoured: up a pillar or into the cage before the blows, while there is health to build with (a
 * cage at 10, not at 3). Null when the fight stands (armoured and healthy, or neither way is open).
 */
function outnumbered(state: FastBodyState, melee: readonly FastThreat[], health: number): FastDecision | null {
  const bare = (state.armorPieces ?? FAST_JUDGMENT_LIMITS.bareArmor) < FAST_JUDGMENT_LIMITS.bareArmor;
  if (melee.length < 2 || !(bare || health <= FAST_JUDGMENT_LIMITS.outnumberedHealth)) return null;
  if (towerFree(state)) return decision('flee', 'outnumbered_tower');
  return state.canCage && !state.resting.has(CAGE.skill) ? decision('shelter', 'outnumbered_cage') : null;
}

/** A weapon in the pack and at least `bareArmor` pieces of armour worn, from a frame's world (an unknown armour reads as worn, as in `fastBodyState`). */
export function armedAndArmoured(world: unknown): boolean {
  const body = record(world) ?? {};
  const inventory = Array.isArray(body.inventory) ? body.inventory : [];
  const weapon = inventory.some(item => typeof record(item)?.name === 'string' && WEAPON.test(String(record(item)!.name)));
  return weapon && (armorOf(body.worn).armorPieces ?? FAST_JUDGMENT_LIMITS.bareArmor) >= FAST_JUDGMENT_LIMITS.bareArmor;
}

/**
 * Whether one or two archers at her are fought: a weapon in hand, `bareArmor` pieces of armour or more (an unknown count reads as
 * armoured, as in `outnumbered`), health at `shooterFightHealth` or more, and every shooter within 16 m one that is walked up to.
 */
function shooterFight(state: FastBodyState, reachable: readonly FastThreat[], health: number): boolean {
  const shooters = reachable.filter(threat => RANGED.has(threat.name));
  return state.hasWeapon && (state.armorPieces ?? FAST_JUDGMENT_LIMITS.bareArmor) >= FAST_JUDGMENT_LIMITS.bareArmor
    && health >= FAST_JUDGMENT_LIMITS.shooterFightHealth && shooters.length >= 1 && shooters.length <= FAST_JUDGMENT_LIMITS.shooterFightMax
    && shooters.every(threat => WALK_UP_SHOOTERS.has(threat.name));
}

/** Archers only, none in melee: armed and armoured against one or two that can be walked up to, the fight first (never with a creeper within 10 m). */
function rangedDecision(state: FastBodyState, near: readonly FastThreat[], health: number, creeperNear: boolean): FastDecision {
  return !creeperNear && shooterFight(state, near, health) ? decision('fight', 'shooter_fight') : decision('shelter', 'ranged_shelter');
}

/** The rules after the entry, in the design's order. */
function ruled(state: FastBodyState, entry: FastEntry): FastDecision {
  const reachable = state.threats.filter(threat => reaches(threat, entry !== 'close'));
  const within = (distance: number) => reachable.filter(threat => threat.distance <= distance);
  const health = state.health ?? 0;
  if (entry === 'respawn') return decision('shelter', 'respawn_shelter');
  if (health <= FAST_JUDGMENT_LIMITS.lowHealth) return atTheFloor(state, within(3).length > 0);
  if (within(6).some(threat => threat.name === 'creeper')) return decision('flee', 'creeper_flee', 'creeper');
  if (within(8).length >= 3) return decision('shelter', 'outnumbered_shelter');
  // Merely near (`close`), a fight only with one the body says reaches her (run 18: twice 15 s against a zombie behind a wall).
  const melee = within(6).filter(threat => !RANGED.has(threat.name));
  const before = outnumbered(state, melee, health);
  if (before) return before;
  const creeperNear = within(FAST_JUDGMENT_LIMITS.creeperDistance).some(threat => threat.name === 'creeper');
  if (!melee.length && state.threats.some(threat => RANGED.has(threat.name) && threat.distance <= 16)) {
    return rangedDecision(state, within(16), health, creeperNear);
  }
  // Never a fight with a creeper within 10 m (a fight's target is any hostile, the creeper among them): away from it first.
  if (creeperNear) return decision('flee', 'creeper_flee', 'creeper');
  if (melee.length >= 1 && melee.length <= 2 && health >= (state.hasWeapon ? 9 : 12)) return decision('fight', 'melee_fight');
  return decision('shelter', 'ambiguous_shelter');
}

/**
 * A chosen skill that rests (it failed within `restMs`) is not sent again. Hiding failed: the cage where she stands when she carries
 * its blocks and it does not rest itself, else flee (the design's "if hiding failed, flee next"; run 16: the hole's floor was air six
 * times running). A fight that failed: flee. A flee that rests is still sent: nothing else is left.
 */
function afterFailedShelter(state: FastBodyState, chosen: FastDecision): FastDecision {
  const creeper = state.threats.some(threat => threat.canReachMe !== false && threat.name === 'creeper' && threat.distance <= 6);
  // Running from a creeper failed (run 17: 2 m over rough ground): up a pillar it cannot climb, when she has the blocks.
  if (chosen.rule === 'creeper_flee' && state.resting.has(chosen.skill) && state.canTower && !state.resting.has(TOWER.skill)) {
    return decision('flee', 'creeper_tower');
  }
  if (chosen.kind === 'fight' && state.resting.has(chosen.skill)) return decision('flee', 'fight_resting_flee', creeper ? 'creeper' : 'hostile');
  if (chosen.kind !== 'shelter' || !(state.shelterFailed || state.resting.has(chosen.skill))) return chosen;
  // Not beside a creeper: the cage takes seconds to build, and its blast would open it.
  if (state.canCage && !state.resting.has(CAGE.skill) && !creeper) return decision('shelter', 'shelter_failed_cage');
  return decision('flee', 'shelter_failed_flee', creeper ? 'creeper' : 'hostile');
}

/** How long each skill may run before its command expires. */
export function fastSkillMilliseconds(skill: string): number {
  return skill === 'attack-continuously' ? 15_000 : skill === 'flee-from' ? 8_000 : 10_000;
}
