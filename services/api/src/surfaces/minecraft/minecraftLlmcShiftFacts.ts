import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { isNightTick } from './minecraftMoments.js';
import { offer, type OnceFact } from './minecraftLlmcOnceFacts.js';

/**
 * Two changes the model did not see coming, said once as facts (nothing is held or forced; what to do with them is the decision's):
 *
 * - The clock jumped (11/25: a night was skipped by a bed, then a person set the time to night; the plan made 70 s after it dug down into a cave as if it were day, and the
 *   skipped night was never mentioned). The game's clock runs 20 ticks a second; a reading that moved more than 1,500 ticks beyond that, from one frame to the next, is a jump.
 * - A respawn (11/25: 2 s after dying with an empty pack, in the dark with two zombies and a spider within 5 m, a go to the place of the death 77 m away was sent, and she died
 *   again 30 s after the respawn). The input said the death's place and the empty pack in separate lines; one line puts together what a respawn is: nothing in the pack, what stands
 *   around, the hour, and how far the drops are.
 */
const JUMP_TICKS = 1_500;
const clock = new Map<string, { tick: number; at: number }>();
/** The last jump of a task's clock and when it was seen: the plan's input says it for `JUMP_REMEMBERED_MS` (a once-said fact reaches the decisions only). */
const jumps = new Map<string, { text: string; seen: number }>();
export const JUMP_REMEMBERED_MS = 5 * 60_000;
const CLOCK_TASKS = 32;

/** For tests: no task has a clock reading. */
export function forgetShiftFacts(): void { clock.clear(); jumps.clear(); }

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const phase = (tick: number): string => (isNightTick(tick % 24_000) ? '夜' : (tick % 24_000) >= 23_000 ? '朝' : (tick % 24_000) >= 12_000 ? '夕方' : '昼');

/** The clock fact of this frame, or null: the first reading of a task, a dimension without a day, and an ordinary pace say nothing. */
export function timeJumpFact(taskId: string, observation: BodyObservation | null): OnceFact | null {
  const world = record(observation?.state.world);
  const tick = finite(world?.timeOfDay), at = Date.parse(observation?.stateAt ?? '');
  const dimension = typeof world?.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : null;
  if (!world || tick === null || !Number.isFinite(at) || (dimension !== null && dimension !== 'overworld')) return null;
  const before = clock.get(taskId);
  clock.delete(taskId);
  clock.set(taskId, { tick, at });
  if (clock.size > CLOCK_TASKS) clock.delete(clock.keys().next().value as string);
  if (!before || at <= before.at) return null;
  const off = ((((tick - before.tick) - 20 * (at - before.at) / 1000) % 24_000) + 24_000) % 24_000;
  if (off < JUMP_TICKS || off > 24_000 - JUMP_TICKS) return null;
  const forward = off <= 12_000;
  const key = `time_jump:${tick}:${Math.round(at / 1000)}`;
  const fact = { key, text: `時刻が急に変わった（${phase(before.tick)}→${phase(tick)}。約 ${Math.round((forward ? off : 24_000 - off) / 1_200)} 分ぶん${forward ? '進んだ' : '戻った'}）。`
    + '時の流れでは起きない: 寝て夜が飛んだか、誰かが時刻を変えた。入力の時刻は今のものが正しい。昼か夜かで決めていた計画（夜の地上で敵を狙う・昼のうちに洞窟を探す・夜は寝る）は、今の時刻に合うか読み直す。'
    + '夜が飛んだのなら、次に持ち主へ話す時（途中の報告・完了）に一言入れる（持ち主は夜を待っていたかもしれない）' };
  jumps.delete(taskId);
  jumps.set(taskId, { text: fact.text, seen: Date.now() });
  if (jumps.size > CLOCK_TASKS) jumps.delete(jumps.keys().next().value as string);
  return fact;
}

/** The clock jump of the last few minutes as one line for the plan's input, or null. */
export function recentJumpLine(taskId: string, nowMs: number = Date.now()): string | null {
  const jump = jumps.get(taskId);
  return jump && nowMs - jump.seen <= JUMP_REMEMBERED_MS ? jump.text : null;
}

/** A death `ageSeconds` old and its place, from the frame's `lastDeath` (「12 秒前 …「zombie」(x,y,z)」); null when it says none. */
function lastDeath(world: Record<string, unknown>): { seconds: number; at: { x: number; y: number; z: number } } | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  const ago = /^(\d+)\s*(分|秒)前/u.exec(said), at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(said);
  if (!ago || !at) return null;
  return { seconds: ago[2] === '分' ? Number(ago[1]) * 60 : Number(ago[1]), at: { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) } };
}

/** Said while the death is this fresh. */
export const RESPAWN_FRESH_SECONDS = 90;

/** The respawn fact of this frame, or null when she did not die within the last `RESPAWN_FRESH_SECONDS`. */
export function respawnFact(observation: BodyObservation | null): OnceFact | null {
  const world = record(observation?.state.world);
  const death = world ? lastDeath(world) : null;
  if (!world || !death || death.seconds > RESPAWN_FRESH_SECONDS) return null;
  const position = record(world.position), x = finite(position?.x), y = finite(position?.y), z = finite(position?.z);
  const away = x !== null && y !== null && z !== null ? Math.round(Math.hypot(death.at.x - x, death.at.z - z)) : null;
  const threats = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).map(record).filter((entity): entity is Record<string, unknown> => !!entity)
    .filter(entity => (finite(entity.distance) ?? 99) <= 8);
  const kinds = new Map<string, number>();
  for (const entity of threats) { const name = typeof entity.name === 'string' ? entity.name : '敵'; kinds.set(name, (kinds.get(name) ?? 0) + 1); }
  const tick = finite(world.timeOfDay);
  const hour = tick === null ? '' : `・今は${phase(tick)}`;
  const around = kinds.size ? `8 m 内に ${[...kinds].map(([name, count]) => `${name} ${count}`).join('・')}` : '8 m 内に敵は見えない';
  return { key: `respawn:${death.at.x},${death.at.y},${death.at.z}`,
    text: `生き返った直後（死んで ${death.seconds} 秒）: 持ち物は死亡で落ちた（落とし物は 5 分で消える。死亡地点 (${death.at.x},${death.at.y},${death.at.z})${away === null ? '' : `は今の足元から水平 ${away} m`}）・${around}${hour}。`
      + '武器も防具も食べ物も無い今、死亡地点へ遠く go すると、着くまでの道で同じ敵に会う。生き返った所の敵と明るさを見て、身を守る手（離れる・隠れる・水へ入る）を先に決め、落とし物の回収はその後に届くか見て決める' };
}

/** The facts of the frame, offered once each to the task. */
export function shiftFacts(taskId: string, observation: BodyObservation | null): void {
  for (const fact of [timeJumpFact(taskId, observation), respawnFact(observation)]) if (fact) offer(taskId, fact.key, fact.text);
}
