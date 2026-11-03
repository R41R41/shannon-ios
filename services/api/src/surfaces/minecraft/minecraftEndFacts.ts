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
const hundredth = (value: number): string => String(Number(value.toFixed(2)));
const rangeWords = (range: [number, number]): string => range[0] === range[1] ? hundredth(range[0]) : `${hundredth(range[0])}〜${hundredth(range[1])}`;

/** The body's measured ranges, not a clock calculated by the head. Unknown is not a closed window. */
function windowWords(dragon: EndDragon, short: boolean): string {
  const windows = dragon.windows;
  if (!windows) return '';
  if (short) return windows.open === null ? '' : windows.open ? '窓は開いている' : '窓は閉じている';
  const state = windows.open === true ? '窓は開いている' : windows.secondsUntil ? `窓まで ${rangeWords(windows.secondsUntil)} 秒`
    : windows.open === false ? '窓は閉じている' : '';
  const length = windows.lengthSeconds ? `窓は ${rangeWords(windows.lengthSeconds)} 秒` : '';
  const duration = length ? (state ? `（${length}）` : length) : '';
  return state || length ? `${state}${duration}（実測目安）` : '';
}

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
export function dragonLine(end: EndView | null, short = false): string | null {
  const dragon = end?.dragon;
  if (!dragon) return null;
  const far = dragon.distance === null ? '' : ` 自分から ${metres(dragon.distance)}`;
  const where = place(dragon.headPosition) ? `頭 ${place(dragon.headPosition)}` : place(dragon.position) ? `位置 ${place(dragon.position)}${far}` : '';
  const parts = [dragon.health === null ? '' : `体力 ${tenth(dragon.health)}/200`, stateWords(dragon), where, reachWords(dragon),
    dragon.id === null ? '' : `#${dragon.id}`, windowWords(dragon, short)].filter(Boolean);
  return parts.length ? `竜: ${parts.join('・')}` : null;
}

function crystalWords(crystal: EndCrystal): string {
  const blast = crystal.blast === null ? '' : `壊すと爆発（今の立ち位置で体力 −${round(crystal.blast)} の見込み）`;
  const tags = [crystal.caged === true ? '檻つき' : '', crystal.healing ? '竜を回復中' : '', blast].filter(Boolean);
  const name = crystal.id === null ? '' : `#${crystal.id} `;
  return `${name}${place(crystal.position)} ${metres(crystal.distance)}${tags.length ? ` ${tags.join('・')}` : ''}`.trim();
}

/** 「エンドクリスタル: 残り 4/10（壊れた 6・檻つき 1）。近い順: #12 (x,y,z) 21m・#15 (x,y,z) 34m 檻つき」 from the body's count, else the marks in view. */
export function crystalLine(end: EndView | null, short = false): string | null {
  const crystals = end?.crystals;
  if (!crystals) return null;
  const stats = short ? undefined : crystals.stats;
  // The computation time is parsed for the view, but does not belong in every decision's fight facts.
  const search = stats ? [stats.examinedCells === null ? '' : `${stats.examinedCells} マス`, stats.gridStep === null ? '' : `格子 ${tenth(stats.gridStep)}m`,
    stats.truncated === true ? '打ち切り' : ''].filter(Boolean).join('・') : '';
  const searchWords = search ? `射点探索: ${search}` : '';
  if (crystals.remaining === null) {
    const visible = crystals.visible ? `見えている ${crystals.visible} 個（島全体の残りは体がまだ数えていない）` : '';
    return visible || searchWords ? `エンドクリスタル: ${[visible, searchWords].filter(Boolean).join('。')}` : null;
  }
  const counts = ([['壊れた', crystals.gone], ['檻つき', crystals.caged], ['まだ見ていない台座', crystals.unseen]] as const)
    .flatMap(([label, value]) => value !== null && value > 0 ? [`${label} ${value}`] : []);
  const list = crystals.list.slice(0, 3).map(crystalWords);
  return `エンドクリスタル: 残り ${crystals.remaining}/10${counts.length ? `（${counts.join('・')}）` : ''}${list.length ? `。近い順: ${list.join('・')}` : ''}`
    + `${searchWords ? `。${searchWords}` : ''}`;
}

