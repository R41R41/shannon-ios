import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { calmEnderman, isShooter, nearThreats, type NearThreat } from './minecraftLlmcThreat.js';

/**
 * mb-llmc r8 (run 32, 2026-10-22: the decision after 「wither_skeleton #696 は見える・6m」 took 10.3 s, and in that time she was hit three
 * times in 2.3 s and thrown off the bridge; the model's answer reached the body 0.1 s after her death): a decision being waited for is
 * thrown away when a hostile she must act on comes (`newApproach`, polled while the model is awaited: `FcaBodyLifecycle.interrupt`), and the
 * decision is asked again at once on a short live state (`minecraftLlmcUrgentLive`: the urgent lines, the footing, the map, her state, her food
 * and recovery, the hostiles, what she holds, the plan's now by its title). An urgent step uses the same short state. Facts only: what to do is the
 * decision's, in the instructions' words (「急ぎの時」).
 */
export const URGENT_MODE = '急ぎの版';
/**
 * GPT's review 2026-10-28: the live state is data; how to answer an urgent decision (a short thought, one act of three hands at most, the order of the
 * hands) is in the instructions (「急ぎの時」), and the live state only says that it is the short one.
 */
export const URGENT_NOTE = `${URGENT_MODE}（決まりは system の「急ぎの時」）`;

/**
 * run 26 (2026-10-26, 「エンドラを討伐して」: for 170 s the acts were cut 18 times by a creeper and zombies 5.6〜7.6 m away behind 4〜7 blocks of stone, 4 up, whose lines
 * the live state itself said 「壁の向こうで届かない」 / 「見えない・道はある（回って来る）」; each cut left a three-hand act): how near a hostile makes a step urgent
 * is by what the body says of its way. One the body says is sealed (`canReachMe` false, or `reach` walled) cuts nothing (a creeper, whose blast is near
 * the wall, within `SEALED_CREEPER_METERS`); one that does not see her but has a way round, within `UNSEEN_URGENT_METERS` (it takes the time of the way
 * to come);
 * any other within `meters` as before. A field the body did not say counts for it. Shooters are by sight alone (`approaching`, the act's watch).
 */
export const UNSEEN_URGENT_METERS = 5;
export const SEALED_CREEPER_METERS = 4;
export function urgentRange(threat: { name: string; canReachMe?: boolean | null; canSee?: boolean | null; reach?: string | null; angry?: boolean | null }, meters: number): number {
  if (calmEnderman(threat)) return 0;
  if (threat.canReachMe === false || threat.reach === 'walled') return threat.name === 'creeper' ? Math.min(meters, SEALED_CREEPER_METERS) : 0;
  if (isShooter(threat.name)) return meters;
  return threat.canSee === false || threat.reach === 'path_no_sight' ? Math.min(meters, UNSEEN_URGENT_METERS) : meters;
}

/**
 * A hostile she must act on now: within `meters` (`urgentRange`), a shooter only while it sees her (the body's `canSee`), any other while it can come
 * (`canReachMe` not false) and does not lack sight. A field the body did not say counts for it.
 */
export function approaching(threat: NearThreat, meters: number): boolean {
  if (threat.distance > urgentRange(threat, meters)) return false;
  if (isShooter(threat.name)) return threat.canSee === true;
  return threat.canReachMe !== false && threat.canSee !== false;
}

/** The ids of the hostiles of a frame she must act on now (`approaching`), for the baseline a decision is asked against. */
export function approachingIds(observation: BodyObservation | null, meters: (name: string) => number): Set<number> {
  return new Set(nearThreats(observation).flatMap(threat => threat.id !== null && approaching(threat, meters(threat.name)) ? [threat.id] : []));
}

/** A hostile's line from the frame alone: its name, id, distance, height, and what the body says of its sight and its way. */
export function frameThreatLine(threat: NearThreat): string {
  const height = threat.dy !== null && threat.dy !== 0 ? `・${threat.dy > 0 ? '上' : '下'} ${Math.abs(threat.dy)}` : '';
  const reach = threat.canSee === true ? '・見える（射線の中）' : threat.canReachMe === true ? '・道がある（回って来る）' : '';
  return `${threat.name}${threat.id !== null ? ` #${threat.id}` : ''} ${threat.distance.toFixed(1)}m${height}${reach}`;
}

