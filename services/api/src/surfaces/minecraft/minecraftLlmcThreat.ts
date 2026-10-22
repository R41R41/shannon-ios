import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActPos } from '../../contracts/minecraftActContract.js';
import { readProbeResult, type ProbeInput } from '../../contracts/minecraftProbeContract.js';
import { finite, plain, posText, readPos } from './minecraftLlmcProbeInput.js';

/**
 * mb-llmc r7 (runs 29–31, 2026-10-22: Sonnet twice and Opus once went for the blazes at 10–13 s from the same start, under the spawner,
 * with the plan's "now" a table and the shortage said; owner 「作って走らせる」): the urgent line said only 「blaze 4.0m」, first in the live
 * state, while the blaze was 2–6 up behind the fortress's bricks, out of reach both ways. Whether a near hostile reaches is now said as
 * the body's `sight` computes it (the same probe the model has, `mc.probe` sight: whether she is seen, the blocks between).
 *
 * - `threatSightProbes`: before the decision, the nearest hostiles within the urgent distance (at most `THREAT_SIGHT.max`) are looked at
 *   with the body's sight. After an act stopped by its `stopIf` (run 31: the health stop at 8.7 left her standing in the corridor the blaze
 *   shot down, burning), the shooters within 16 m too.
 * - `readThreatSight`: the answer as a fact (`visible`, what is between).
 * - `threatLine`: the hostile's line: 「blaze #9 4.0m・上 6・壁の向こうで届かない（間に (310,66,73) nether_bricks ほか 2）」 or
 *   「blaze #9 4.0m・上 2・見える（射線の中）」.
 * - `walledOff`: a hostile that can neither see her nor come (a shooter not in sight; any other not in sight that the body found sealed in):
 *   no urgent step for it, and its line after the plan's now and the shortage (`unreachable`), never before them.
 */
export const THREAT_SIGHT = Object.freeze({
  /** Hostiles looked at in one step. */
  max: 2,
  /** How far shooters are looked at after a stopIf stop (a blaze's fireball, a skeleton's arrow). */
  shooterMeters: 16,
  /** Answers kept per task (the same hostile at the same place from the same feet is not asked again). */
  kept: 8,
});
/** The kinds that hurt her only from where they see her (their shots, a guardian's beam). */
const SHOOTERS = new Set(['blaze', 'ghast', 'skeleton', 'stray', 'bogged', 'pillager', 'witch', 'shulker', 'guardian', 'elder_guardian', 'breeze']);
/** Whether a kind hurts her only from where it sees her. */
export const isShooter = (name: string): boolean => SHOOTERS.has(name);
/** A creeper's blast goes through a wall: it is never walled off. */
const NEVER_WALLED = new Set(['creeper']);

export interface NearThreat { id: number | null; name: string; distance: number; at: ActPos | null; dy: number | null; canReachMe: boolean | null }
/** The hostiles of a frame, nearest first, with their id, place, height against her feet and the body's own `canReachMe`. */
export function nearThreats(observation: BodyObservation | null): NearThreat[] {
  const world = plain(observation?.state.world) ?? {};
  const feet = readPos(world.position), feetY = finite(plain(world.position)?.y);
  return (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).flatMap(item => {
    const entity = plain(item), distance = finite(entity?.distance);
    if (!entity || typeof entity.name !== 'string' || distance === null) return [];
    const at = readPos(entity.position), y = finite(plain(entity.position)?.y);
    return [{ id: typeof entity.id === 'number' && Number.isInteger(entity.id) ? entity.id : null, name: entity.name, distance, at,
      dy: feet && y !== null && feetY !== null ? Math.round(y - feetY) : null,
      canReachMe: typeof entity.canReachMe === 'boolean' ? entity.canReachMe : null }];
  }).sort((left, right) => left.distance - right.distance);
}

/** What the body's sight said of one hostile: whether she is in its sight, the nearest block between and how many more. */
export interface ThreatSight { visible: boolean; between: { at: ActPos; name: string } | null; more: number }
/** A sight answer as a fact, or null when it is no sight answer (a plain text, no `visible`). */
export function readThreatSight(answer: string | null | undefined): ThreatSight | null {
  const read = readProbeResult(answer ?? undefined) as Record<string, unknown> | null;
  if (!read || read.kind !== 'sight' || typeof read.visible !== 'boolean') return null;
  const list = (Array.isArray(read.between) ? read.between : []).flatMap(item => {
    const entry = plain(item), at = readPos(entry?.at);
    return entry && at ? [{ at, name: typeof entry.name === 'string' ? entry.name : '?' }] : [];
  });
  return { visible: read.visible, between: list[0] ?? null, more: Math.max(0, list.length - 1) };
}

