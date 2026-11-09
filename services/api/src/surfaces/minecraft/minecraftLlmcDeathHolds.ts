import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { feetOf, lowestReach, readinessOf } from './minecraftLlmcReadiness.js';

/**
 * Two ways run62 (11/5) lost its last hour after the deaths, held before they are sent:
 * - a death on purpose (03:47–03:53, 20 decisions and more: 「持ち物なし。溶岩／マグマ／落下で倒れて地上で再開」): an act whose `why` says it goes
 *   to die (to fall, burn or be killed to respawn) is held whole; a death ends this run, and the way back is walked;
 * - the same danger at once (03:22–03:27, five deaths to wither skeletons in the fortress, each straight back from the respawn): within
 *   `RETURN_MINUTES` of a mob's death and until a chestplate is worn and an iron sword carried, a go or a walk that ends within `RETURN_BLOCKS`
 *   of the place of the death, a fight, an attack or a shot on the kind the death names (「Wither Skeleton」 is `wither_skeleton`, an `#id` is
 *   read from the live lines), and an act that accepts it, are held, `RETURN_HOLDS` times a death at most (the drops last 5 minutes).
 * Facts with the hand held; they move no node.
 */
export const RETURN_MINUTES = 5;
export const RETURN_BLOCKS = 32;
export const RETURN_HOLDS = 2;
/** Words that go to die whatever is carried. */
const SUICIDE = /わざと(?:死|倒れ)|自殺|(?:倒れて|死んで|落ちて|燃えて)(?:地上|ベッド|最初の場所|リスポーン|再開|戻)|リスポーン(?:する|で戻|して戻)/u;
/**
 * The run62 whys of 03:47–03:53 (S0's reading of the trail), said with nothing in the pack: a hazard and the restart (「下の溶岩へ降り地上で再開」,
 * 「縁から落ちて地上で再開」, 「溶岩で戻る」), into the lava (「溶岩へ落ちる」, 「溶岩の上へ」), or waiting for an enemy (「動けない。敵が来るのを待つ」).
 * Read only while the pack holds no pickaxe, sword or axe, so that a careful line of ordinary work is not taken for one.
 */
const BARE_SUICIDE = /(?:溶岩|マグマ|落下|落ち|縁|崖|下へ)[^。]*?(?:再開|地上)|(?:溶岩|マグマ)(?:へ落ち|の(?:上|縁)へ|で戻|へ向|へ掘り)|マグマ床へ|敵(?:を|が来るのを)待つ/u;
const TOOL = /_(?:pickaxe|sword|axe)$/u;
const IRON_BLADE = /^(?:iron|diamond|netherite)_sword$/u;
const held = new Map<string, number>();

/** For tests: no death has been held. */
export function forgetDeathHolds(): void { held.clear(); }

const objectOf = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' ? value as Record<string, unknown> : null;

/** The act whose why says it goes to die (the broad words only with no tool in the pack): the whole act, or null. */
export function suicideHold(input: unknown, frame: BodyObservation | null = null): { hand: number; kind: string; line: string } | null {
  const act = objectOf(input), why = typeof act?.why === 'string' ? act.why : '';
  const hands = Array.isArray(act?.hands) ? act.hands : [];
  const counts = readinessOf(frame)?.counts;
  const bare = !!counts && ![...counts].some(([name, count]) => count > 0 && TOOL.test(name));
  if (!hands.length || !(SUICIDE.test(why) || (bare && BARE_SUICIDE.test(why)))) return null;
  return { hand: 1, kind: String(objectOf(hands[0])?.do ?? 'act'),
    line: 'わざと死ぬ手は送らない（死ぬとこの通しはアウトで、持ち物も消える）。持ち物が無くても、帰りのゲートか安全な所へ歩いて戻り、木・石から作り直す' };
}

/** The last death the body says: minutes ago, the place and the cause, or null. */
function lastDeathOf(world: Record<string, unknown>): { minutes: number; at: { x: number; y: number; z: number }; cause: string } | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath : '';
  const ago = /^(\d+)\s*(分|秒)前/u.exec(said), at = /\((-?\d+),(-?\d+),(-?\d+)\)/u.exec(said);
  if (!ago || !at) return null;
  const minutes = ago[2] === '秒' ? 0 : Number(ago[1]);
  return { minutes, at: { x: Number(at[1]), y: Number(at[2]), z: Number(at[3]) }, cause: /「([^」]+)」/u.exec(said)?.[1] ?? said };
}

/** A name as the death's words and a hand's target both say it: 「Wither Skeleton」 and `wither_skeleton` are one. */
const norm = (name: string): string => name.toLowerCase().replace(/^minecraft:/u, '').replace(/[\s_]+/gu, '');
/** A mob's death (not lava, magma, fire, a fall or the void): only such a death has a killer to go back to. */
const MOB_DEATH = /^(?!.*(?:lava|magma|hot_floor|fire|burn|fall|void|drown|溶岩|マグマ|落下|燃え|火|溺れ|虚空)).+/iu;

