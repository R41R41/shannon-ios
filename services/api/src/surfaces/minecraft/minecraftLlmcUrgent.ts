import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { isShooter, nearThreats, type NearThreat } from './minecraftLlmcThreat.js';

/**
 * mb-llmc r8 (run 32, 2026-10-22: the decision after 「wither_skeleton #696 は見える・6m」 took 10.3 s, and in that time she was hit three
 * times in 2.3 s and thrown off the bridge; the model's answer reached the body 0.1 s after her death): a decision being waited for is
 * thrown away when a hostile she must act on comes (`newApproach`, polled while the model is awaited: `FcaBodyLifecycle.interrupt`), and the
 * decision is asked again at once on a short live state (`minecraftLlmcUrgentLive`: the urgent lines, the footing, the map, her state, her food
 * and recovery, the hostiles, what she holds, the plan's now by its title). An urgent step uses the same short state. Facts only: what to do is the
 * decision's, in the instructions' words (「急ぎの時」).
 */
export const URGENT_MODE = '急ぎの版';
/** GPT's review 2026-10-28: the live state is data; how to answer an urgent decision (a short thought, one act of three hands at most, the order of the hands) is in the instructions (「急ぎの時」), and the live state only says that it is the short one. */
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
export function urgentRange(threat: { name: string; canReachMe?: boolean | null; canSee?: boolean | null; reach?: string | null }, meters: number): number {
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

/** The nearest hostile she must act on now that was not so when the decision was asked (its id is not in `baseline`), as a line, or null. */
export function newApproach(observation: BodyObservation | null, baseline: ReadonlySet<number>, meters: (name: string) => number): string | null {
  const found = nearThreats(observation).find(threat => threat.id !== null && !baseline.has(threat.id) && approaching(threat, meters(threat.name)));
  return found ? frameThreatLine(found) : null;
}

/** The plan's now by its title only: `[p1.2] 作業台と木のツルハシ` from `[p1.2] 作業台と木のツルハシ＠…（済み: …）（道: …）`. */
export function planNowTitle(planNow: string | null | undefined): string | null {
  const match = planNow ? /^(\[[^\]]+\]\s*[^＠（(]+)/u.exec(planNow) : null;
  return match ? match[1]!.trim().slice(0, 60) : null;
}