/** Three shooting places in all, nearest to the current feet. Each body's list is already nearest first when feet are unknown. */
export function crystalOpeningLine(end: EndView | null): string | null {
  const feet = end?.feet;
  const entries = (end?.crystals.openings ?? []).flatMap(crystal => (crystal.caged === true ? crystal.afterCageRemoved : crystal.positions)
    .map(shot => ({ crystal, shot, near: feet ? Math.hypot(shot.x - feet.x, shot.y - feet.y, shot.z - feet.z) : 0 })))
    .sort((a, b) => a.near - b.near);
  const seen = new Set<string>();
  const words = entries.filter(({ crystal, shot }) => {
    const key = `${crystal.id}:${shot.x},${shot.y},${shot.z}:${crystal.caged}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3).map(({ crystal, shot }) => {
    const id = crystal.id === null ? '' : `#${crystal.id} `;
    const block = crystal.blockedBy;
    const cage = crystal.caged === true ? `檻${block ? ` (${[block.name, place(block)].filter(Boolean).join(' ')})` : ''} を取ると` : '';
    return `${id}${cage}撃てる位置 ${place(shot)}${shot.distance === null ? '' : ` 距離 ${tenth(shot.distance)}m`}`;
  });
  return words.length ? `クリスタルの射点: ${words.join('・')}` : null;
}