/** The kind a fight or an attack names: its target, or the live line of its `#id`. */
function targetKind(hand: Record<string, unknown>, world: Record<string, unknown>): string {
  const target = typeof hand.target === 'string' ? hand.target : '';
  const id = /^#(\d+)$/u.exec(target)?.[1];
  if (!id) return target;
  const lines = [world.threats, world.urgent].flatMap(list => Array.isArray(list) ? list : []).filter((line): line is string => typeof line === 'string');
  const listed = lines.map(line => new RegExp(`^#${id} (\\S+)`, 'u').exec(line)?.[1]).find(Boolean);
  const threat = (Array.isArray(world.nearbyThreats) ? world.nearbyThreats : []).map(objectOf).find(item => String(item?.id) === id);
  return listed ?? (typeof threat?.name === 'string' ? threat.name : '');
}

type Death = NonNullable<ReturnType<typeof lastDeathOf>>;
/** Whether a hand goes back to a fresh death: a fight or an attack on its killer, or a go or a walk ending within `RETURN_BLOCKS` of it. */
function goesBack(hand: Record<string, unknown>, death: Death, world: Record<string, unknown>, feetY: number): boolean {
  if (hand.do === 'fight' || hand.do === 'attack' || hand.do === 'shoot') {
    const kind = norm(targetKind(hand, world));
    return kind.length > 0 && norm(death.cause).includes(kind);
  }
  if (hand.do !== 'go' && hand.do !== 'walk') return false;
  const to = objectOf(hand.to);
  if (!to || typeof to.x !== 'number' || typeof to.z !== 'number') return false;
  const y = typeof to.y === 'number' ? to.y : lowestReach([hand], feetY);
  return Math.hypot(to.x - death.at.x, y - death.at.y, to.z - death.at.z) <= RETURN_BLOCKS;
}

/** The first hand (0-based) going back to a fresh mob death, or -1; an act whose accept names the killer is held at its first hand. */
function returningHand(input: Record<string, unknown>, hands: readonly unknown[], death: Death, world: Record<string, unknown>, feetY: number): number {
  const accept = Array.isArray(input.accept) ? input.accept.filter((name): name is string => typeof name === 'string') : [];
  if (accept.some(name => norm(death.cause).includes(norm(name)))) return 0;
  return hands.findIndex(raw => goesBack(objectOf(raw) ?? {}, death, world, feetY));
}

/** Armed again: a chestplate worn and an iron sword or better carried (the review of run62: the sword alone let her back without armour). */
function armedAgain(world: Record<string, unknown>, counts: ReadonlyMap<string, number>): boolean {
  const worn = typeof world.worn === 'string' ? world.worn : '';
  return /(?:iron|diamond|netherite)_chestplate/u.test(worn) && [...counts].some(([name, count]) => count > 0 && IRON_BLADE.test(name));
}

/** The last death when it is a mob's, younger than `RETURN_MINUTES`, and she is not armed again; else null. */
function freshMobDeath(world: Record<string, unknown>, counts: ReadonlyMap<string, number>): Death | null {
  const death = lastDeathOf(world);
  return death && death.minutes < RETURN_MINUTES && MOB_DEATH.test(death.cause) && !armedAgain(world, counts) ? death : null;
}

/**
 * The hold of a return to a fresh mob death's place or killer while not armed again, or null; `commit` counts it when it stops the act. A death
 * is told by the count of deaths the body keeps and the 32 m around it (run62: the same place twice, so a key of the place alone ran out).
 */
export function deathReturnHold(input: unknown, frame: BodyObservation | null, taskId: string):
  { hand: number; kind: string; line: string; commit(): void } | null {
  const act = objectOf(input) ?? {}, hands = act.hands;
  const facts = readinessOf(frame), feet = facts ? feetOf(facts.world) : null;
  const death = facts ? freshMobDeath(facts.world, facts.counts) : null;
  if (!Array.isArray(hands) || !facts || !feet || !death) return null;
  const epoch = Array.isArray(facts.world.deaths) ? facts.world.deaths.length : 0;
  const key = `${taskId}:${epoch}:${Math.round(death.at.x / 32)},${Math.round(death.at.z / 32)}`, count = held.get(key) ?? 0;
  if (count >= RETURN_HOLDS) return null;
  const at = returningHand(act, hands, death, facts.world, feet.y);
  if (at < 0) return null;
  const line = `最後の死から ${death.minutes} 分（${death.cause.slice(0, 40)}）。胸当てと鉄の剣がそろうまで、死んだ所（${RETURN_BLOCKS}m 内）や同じ相手へ戻る手は送らない`
    + `（run62: 裸で同じ通路へ 4 回戻り、同じ相手に 5 回死んだ）。先に安全な所で剣・盾・防具を作り直す（${count + 1}/${RETURN_HOLDS} 回目）`;
  return { hand: at + 1, kind: String(objectOf(hands[at])?.do ?? 'go'), line, commit: () => { held.set(key, count + 1); } };
}
