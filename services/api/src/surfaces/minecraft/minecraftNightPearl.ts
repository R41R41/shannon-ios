import { carried } from './minecraftConditions.js';
import { countMatching } from './minecraftItems.js';
import { ARROWS, BLOCKS, END_OBSIDIAN } from './minecraftLlmcPrepRules.js';
import { armedForNight, dayTick, minutes, NIGHT_FROM, PEARL_NIGHT_MIN_HEALTH, pearlGap, thunderstorm } from './minecraftNightArms.js';
import { framesOf } from './minecraftSeenMarks.js';
import { eyeBasisOf } from './minecraftEyeSpare.js';

/**
 * The night of the pearls (run of 11/27, 10:50 to 10:56): the plan's pearl node was renamed and kept the kind `stronghold`, so the night's "not asleep" fact never came;
 * eight sleeps were booked for a night the pearl was to be hunted in, and then the head waited with `wait 30` nine times for the dusk while the scaffold, the obsidian and
 * the arrows were short. This module says, as facts: that the pearls are still short (so the plan's now is the pearls whatever the node's kind), what the day has shown of
 * endermen, what can be moved while the dusk comes, and the animals last seen. It names no hand, adds no wait and forbids no sleep; the head chooses.
 */

/** Health under which the gap alone does not make the plan's now the pearls (a night spent on the surface at that health is not the kind of night the fact is for): the plan's own pearl node still does. */
export { PEARL_NIGHT_MIN_HEALTH };

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Whether the pearls are the plan's now: the node is a pearl node (`kindPearl`), or the pearls and eyes are fewer than the eyes to hold (`pearlGap`: the empty frames when they are known, else
 * 12 plus the spare), the run is the dragon's, she is in the overworld, the End's check is what is being prepared (`endStage`, from `preparationStage`) and her health is not low. A request of
 * one thing (a house, a cake) has no pearls to hunt: the caller passes `journey` false. Before the frames are in view (not found yet, or only remembered) the night on the surface is also
 * asked of her only with the iron sword and the shield in the pack (`armedForNight`); the portal room's scene, with the frames in view, is as it was.
 */
export function pearlNowOf(input: { kindPearl: boolean; world: Record<string, unknown>; counts: ReadonlyMap<string, number>; dimension: string | null; endStage: boolean; journey: boolean }): boolean {
  if (input.kindPearl) return true;
  if (!input.journey || !input.endStage || input.dimension !== 'overworld') return false;
  const health = finite(input.world.health);
  if (health !== null && health < PEARL_NIGHT_MIN_HEALTH) return false;
  if (!framesOf(input.world) && !armedForNight(input.world, input.counts)) return false;
  return pearlGap(input.world, input.counts) > 0;
}

// ---- what she has seen on the surface, per task

interface Animal { name: string; x: number; y: number; z: number; at: number }
interface Watch { lastAt: number | null; dayMs: number; dayEnderIds: Set<string>; animals: Map<string, Animal> }
const watches = new Map<string, Watch>();
const WATCH_KEPT = 8;
/** One observation gap is counted up to this long (the head is asked every few seconds; a pause longer than this is not watched time). */
const GAP_CAP_MS = 30_000;
/** The animals the hunts go for. */
const ANIMALS: readonly string[] = ['sheep', 'pig', 'cow', 'chicken'];
const ANIMAL_JA: Readonly<Record<string, string>> = { sheep: '羊', pig: '豚', cow: '牛', chicken: '鶏' };
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value : []).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');

/** Notes what this frame shows: the watched daytime, the endermen seen by day, the animals and where. Call once per decision; a call with no `taskId` or no entity list notes nothing. */
export function notePearlWatch(taskId: string | undefined, world: Record<string, unknown>, dimension: string | null, nowMs: number = Date.now()): void {
  if (!taskId || !Array.isArray(world.nearbyEntities)) return;
  let watch = watches.get(taskId);
  if (!watch) {
    watch = { lastAt: null, dayMs: 0, dayEnderIds: new Set(), animals: new Map() };
    watches.set(taskId, watch);
    if (watches.size > WATCH_KEPT) watches.delete(watches.keys().next().value as string);
  }
  const tick = dayTick(world);
  const day = dimension === 'overworld' && tick !== null && tick < NIGHT_FROM && !thunderstorm(world);
  if (watch.lastAt !== null && day) watch.dayMs += Math.min(GAP_CAP_MS, Math.max(0, nowMs - watch.lastAt));
  watch.lastAt = nowMs;
  if (dimension !== 'overworld') return;
  for (const entity of [...records(world.nearbyEntities), ...records(world.nearbyThreats)]) {
    const name = typeof entity.name === 'string' ? entity.name.replace(/^minecraft:/u, '') : '';
    const at = entity.position && typeof entity.position === 'object' ? entity.position as Record<string, unknown> : null;
    if (name === 'enderman' && day) watch.dayEnderIds.add(entity.id !== undefined ? String(entity.id) : `${Math.floor(finite(at?.x) ?? 0)},${Math.floor(finite(at?.z) ?? 0)}`);
    const x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
    if (ANIMALS.includes(name) && x !== null && y !== null && z !== null) watch.animals.set(name, { name, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), at: nowMs });
  }
}