/** Whether a hostile can neither see her nor come, by the sight's answer and the body's own `canReachMe`. */
export function walledOff(threat: NearThreat, sight: ThreatSight | null | undefined): boolean {
  if (!sight || sight.visible || NEVER_WALLED.has(threat.name)) return false;
  return SHOOTERS.has(threat.name) || threat.canReachMe === false;
}

/** A hostile's line with the facts of its reach (none known: as r3 wrote it, its name and distance). */
export function threatLine(threat: NearThreat, sight: ThreatSight | null | undefined): string {
  const head = `${threat.name}${threat.id !== null ? ` #${threat.id}` : ''} ${threat.distance.toFixed(1)}m`;
  if (!sight) return `${threat.name} ${threat.distance.toFixed(1)}m`;
  const height = threat.dy !== null && threat.dy !== 0 ? `・${threat.dy > 0 ? '上' : '下'} ${Math.abs(threat.dy)}` : '';
  const between = sight.between ? `間に ${posText(sight.between.at)} ${sight.between.name}${sight.more ? ` ほか ${sight.more}` : ''}` : '';
  if (sight.visible) return `${head}${height}・見える（射線の中）`;
  if (walledOff(threat, sight)) return `${head}${height}・壁の向こうで届かない${between ? `（${between}）` : ''}`;
  return `${head}${height}・見えない${between ? `（${between}）` : ''}・道はある（回って来る）`;
}

/** How far a hostile is looked at: the urgent distance, and after a stopIf stop a shooter within `THREAT_SIGHT.shooterMeters`. */
export function threatSightMeters(threat: NearThreat, urgentMeters: number, afterStop: boolean): number {
  return afterStop && SHOOTERS.has(threat.name) ? Math.max(urgentMeters, THREAT_SIGHT.shooterMeters) : urgentMeters;
}
/** The hostiles a step looks at: within `meters` (by kind), nearest first, at most `THREAT_SIGHT.max`, each with an id. */
export function threatSightTargets(threats: readonly NearThreat[], meters: (threat: NearThreat) => number): NearThreat[] {
  return threats.filter(threat => threat.id !== null && threat.distance <= meters(threat)).slice(0, THREAT_SIGHT.max);
}
export const sightProbe = (threat: NearThreat): ProbeInput => ({ kind: 'sight', target: `#${threat.id}` });

/** A task's sight answers by the hostile, its block and her feet's block (the same three are not asked again). */
const kept = new Map<string, Map<string, ThreatSight>>();
const cellKey = (at: ActPos | null) => at ? `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}` : '?';
export function threatSightKey(threat: NearThreat, feet: ActPos | null): string { return `${threat.id}@${cellKey(threat.at)}<${cellKey(feet)}`; }
export function keptThreatSight(taskId: string, key: string): ThreatSight | undefined { return kept.get(taskId)?.get(key); }
export function keepThreatSight(taskId: string, key: string, sight: ThreatSight): void {
  let task = kept.get(taskId);
  if (!task) {
    task = new Map();
    kept.set(taskId, task);
    if (kept.size > 32) kept.delete(kept.keys().next().value as string);
  }
  task.delete(key);
  task.set(key, sight);
  if (task.size > THREAT_SIGHT.kept) task.delete(task.keys().next().value as string);
}
/** For tests: no task keeps an answer. */
export function forgetThreatSights(): void { kept.clear(); }

/**
 * The line said first after an act its `stopIf` stopped, when a hostile sees her where she stopped (run 31): 「今いる所は blaze #9 から
 * 見える（射線の中・6.2m・上 3）」; null when none does (or none was looked at).
 */
export function inSightLine(threats: readonly NearThreat[], sights: ReadonlyMap<number, ThreatSight>): string | null {
  const seen = threats.filter(threat => threat.id !== null && sights.get(threat.id)?.visible === true);
  if (!seen.length) return null;
  const words = seen.slice(0, 2).map(threat => `${threat.name} #${threat.id}`).join('・');
  const first = seen[0]!;
  const height = first.dy !== null && first.dy !== 0 ? `・${first.dy > 0 ? '上' : '下'} ${Math.abs(first.dy)}` : '';
  return `今いる所は ${words} から見える（射線の中・${first.distance.toFixed(1)}m${height}）`;
}
