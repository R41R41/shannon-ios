import type { EndCloud, EndCrystal, EndDragon, EndView, Point } from './minecraftEndView.js';
import { framesOf } from './minecraftSeenMarks.js';

/**
 * The facts of the way to the dragon, as lines for the live state (a pure reading of the body's frame; nothing is kept here).
 * The End fight comes from `minecraftEndView.ts` (the body's `dragon`, `crystals`, `perch` ... in `state.world`, else the map marks);
 * her last death, the frames of the portal
 * room and the places the body remembers come from its world fields (`world.lastDeath`, `world.deaths`, `world.rememberedPlaces`,
 * `world.mapLandmarks`). This only puts them in words the decision can use. A field the body does not send is left out of the lines:
 * an absent field is never an absent fact.
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const round = (value: number): number => Math.round(value);
const tenth = (value: number): string => String(Math.round(value * 10) / 10);
const place = (point: Point | null): string | null => point ? `(${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)})` : null;
const metres = (value: number | null): string => value === null ? '' : `${round(value)}m`;

/** The dragon's phases by the game's numbers (the body sends the number and the phase's name). */
const PHASE_WORDS: readonly string[] = ['島の上を周回', '狙いを定めて火の玉', '止まり木へ降りる途中', '止まり木に着陸中', '飛び立つところ', '止まり木で息を吐いている',
  '止まり木で見回している', '止まり木で吠えている（息の前）', '体当たり', '倒れかけている', 'その場で浮いている'];
/** The phases in which the dragon sits on the perch: its head can be struck, and arrows do nothing. */
const SITTING = new Set([5, 6, 7]);
/** The reach a blow is swung at, from the eye to the head's box (the body's own bound: `dragon.strike`). */
export const STRIKE_REACH_METRES = 5;

function stateWords(dragon: EndDragon): string {
  const phase = dragon.phase;
  if (phase === null) return '';
  const sitting = SITTING.has(phase);
  const seconds = sitting && dragon.phaseFor !== null ? `・この phase ${tenth(dragon.phaseFor)} 秒目` : '';
  return `${PHASE_WORDS[phase]}（phase ${phase}${seconds}${sitting ? '。矢は効かない' : ''}）`;
}

function reachWords(dragon: EndDragon): string {
  if (dragon.headReach === null || dragon.phase === null || !SITTING.has(dragon.phase)) return '';
  const reach = dragon.strike === true ? '剣が届く' : `剣は ${STRIKE_REACH_METRES}m 以内で届く`;
  return `頭の箱まで ${tenth(dragon.headReach)}m（${reach}）`;
}

/** 「竜: 体力 142/200・止まり木で見回している（phase 6・この phase 2.4 秒目。矢は効かない）・頭 (3,67,6)・頭の箱まで 4.2m（剣が届く）・#77」, or null with no dragon in view. */
export function dragonLine(end: EndView | null): string | null {
  const dragon = end?.dragon;
  if (!dragon) return null;
  const far = dragon.distance === null ? '' : ` 自分から ${metres(dragon.distance)}`;
  const where = place(dragon.head) ? `頭 ${place(dragon.head)}` : place(dragon.at) ? `位置 ${place(dragon.at)}${far}` : '';
  const parts = [dragon.health === null ? '' : `体力 ${tenth(dragon.health)}/200`, stateWords(dragon), where, reachWords(dragon),
    dragon.id === null ? '' : `#${dragon.id}`].filter(Boolean);
  return parts.length ? `竜: ${parts.join('・')}` : null;
}

function crystalWords(crystal: EndCrystal): string {
  const blast = crystal.blast === null ? '' : `壊すと爆発（今の立ち位置で体力 −${round(crystal.blast)} の見込み）`;
  const tags = [crystal.caged === true ? '檻つき' : '', crystal.healing ? '竜を回復中' : '', blast].filter(Boolean);
  return `${crystal.id === null ? '' : `#${crystal.id} `}${place(crystal.at)} ${metres(crystal.dist)}${tags.length ? ` ${tags.join('・')}` : ''}`.trim();
}

/** 「エンドクリスタル: 残り 4/10（壊れた 6・檻つき 1）。近い順: #12 (x,y,z) 21m・#15 (x,y,z) 34m 檻つき」 from the body's count, else the marks in view. */
export function crystalLine(end: EndView | null): string | null {
  const crystals = end?.crystals;
  if (!crystals) return null;
  if (crystals.remaining === null) return crystals.visible ? `エンドクリスタル: 見えている ${crystals.visible} 個（島全体の残りは体がまだ数えていない）` : null;
  const counts = ([['壊れた', crystals.gone], ['檻つき', crystals.caged], ['まだ見ていない台座', crystals.unseen]] as const)
    .flatMap(([label, value]) => value !== null && value > 0 ? [`${label} ${value}`] : []);
  const list = crystals.list.slice(0, 3).map(crystalWords);
  return `エンドクリスタル: 残り ${crystals.remaining}/10${counts.length ? `（${counts.join('・')}）` : ''}${list.length ? `。近い順: ${list.join('・')}` : ''}`;
}