/** For tests. */
export function forgetPearlWatch(): void { watches.clear(); }

const MIN_WATCH_MS = 3 * 60_000;
/** An animal seen farther than this from where she stands, or longer ago than this, is not a place to look for one now. */
const ANIMAL_NEAR_M = 200, ANIMAL_FRESH_MS = 20 * 60_000, ANIMALS_SHOWN = 3;
/** What the day has shown of endermen: how many were seen, over how long the daytime was watched. Null until 3 minutes of day were watched. */
export function enderSeenWords(taskId: string | undefined): string | null {
  const watch = taskId ? watches.get(taskId) : undefined;
  if (!watch || watch.dayMs < MIN_WATCH_MS) return null;
  // Bench of 11/27 (Haiku): said bare, 「昼に 0 体」 was read as 「there are none, so sleep」; it is a fact about the day, and the game's rule it fits (they come out at night) goes with it.
  return `この実走で昼に見えたエンダーマン: ${watch.dayEnderIds.size} 体（昼の観測 ${minutes(watch.dayMs / 50)}。見える範囲だけの数。地上のエンダーマンは夜に出るので、昼に見えないのは普通）`;
}

/**
 * The day's pearl fact, beside the bed's day line: how many pearls are missing, where they mainly come from (endermen, which spawn on the surface at night; a sleep skips the
 * night), what the day has shown. No odds and no drop counts (the owner's line: facts and means, not the game's random tables). Null: not the overworld, the night begun, or
 * the pearls are not short or not the plan's now.
 */
export function pearlDayLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, pearlNow: boolean, seen: string | null): string | null {
  if (!pearlNow || dimension !== 'overworld' || thunderstorm(world)) return null;
  const tick = dayTick(world);
  if (tick === null || tick >= NIGHT_FROM) return null;
  const gap = pearlGap(world, counts);
  if (gap <= 0) return null;
  // Before the frames are found the gap is to the 10 that go to the stronghold; the eyes to hold on the way there are the spare's number (`eyeBasisOf`), taken when a pearl comes.
  const basis = eyeBasisOf(world);
  const search = basis.kind === 'search';
  const spare = search ? `。要塞へ向かえるのは 10 個から。道中で投げて割れる分の予備を足した ${basis.need} 個まで、手に入る時に取る` : '';
  // Before the frames are found the day is for the walk: the pearls are not waited for (the night's endermen come on the way, and the eyes are wanted at the frames, not at the start).
  const tail = !search ? '' : armedForNight(world, counts)
    ? '。昼は夜を待たず進む。エンダーマンが見えたら、または夜が来ていたら寝ずに狩る（寝ると夜ごと飛んで入手先が消える）。ただし体力・防具が整わない時、エンダーマンが見えない時は、探して歩き回って夜を過ごすより寝て飛ばしてよい'
    : '。昼は夜を待たず進む。体力・防具・盾が整わない夜は、無理に地上に立たず寝て飛ばしてよい';
  return `パールはあと ${gap} 個足りない（パール ${carried(counts, 'ender_pearl')}・アイ ${carried(counts, 'ender_eye')}）${spare}。パールの主な入手先は、エンダーマンが湧く夜の地上。寝れば夜が飛ぶ。${seen ?? ''}`.replace(/。$/u, '') + tail;
}

/** The dusk window in which the lines of what can be moved are said: within this many ticks of the night. */
const DUSK_WINDOW_TICKS = 12_000;
/**
 * While the pearls are the plan's now and the night is near: the shortages that can be moved without waiting, from the raw counts (the scaffold, the obsidian, the arrows) with the
 * materials in the pack. Said as facts of what stands; the three are checks of the End that are fine behind the stronghold and on the way (the owner's decision), so the line says
 * that, and does not say they are to be done instead of the wait. It gives no estimate of time.
 */
