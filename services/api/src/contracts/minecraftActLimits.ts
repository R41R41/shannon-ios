/**
 * The most (and least) `seconds` and `range` of each hand, in one place. `minecraftActHandRules.ts` checks a hand against these numbers, and the words the model
 * reads about them (the schema's field text, the short manual's one line, the stage knowledge) are written from the same numbers, so the words cannot say
 * a limit the check does not hold. Nothing here rounds a hand: an act with a hand out of range is turned back whole, and the model is told the range.
 *
 * 11/26 (end run 5, Haiku): `attack seconds=40` was turned back (the top is 30), the whole act with it, and nothing moved; the short manual that the
 * model reads said no limit for attack or fight at all.
 */
export const WAIT_SECONDS: readonly [number, number] = [0.5, 30];
/** attack: no least here (the schema's 0.5 stands), the top is 30. */
export const ATTACK_SECONDS_MAX = 30;
/** fight: 5 to the top of its kind: an id (and any kind but enderman) 60, the kind enderman (a name, `minecraft:` allowed, any case) 150 for pearl hunting. */
export const FIGHT_SECONDS_MIN = 5, FIGHT_SECONDS_MAX = 60, ENDERMAN_FIGHT_SECONDS_MAX = 150;
export const FIGHT_RANGE_MAX = 16;
export const GO_SECONDS: readonly [number, number] = [5, 120];
export const GO_RANGE: readonly [number, number] = [0, 4];
export const MINE_SECONDS: readonly [number, number] = [5, 120];
export const PORTAL_SECONDS: readonly [number, number] = [5, 120];
export const HUNT_SECONDS: readonly [number, number] = [5, 120];
export const HUNT_RANGE: readonly [number, number] = [4, 48];
export const TIDY_SECONDS: readonly [number, number] = [5, 120];
export const SMELT_SECONDS: readonly [number, number] = [5, 60];
export const SLEEP_SECONDS: readonly [number, number] = [10, 60];
export const OBSIDIAN_SECONDS: readonly [number, number] = [5, 300];

const span = ([least, most]: readonly [number, number]): string => `${least}〜${most}`;
/** The `seconds` limits of every hand, as one sentence. */
export const SECONDS_LIMITS_TEXT = `wait ${span(WAIT_SECONDS)}・attack ${ATTACK_SECONDS_MAX} まで・fight ${FIGHT_SECONDS_MIN}〜（相手が #id か enderman 以外の名前なら ${FIGHT_SECONDS_MAX}、`
  + `名前 enderman なら ${ENDERMAN_FIGHT_SECONDS_MAX}）・go/mine/portal/hunt/tidy ${span(GO_SECONDS)}・smelt ${span(SMELT_SECONDS)}・sleep ${span(SLEEP_SECONDS)}・obsidian ${span(OBSIDIAN_SECONDS)}`;
/** The `range` limits of every hand, as one sentence. */
export const RANGE_LIMITS_TEXT = `go ${span(GO_RANGE)}・fight 0〜${FIGHT_RANGE_MAX}・hunt ${span(HUNT_RANGE)}・vertical 1 か 2・walk と pickup は m`;
/** What happens to a hand out of range (said once, after the limits). */
export const OUT_OF_RANGE_TEXT = '範囲外の手は動かさずに断られる（その act は全部動かない）';
/** The one line of the short manual: the limits, the reason and what a turned-back act is. */
export const LIMITS_MANUAL_LINE = `- 手の秒と範囲の上限（超えると、その手だけでなく act の手が全部動かずに断られる）: seconds は ${SECONDS_LIMITS_TEXT}。range は ${RANGE_LIMITS_TEXT}。`
  + '理由: 手ごとの上限は、体がその手に使う時間と距離の天井で、書いた数をそのまま使う（丸めない）。長く続けたい時は、上限以内で出し直す。';