/** A cloud's size in words: the radius the body avoids (it grows with the cloud's age) when it says one, with the cloud's radius now. */
function cloudWords(cloud: EndCloud): string {
  const now = cloud.r === null ? '?' : String(round(cloud.r));
  return cloud.danger === null ? `半径 ${now}` : `避ける半径 ${round(cloud.danger)}（雲の今の半径 ${now}）`;
}

/** The breath clouds the body lists (`dragonBreath`: x, y, z, radius and the radius it counts as dangerous), at most three. */
export function breathLine(end: EndView | null): string | null {
  const clouds = (end?.clouds ?? []).slice(0, 3).map(cloud => `(${Math.floor(cloud.x)},${Math.floor(cloud.z)}) ${cloudWords(cloud)}`);
  return clouds.length ? `竜の息の雲: ${clouds.join('・')}（中で立ち止まらない）` : null;
}

/** The fireballs in flight (the body's count; where they go is its floor reflex's to read). */
export function fireballLine(end: EndView | null): string | null {
  return end && end.fireballs > 0 ? `火の玉: ${end.fireballs} 個が飛んでいる（体の反射が避ける）` : null;
}

/** The perch, where the dragon sits (the body's `perch`, else its map mark). */
export function perchLine(end: EndView | null): string | null {
  const spot = place(end?.fountain ?? null);
  return spot ? `止まり木: ${spot}` : null;
}

/** All the lines of the fight in the End, the dragon's first. */
export function endFightLines(end: EndView | null): string[] {
  return [dragonLine(end), crystalLine(end), breathLine(end), fireballLine(end), perchLine(end)].filter((line): line is string => line !== null);
}

/** The dimension a death line or a record names, without `minecraft:`. */
const dimensionOf = (value: unknown): string | null => typeof value === 'string' ? value.replace(/^minecraft:/u, '') : null;

/**
 * The last death: the body's line as it is (while the dropped items may still lie there or for half an hour: where, how long ago, the
 * cause, what was dropped and how long they last), and the dimension it was in when that is not the one she is in now.
 */
export function deathLine(world: Rec): string | null {
  const said = typeof world.lastDeath === 'string' ? world.lastDeath.trim() : '';
  if (!said) return null;
  const last = rec((Array.isArray(world.deaths) ? world.deaths : []).at(-1));
  const there = dimensionOf(last?.dimension);
  const here = dimensionOf(world.dimension);
  const apart = there && here && there !== here ? `（その次元 ${there} は今いる ${here} と別。行くにはポータルを通る）` : '';
  return `最後の死: ${said}${apart}`;
}

const PLACE_LABELS: ReadonlyArray<readonly [string, string]> = [['nether_portal', 'ポータル'], ['fortress', 'ネザー要塞'], ['stronghold', 'ストロングホールド'],
  ['end_portal_frame', 'エンドポータルの枠'], ['respawn', 'リスポーン地点']];

/** 「ポータル 34m 北東 (12,63,-40) ↔overworld(100,64,-300)」: the body's remembered places the way to the dragon uses. */
export function placeLine(world: Rec): string | null {
  const places = rec(world.rememberedPlaces);
  if (!places) return null;
  const lines = PLACE_LABELS.flatMap(([kind, label]) => {
    const line = places[kind];
    return typeof line === 'string' && line.trim() ? [`${label} ${line.trim().slice(0, 90)}`] : [];
  });
  return lines.length ? `控え（体の記憶、今いる次元）: ${lines.join('・')}` : null;
}

/**
 * The eyes the portal room needs: the frames the body counts (`×12 アイ入り 3`), how many are still empty, and what she holds. Said
 * only once frames are in view; before that the eyes are counted by the ledger of the throws.
 */
export function frameLine(world: Rec, eyesHeld: number): string | null {
  const frames = framesOf(world);
  if (!frames) return null;
  const empty = Math.max(0, frames.frames - frames.eyes);
  const lack = Math.max(0, empty - eyesHeld);
  return `ポータルの枠: 見えている ${frames.frames} 個のうちアイ入り ${frames.eyes}・あと ${empty} 個はめる・手持ちのアイ ${eyesHeld} 個`
    + `${lack ? `（${lack} 個足りない）` : ''}`;
}