export function nightMeanwhileLine(world: Record<string, unknown>, counts: ReadonlyMap<string, number>, dimension: string | null, pearlNow: boolean): string | null {
  if (!pearlNow || dimension !== 'overworld' || thunderstorm(world)) return null;
  // Before the frames are found the day is for the walk, not for a wait for the night: no line that counts the wait (the pearl day line says what to do with a night that comes).
  if (eyeBasisOf(world).kind === 'search') return null;
  const tick = dayTick(world);
  if (tick === null || tick >= NIGHT_FROM || NIGHT_FROM - tick > DUSK_WINDOW_TICKS) return null;
  const parts: string[] = [];
  const blocks = countMatching(counts, BLOCKS);
  const blocksNeed = 64;
  if (blocks < blocksNeed) parts.push(`足場のブロック あと ${blocksNeed - blocks}（今 ${blocks}/${blocksNeed}。丸石・土・石など何でも数える）`);
  const obsidian = carried(counts, 'obsidian');
  if (obsidian < END_OBSIDIAN) parts.push(`黒曜石 あと ${END_OBSIDIAN - obsidian}（今 ${obsidian}/${END_OBSIDIAN}。ダイヤのつるはし ${carried(counts, 'diamond_pickaxe') + carried(counts, 'netherite_pickaxe') > 0 ? 'あり' : '無し'}）`);
  const arrows = countMatching(counts, ARROWS.pattern);
  if (arrows < ARROWS.count) parts.push(`矢 あと ${ARROWS.count - arrows}（今 ${arrows}/${ARROWS.count}。材料 羽根 ${carried(counts, 'feather')}・火打石 ${carried(counts, 'flint')}・棒 ${carried(counts, 'stick')}）`);
  if (!parts.length) return null;
  // The bench of 11/27 (Haiku, 6 each): said as 「点検物で…遠くへ往復して取る物ではない」 alone the line was read as 「not needed」 and 18 of 18 inputs waited or booked a sleep; the pearls
  // is held by the night, which is the reason a hand outside the node is not off the plan, and that is said first. The owner's decision (checks behind the stronghold are enough) stays in the line.
  return `夜まで ${minutes(NIGHT_FROM - tick)}。パールはエンダーマンが湧く夜まで入らず、待つだけでは なにも進まない。この待ちの間に進められる不足（材料の手持ちを添える）: ${parts.join('・')}。`
    + '節の外の手でも計画から外れない（待ち時間に進められる分）。点検物なので要塞の後ろ・道中で取れる分でよく、遠くへ往復する物ではない';
}

/**
 * The animals' line: none of the animals the hunts go for is in view now, and one was seen before. Where each was last seen, how long ago and how far from here. Null while any is in
 * view (the near lines carry them) or none has been seen. The hunt that came back `no_target` three times at one place did not know this: the head turned to the same hand seven times.
 */
export function animalsLine(taskId: string | undefined, world: Record<string, unknown>, nowMs: number = Date.now()): string | null {
  const watch = taskId ? watches.get(taskId) : undefined;
  if (!watch || !Array.isArray(world.nearbyEntities)) return null;
  const inView = records(world.nearbyEntities).some(entity => typeof entity.name === 'string' && ANIMALS.includes(entity.name.replace(/^minecraft:/u, '')));
  if (inView || !watch.animals.size) return null;
  const at = world.position && typeof world.position === 'object' ? world.position as Record<string, unknown> : null;
  const px = finite(at?.x), pz = finite(at?.z);
  const fresh = [...watch.animals.values()].filter(animal => nowMs - animal.at <= ANIMAL_FRESH_MS && (px === null || pz === null || Math.hypot(animal.x - px, animal.z - pz) <= ANIMAL_NEAR_M));
  if (!fresh.length) return null;
  const seen = fresh.sort((a, b) => b.at - a.at).slice(0, ANIMALS_SHOWN).map(animal => {
    const far = px !== null && pz !== null ? `・ここから ${Math.round(Math.hypot(animal.x - px, animal.z - pz))} m` : '';
    return `${ANIMAL_JA[animal.name] ?? animal.name} (${animal.x},${animal.y},${animal.z}) ${minutes((nowMs - animal.at) / 50)}前${far}`;
  });
  return `羊・豚・牛・鶏は今は見えない。最後に見た所: ${seen.join('／')}`;
}