/** Two groups at most; the ids name exactly the crystals the body says are shootable now. */
export function crystalShootSetsLine(end: EndView | null): string | null {
  const seen = new Set<string>();
  const sets = (end?.crystals.shootSets ?? []).filter(set => {
    const key = `${set.at.x},${set.at.y},${set.at.z}:${[...set.crystals].sort((a, b) => a - b).join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 2).map(set => `${place(set.at)} から ${set.crystals.length} 基${set.walkMeters === null ? '' : `（歩き ${tenth(set.walkMeters)} m）`}`
    + ` [${set.crystals.map(id => `#${id}`).join(',')}]`);
  return sets.length ? `同じ射点: ${sets.join('・')}` : null;
}

/** One stage and its own strike, plus one retreat. This describes positions, never a hand to execute. */
export function dragonApproachLine(end: EndView | null, short = false): string | null {
  const dragon = end?.dragon, approach = dragon?.approach;
  if (!dragon || dragon.phase === null || !SITTING.has(dragon.phase) || !approach) return null;
  const byWalk = (a: { walkMeters: number | null }, b: { walkMeters: number | null }) => (a.walkMeters ?? Infinity) - (b.walkMeters ?? Infinity);
  const stages = [...approach.stage].sort((a, b) => (a.toStrikeMeters ?? Infinity) - (b.toStrikeMeters ?? Infinity) || byWalk(a, b));
  // Prefer a pair whose association survived validation; an invalid strike never shifts the body's indexes.
  const stage = stages.find(stage => approach.strike.some(strike => strike.index === stage.strikeIndex)) ?? stages[0];
  const strike = stage ? approach.strike.find(strike => strike.index === stage.strikeIndex) : [...approach.strike].sort(byWalk)[0];
  const retreat = short ? undefined : [...approach.retreat].sort(byWalk)[0];
  const parts = [strike ? `頭の下 strike ${place(strike)}` : '', stage ? `待つ所 stage ${place(stage)}`
    + `${strike && stage.toStrikeMeters !== null ? `（strike まで ${tenth(stage.toStrikeMeters)} m）` : ''}` : '',
    retreat ? `退く所 retreat ${place(retreat)}` : ''].filter(Boolean);
  return parts.length ? `止まり木の位置: ${parts.join('・')}` : null;
}

/** Proven basin footing, nearest by the body's walking distance. Unknown fields never mean clear of a hazard. */
export function dragonBasinLine(end: EndView | null): string | null {
  const dragon = end?.dragon;
  if (!dragon || dragon.phase === null || !SITTING.has(dragon.phase)) return null;
  const positions = (dragon.approach?.basin ?? []).slice(0, 3).map(spot => {
    const walk = spot.walkSeconds === null ? '' : ` 歩く約 ${tenth(spot.walkSeconds)} 秒`;
    const wing = spot.inWingPush === null ? '不明' : spot.inWingPush ? '⚠範囲内' : '範囲外';
    const breath = spot.inBreathNow === null ? '不明' : spot.inBreathNow ? '範囲内' : '範囲外';
    return `${place(spot)}${walk}・翼の押し ${wing}・息 ${breath}`;
  });
  return positions.length ? `窪みの足場 ${positions.length} 件: ${positions.join(' / ')}` : null;
}

/** The waiting cells beside the perch's facing (phases 3 to 7), nearest by the body's walking time. */
export function dragonWaitLine(end: EndView | null): string | null {
  const dragon = end?.dragon;
  if (!dragon || dragon.phase === null || dragon.phase < 3 || dragon.phase > 7) return null;
  const seconds = (spot: { walkSeconds: number | null }) => spot.walkSeconds === null ? '' : ` 歩く約 ${tenth(spot.walkSeconds)} 秒`;
  const cells = (dragon.approach?.wait ?? []).slice(0, 3).map(spot => `${place(spot)}${seconds(spot)}`);
  return cells.length ? `待ち場の候補（竜の向きの横 10〜14m の足場）${cells.length} 件: ${cells.join(' / ')}` : null;
}

/** A cloud's size in words: the radius the body avoids (it grows with the cloud's age) when it says one, with the cloud's radius now. */
function cloudWords(cloud: EndCloud): string {
  const now = cloud.radius === null ? '?' : String(round(cloud.radius));
  return cloud.dangerRadius === null ? `半径 ${now}` : `避ける半径 ${round(cloud.dangerRadius)}（雲の今の半径 ${now}）`;
}

/** The breath clouds the body lists (`dragonBreath`: x, y, z, radius and the radius it counts as dangerous), at most three. */
export function breathLine(end: EndView | null): string | null {
  const clouds = (end?.breath ?? []).slice(0, 3).map(cloud => `(${Math.floor(cloud.x)},${Math.floor(cloud.z)}) ${cloudWords(cloud)}`);
  return clouds.length ? `竜の息の雲: ${clouds.join('・')}（中で立ち止まらない）` : null;
}

/** The fireballs in flight (the body's count; where they go is its floor reflex's to read). */
export function fireballLine(end: EndView | null): string | null {
  return end && end.fireballs > 0 ? `火の玉: ${end.fireballs} 個が飛んでいる（体の反射が避ける）` : null;
}

/** The perch, where the dragon sits (the body's `perch`, else its map mark). */
export function perchLine(end: EndView | null): string | null {
  const spot = place(end?.perch ?? null);
  return spot ? `止まり木: ${spot}` : null;
}

/** At most six existing fight lines, plus one basin line for normal decisions. Join hazards when the existing observations need the room. */
export function endFightLines(end: EndView | null): string[] {
  const lines = [dragonLine(end), crystalLine(end), crystalOpeningLine(end), crystalShootSetsLine(end)].filter((line): line is string => line !== null);
  const positions = dragonApproachLine(end) ?? perchLine(end);
  const hazards = [breathLine(end), fireballLine(end)].filter((line): line is string => line !== null);
  if (lines.length + hazards.length + (positions ? 1 : 0) > 6) lines.push(hazards.join('・'));
  else lines.push(...hazards);
  if (positions) lines.push(positions);
  const basin = dragonBasinLine(end);
  if (basin) lines.push(basin);
  const wait = dragonWaitLine(end);
  if (wait) lines.push(wait);
  return lines;
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
export function frameLine(world: Rec, eyesHeld: number, supply?: EyeSupply): string | null {
  const frames = framesOf(world);
  if (!frames) return null;
  const empty = Math.max(0, frames.frames - frames.eyes);
  const lack = Math.max(0, empty - eyesHeld);
  return `ポータルの枠: 見えている ${frames.frames} 個のうちアイ入り ${frames.eyes}・あと ${empty} 個はめる・手持ちのアイ ${eyesHeld} 個`
    + `${lack ? `（${lack} 個足りない${supply ? `: ${shortOfEyes(lack, supply)}` : ''}）` : ''}`;
}

/** What is carried to make eyes from (a pearl and a powder each; a rod makes two powders). */
export interface EyeSupply { pearls: number; powder: number; rods: number }

/**
 * Once the frames are in view the count is exact (no reserve is needed any more): what the missing eyes take, and how many can be made from what
 * is carried now, so that a trip back to the Nether is a number (pearls and rods to bring), not a guess.
 */
export function shortOfEyes(lack: number, supply: EyeSupply): string {
  const makeable = Math.min(supply.pearls, supply.powder + supply.rods * 2);
  const pearls = Math.max(0, lack - supply.pearls);
  const rods = Math.max(0, Math.ceil((lack - supply.powder) / 2) - supply.rods);
  const have = `手持ち パール ${supply.pearls}・粉 ${supply.powder}・ロッド ${supply.rods} から作れるのは ${makeable} 個`;
  const need = `作るには パール ${lack}・粉 ${lack}（ロッド ${Math.ceil(lack / 2)} 本分）。${have}`;
  return makeable >= lack ? `${need}（手持ちで足りる）` : `${need}。ネザーで取る分: パール ${pearls} 個・ロッド ${rods} 本`;
}