/**
 * The nearest hostile she must act on now that was not so when the decision was asked (its id is not in `baseline`), as a line, or null.
 * `thinned` leaves out one that is only the same shooter back in sight (`sameShooterBack`); the next one is looked at in its place.
 */
export function newApproach(observation: BodyObservation | null, baseline: ReadonlySet<number>, meters: (name: string) => number,
  thinned?: (threat: NearThreat) => boolean): string | null {
  const found = nearThreats(observation).find(threat => threat.id !== null && !baseline.has(threat.id) && approaching(threat, meters(threat.name))
    && !thinned?.(threat));
  return found ? frameThreatLine(found) : null;
}

/**
 * 11/15c w1109n: 145 decisions were thrown away by the interrupt (and 96 by a changed queue; together 27% of the run's cost), nearly all while she
 * sat in a covered cell at the blaze spawner with health steady at 13.3 and the same blazes (#2781, #2765) 3〜7 m off behind the bricks: a blaze is
 * a shooter, a shooter counts only while it sees her (`approaching`), and each time one rose into sight during the 2〜3 s of a decision it was "new"
 * against the baseline of the request. What a decision was asked with is kept (`NearMemory`, at each request): the hostiles within their urgent
 * range whatever their sight or way, her health, and how many they were. A shooter seen so within `REENTRY_MS` that comes back into sight does not
 * throw the decision away while nothing else has changed: her health is not under the request's, she is not burning, and no more hostiles are near
 * than there were. Anything else is as it was: a hostile not seen near in that time, any that is no shooter (a creeper, a zombie that finds a way),
 * a hit, a fire, one more near; and the poll goes on, so a blow during the same wait still throws it away.
 */
export const REENTRY_MS = 30_000;
export interface NearMemory {
  /** The hostiles within their urgent range at a request, by id, and when they were last seen so (ms). */
  seen: Map<number, number>;
  /** Her health, and how many hostiles were within their urgent range, when the newest request was built. */
  hp: number | null;
  near: number;
}
export const nearMemory = (): NearMemory => ({ seen: new Map(), hp: null, near: 0 });
/** The hostiles within their urgent range, whatever their sight or way (a calm enderman is none). */
function nearNow(observation: BodyObservation | null, meters: (name: string) => number): NearThreat[] {
  return nearThreats(observation).filter(threat => !calmEnderman(threat) && threat.distance <= meters(threat.name));
}
const healthOf = (observation: BodyObservation | null): number | null => {
  const hp = (observation?.state.world as { health?: unknown } | undefined)?.health;
  return typeof hp === 'number' && Number.isFinite(hp) ? hp : null;
};
/** At a request: who is near, her health and the count; those not seen near for `REENTRY_MS` are forgotten. */
export function noteNear(memory: NearMemory, observation: BodyObservation | null, meters: (name: string) => number, now: number): void {
  const near = nearNow(observation, meters);
  for (const threat of near) if (threat.id !== null) memory.seen.set(threat.id, now);
  for (const [id, at] of memory.seen) if (now - at > REENTRY_MS) memory.seen.delete(id);
  memory.hp = healthOf(observation);
  memory.near = near.length;
}
/** The same shooter back in sight and nothing else changed since the request (see `REENTRY_MS`): its interrupt is left out. */
export function sameShooterBack(threat: NearThreat, observation: BodyObservation | null, memory: NearMemory, meters: (name: string) => number,
  now: number): boolean {
  if (threat.id === null || !isShooter(threat.name)) return false;
  const seen = memory.seen.get(threat.id), hp = healthOf(observation);
  if (seen === undefined || now - seen > REENTRY_MS || memory.hp === null || hp === null || hp < memory.hp) return false;
  if ((observation?.state.world as { onFire?: unknown } | undefined)?.onFire === true) return false;
  return nearNow(observation, meters).length <= memory.near;
}

/**
 * The plan's now by its title only: `[p1.2] 作業台と木のツルハシ`, from the node itself (chapter 7: its id and its title are read, not cut out of the shown
 * line, so a title with a （ in it is whole).
 */
export function planNowTitle(node: { id: string; title: string } | null | undefined): string | null {
  const title = node?.title.trim();
  return node && title ? `[${node.id}] ${title}`.slice(0, 80) : null;
}
