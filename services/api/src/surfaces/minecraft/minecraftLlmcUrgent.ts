import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { isShooter, nearThreats, type NearThreat } from './minecraftLlmcThreat.js';

/**
 * mb-llmc r8 (run 32, 2026-10-22: the decision after 「wither_skeleton #696 は見える・6m」 took 10.3 s, and in that time she was hit three
 * times in 2.3 s and thrown off the bridge; the model's answer reached the body 0.1 s after her death): a decision being waited for is
 * thrown away when a hostile she must act on comes (`newApproach`, polled while the model is awaited: `FcaBodyLifecycle.interrupt`), and the
 * decision is asked again at once on a short live state (`minecraftLlmcUrgentLive`: the urgent lines, the footing, the map, her state,
 * the hostiles, what she holds, the plan's now by its title). An urgent step uses the same short state. Facts only: what to do is the
 * decision's, in the words below and the knowledge's.
 */
export const URGENT_ANSWER = '急ぎの答え方: 考えは 2〜3 文まで。mc.act は 1 つ、手は 3 つまで、why は 20 字まで。'
  + '離れる・敵との間にブロックを置く・囲う・食べるを先に（足場が「押されたら落ちる」なら、空所から離れるのが先）。';

/**
 * A hostile she must act on now: within `meters`, a shooter only while it sees her (the body's `canSee`), any other while it can come
 * (`canReachMe` not false) and does not lack sight. A field the body did not say counts for it.
 */
export function approaching(threat: NearThreat, meters: number): boolean {
  if (threat.distance > meters) return false;
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
