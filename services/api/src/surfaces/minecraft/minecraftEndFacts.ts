import type { EndCloud, EndCrystal, EndDragon, EndView, Point } from './minecraftEndView.js';
import { blocked, NAMES, readLayers } from './minecraftLlmcPreflightMap.js';
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
  return `${PHASE_WORDS[phase]}（phase ${phase}${seconds}${sitting ? '。矢は効かない' : ''}${strafeWords(dragon)}）`;
}

/**
 * e04b (11/9, S11): the dragon stayed in phase 1 for 30 min and more and never came down to the perch. The game ends that phase only
 * after a fireball shot at her with her in its sight; she stood on the arrival platform buried in the island (a closed hole, its roof
 * end stone 5 high), so no shot came, and the head said only 「狙いを定めて火の玉（phase 1）」 each time. The seconds of a long phase 1
 * and what the game makes of it are the fact; where to go is the model's.
 */
export const STRAFE_LONG_SECONDS = 20;
function strafeWords(dragon: EndDragon): string {
  if (dragon.phase !== 1 || dragon.phaseFor === null || dragon.phaseFor < STRAFE_LONG_SECONDS) return '';
  return `・この phase ${round(dragon.phaseFor)} 秒目。竜はあなたが見えて火の玉を撃つまでこの phase を続け、その間は止まり木へ降りない`;
}

/** The roof from the body's column line over her feet (`縦 (100,0) 上: y=50〜52 .×3 / y=53〜57 E×5 / y=58〜65 .×8 …`): "open" when the column shows no solid block over her, null when there is no column line. */
function columnRoof(text: string, feet: { x: number; z: number }): string | 'open' | null {
  const line = text.split('\n').find(row => row.startsWith(`縦 (${feet.x},${feet.z}) 上:`));
  if (!line) return null;
  const runs = [...line.matchAll(/y=(-?\d+)(?:〜(-?\d+))? (\S)(?:×\d+)?/gu)].map(m => ({ low: Number(m[1]), high: Number(m[2] ?? m[1]), symbol: m[3]! }));
  const solid = runs.findIndex(run => blocked(run.symbol));
  if (solid < 0) return 'open';
  const top = runs[solid]!, sky = runs.slice(solid + 1).find(run => !blocked(run.symbol));
  const name = NAMES[top.symbol] ?? '固いブロック';
  const span = top.low === top.high ? `y=${top.low}` : `y=${top.low}〜${top.high}`;
  return `真上は ${span} が${name}（${top.high - top.low + 1} 段）${sky ? `、y=${sky.low} から空気` : '、その上は地図に無い'}`;
}
function layerRoof(above: Map<string, string> | undefined, cells: Set<string>, y: number): string {
  const symbols = [...cells].map(key => above?.get(key));
  return symbols.every(symbol => symbol !== undefined && blocked(symbol)) ? '頭の上も固い'
    : symbols.some(symbol => symbol === undefined) ? `y=${y} から上は地図に無い` : `真上は y=${y} まで空気で、その上は地図に無い`;
}

/** The arrival platform of the End is the game's own place (5×5 obsidian at y 48 around (100,_,0)), the same in every world. */
const ARRIVAL = { x: 100, z: 0, yLow: 46, yHigh: 53, reach: 4 };
const ENCLOSED_MAX_CELLS = 80;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
/**
 * e04b (11/9, S11): the platform was made inside the island, so it was a 5×5 hole walled and roofed with end stone; the knowledge said
 * 「主島までは虚空のことが多い: 足元に橋を置いて渡る」, the model counted cobblestone for an 89 m bridge, decided 「台で座りを待つ」 and
 * waited there over 30 min while the dragon circled in phase 1. Whether the hole is closed is read from the body's map (its feet and head
 * layers): the cells she can stand in from her feet, by the four sides, never reach a cell the map does not show, and every side ends
 * in a solid block. A roof the map does not show is said as unknown. Only on the arrival platform; nothing here moves her.
 */
export function enclosedLine(world: Rec): string | null {
  if (world.dimension !== 'the_end' || typeof world.localMap !== 'string') return null;
  const map = readLayers(world.localMap);
  if (!map) return null;
  const { feet } = map;
  if (Math.abs(feet.x - ARRIVAL.x) > ARRIVAL.reach || Math.abs(feet.z - ARRIVAL.z) > ARRIVAL.reach || feet.y < ARRIVAL.yLow || feet.y > ARRIVAL.yHigh) return null;
  const foot = map.layers.get(feet.y), head = map.layers.get(feet.y + 1);
  if (!foot || !head) return null;
  const seen = new Set<string>([`${feet.x},${feet.z}`]);
  const walls = new Map<string, number>();
  const todo = [{ x: feet.x, z: feet.z }];
  while (todo.length) {
    const cell = todo.pop()!;
    for (const [dx, dz] of SIDES) {
      const key = `${cell.x + dx},${cell.z + dz}`;
      if (seen.has(key)) continue;
      const low = foot.get(key), high = head.get(key);
      if (low === undefined || high === undefined) return null;
      const wall = blocked(low) ? low : blocked(high) ? high : null;
      if (wall) { walls.set(wall, (walls.get(wall) ?? 0) + 1); continue; }
      seen.add(key);
      if (seen.size > ENCLOSED_MAX_CELLS) return null;
      todo.push({ x: cell.x + dx, z: cell.z + dz });
    }
  }
  const wall = [...walls].sort((a, b) => b[1] - a[1])[0]?.[0];
  const column = columnRoof(world.localMap, feet);
  if (column === 'open') return null;
  const roof = column ?? layerRoof(map.layers.get(feet.y + 2), seen, feet.y + 2);
  return `閉じた穴: 到着の台が島の中に埋まっている。足の高さで立てる所は ${seen.size} マスだけで、四方は${wall ? (NAMES[wall] ?? '固いブロック') : '固いブロック'}の壁（${roof}）。`
    + '空が見えないので、竜はあなたを撃てず狙いの周回（phase 1）のまま止まり木へ降りない。ここでは待たない。'
    + 'vertical（stairs）で上へ掘り上がって地表に出る（島の上は地続きで、橋は要らない）';
}

/** The block names a symbol of the map stands for, as `vertical`'s dig= takes them. */
const DIG_NAMES: Readonly<Record<string, readonly string[]>> = { E: ['end_stone'], '#': ['cobblestone', 'stone'], O: ['obsidian'], ':': ['dirt'] };
/**
 * e04e (11/9, S11): on a 1×1 pillar 16 high she tried to come down with `dig 0,-1,0` and `walk 0,-1,0` seven times; walk cannot step down,
 * so each act ended after one block, the body's cloud reflex stacked end stone under her again, and after about 90 s on the pillar a
 * fireball and the breath cloud killed her. Whether she stands on a pillar is read from the body's map: the four sides of her feet and of
 * the block under her are air, and the column under her (`縦 (x,z) 下:`) is solid down to the end of what the map shows. A column with air
 * under it (a pillar over the void) says nothing: digging down there drops her. Where to go is the model's.
 */
export function pillarLine(world: Rec): string | null {
  if (world.dimension !== 'the_end' || typeof world.localMap !== 'string') return null;
  const map = readLayers(world.localMap);
  if (!map) return null;
  const { feet } = map;
  for (const y of [feet.y, feet.y - 1]) {
    const layer = map.layers.get(y);
    if (!layer) return null;
    for (const [dx, dz] of SIDES) {
      const symbol = layer.get(`${feet.x + dx},${feet.z + dz}`);
      if (symbol === undefined || blocked(symbol)) return null;
    }
  }
  const line = world.localMap.split('\n').find(row => row.startsWith(`縦 (${feet.x},${feet.z}) 下:`));
  if (!line) return null;
  const runs = [...line.matchAll(/y=(-?\d+)(?:〜(-?\d+))? (\S)(?:×\d+)?/gu)].map(m => ({ high: Number(m[1]), low: Number(m[2] ?? m[1]), symbol: m[3]! }));
  if (!runs.length || runs[0]!.high !== feet.y - 1 || runs.some(run => !blocked(run.symbol))) return null;
  const bottom = Math.min(...runs.map(run => run.low)), height = feet.y - bottom;
  const more = line.trimEnd().endsWith('…');
  const dig = [...new Set(runs.flatMap(run => DIG_NAMES[run.symbol] ?? []))];
  if (!dig.length) return null;
  return `柱の上: 足の下は y=${feet.y - 1}〜${bottom}${more ? ' より下まで' : ''}続く 1 マスの柱（${height} 段${more ? '以上' : ''}、周りは空気）。`
    + `降りるのは 1 手 \`vertical down shaft y=${bottom} dig=${dig.join(',')} liquid=stop\`（1 段約 1 秒）。`
    + 'dig 0,-1,0 で足元を掘ると体はすぐ 1 段落ちるので、続けた walk 0,-1,0 は落ちた後の足のさらに 1 段下（柱の中の固いマス）を指して必ず失敗し、手はそこで止まる（repeat を付けても 1 段だけ）'
    + '（実走: これを 7 回繰り返して約 90 秒柱の上に居て、その間に雲の反射が足元へ積み直し、火の玉と息の雲で死亡）';
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
  const where = place(dragon.headPosition) ? `頭 ${place(dragon.headPosition)}${far}` : place(dragon.position) ? `位置 ${place(dragon.position)}${far}` : '';
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

/**
 * Three shooting places in all: the uncaged crystals' first, then nearest to the current feet (each body's list is already nearest
 * first when feet are unknown). e01 (11/9): the three nearest were all one caged crystal's places, the uncaged ones fell out of the
 * line, and the head stood 3 minutes where it could not shoot (the bar is 20 m up the pillar). A caged place now says the bar is taken
 * on the pillar first, and an uncaged crystal with no place yet is named with the way to get one.
 */
/**
 * 11/27 (a run: five shots at one crystal from 83 degrees up, none hit; seven direct shots, four hit): an arrow at a high angle takes long to arrive and the crystal does not stand still in the wind of the wings, so
 * the angle is said beside the place, and what to do after a miss.
 */
export const HIGH_ARC_DEGREES = 60;
const ARC_WORDS = `仰角が ${HIGH_ARC_DEGREES}° を超える山なりは当たりにくい（実走: 83° で 5 射 0 命中、直射 7 射で 4 命中）。1 回外れたら同じ所から続けず、別の結晶か別の射点へ。射線が通る（仰角の低い）結晶を先に`;
export function crystalOpeningLine(end: EndView | null): string | null {
  const feet = end?.feet;
  const entries = (end?.crystals.openings ?? []).flatMap(crystal => (crystal.caged === true ? crystal.afterCageRemoved : crystal.positions)
    .map(shot => ({ crystal, shot, near: feet ? Math.hypot(shot.x - feet.x, shot.y - feet.y, shot.z - feet.z) : 0 })))
    .sort((a, b) => Number(a.crystal.caged === true) - Number(b.crystal.caged === true) || a.near - b.near);
  const seen = new Set<string>();
  const words = entries.filter(({ crystal, shot }) => {
    const key = `${crystal.id}:${shot.x},${shot.y},${shot.z}:${crystal.caged}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3).map(({ crystal, shot }) => {
    const id = crystal.id === null ? '' : `#${crystal.id} `;
    const block = crystal.blockedBy;
    const cage = crystal.caged === true
      ? `檻つき: 柱を登って格子${block ? ` (${[block.name, place(block)].filter(Boolean).join(' ')})` : ''} を dig で取った後なら` : '';
    return `${id}${cage}撃てる位置 ${place(shot)}${shot.distance === null ? '' : ` 距離 ${tenth(shot.distance)}m`}${shot.pitchDeg !== null && Math.abs(shot.pitchDeg) > HIGH_ARC_DEGREES ? ` 仰角 ${round(Math.abs(shot.pitchDeg))}°（山なり）` : ''}`;
  });
  const placed = new Set((end?.crystals.openings ?? []).filter(crystal => crystal.caged !== true && crystal.positions.length > 0).map(crystal => crystal.id));
  const unplaced = end?.crystals.openings ? (end.crystals.list ?? []).filter(crystal => crystal.caged !== true && !placed.has(crystal.id)).slice(0, 2)
    .map(crystal => `${crystal.id === null ? '' : `#${crystal.id} `}${place(crystal.position) ?? ''}`.trim()).filter(Boolean) : [];
  const far = unplaced.length ? [`檻なし ${unplaced.join('・')} は今の床から射点なし（64m 以内の開けた床へ近づくと出る）`] : [];
  const all = [...words, ...far];
  const arc = entries.some(({ shot }) => shot.pitchDeg !== null && Math.abs(shot.pitchDeg) > HIGH_ARC_DEGREES) ? `。${ARC_WORDS}` : '';
  return all.length ? `クリスタルの射点: ${all.join('・')}${arc}` : null;
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

/**
 * The bed hand the body measured while she sits and a bed is held (`approach.bed`): one act from the stand, in the body's order.
 * The pillow lies beyond the foot as seen from the stand, so the bed is placed from that stand. Estimates are the body's, not a result.
 */
export function dragonBedLine(end: EndView | null, bedItem: string | null = null): string | null {
  const dragon = end?.dragon, offer = dragon?.approach?.bed?.[0];
  if (!dragon || dragon.phase === null || !SITTING.has(dragon.phase) || !offer) return null;
  // e04c (11/9): one bed took her 200→173 with ten crystals standing, and she was back at 200 about 13 s after taking off.
  // 11/27 (vanilla 1.21.11): one crystal left heals her 1 per 10 ticks, the same as ten (not by the count), so the bed waits until none is left, caged ones too.
  const standing = end?.crystals.remaining ?? null;
  if (standing !== null && standing >= 1) return `ベッドの手: 今は使わない（結晶が ${standing} 本残る間は、1 本でも竜は毎秒 2 回復し、削った分が戻る。実走で 173→200 を約 13 秒。ベッドは檻つきも含めて結晶を 0 本にしてから）`;
  const bed = bedItem ?? 'red_bed', foot = place(offer.foot);
  const build = offer.build.length ? ` → place block=obsidian at=[${offer.build.map(cell => place(cell)).join(',')}]（${offer.build.some(cell => cell.role === 'screen') ? '自分を守る壁。黒曜石が無ければ end_stone・cobblestone など手持ちの固いブロックで置く: 爆発を 1 回は遮るが壊れるので、次のベッドの前にまた置く' : 'ベッドの下の支え。黒曜石が無ければ end_stone・cobblestone でもよい'}）` : '';
  const estimate = [offer.dragonExpected === null ? '' : `竜の頭 −${round(offer.dragonExpected)}`, offer.selfExpected === null ? '' : `自分 −${tenth(offer.selfExpected)}`].filter(Boolean).join('・');
  const walk = offer.walkMeters === null ? '' : `、歩き ${round(offer.walkMeters)}m`;
  // The server names no one for a bed's blast, so a kill by the bed alone gives no end/kill_dragon, which the full run's gate and section T
  // want beside boss.verified: vanilla credits the kill to a player who hurt her within the last 5 s. When this bed may be the last one,
  // a short strike from the stand comes first (any part, any held item); out of reach it ends at once and the bed goes off as before.
  const last = dragon.health !== null && offer.dragonExpected !== null && dragon.health <= offer.dragonExpected + 10;
  const credit = last ? ' → attack target=ender_dragon seconds=2 onFail="continue"' : '';
  const why = last ? `。竜の体力 ${round(dragon.health!)} はこのベッドで尽きる見込み: ベッドだけで倒すと手柄が付かず advancement end/kill_dragon が出ないので、use の前に 1 回打つ（届かなくてもそのまま use）` : '';
  return `ベッドの手（体が測った候補）: go ${place(offer.stand)} range=0.5${build} → place block=${bed} at=[${foot}]${credit} → use at=[${foot}]`
    + `（枕は ${place(offer.head)}${estimate ? `、見込み ${estimate}` : ''}${walk}。同じ act に並べる。立つ所から動くと計算が変わる${last ? '' : '。use の後もこの行が出ていれば、すぐもう 1 個'}${why}）`;
}

/** The waiting cells, nearest by the body's walking time: beside the perch's facing (phases 3 to 7), or for the next sit while she flies (0, 1, 2, 8, 10). */
export function dragonWaitLine(end: EndView | null): string | null {
  const dragon = end?.dragon, phase = dragon?.phase ?? null;
  if (!dragon || phase === null || phase === 9 || phase < 0 || phase > 10) return null;
  const sitting = phase >= 3 && phase <= 7;
  const seconds = (spot: { walkSeconds: number | null; walkMeters: number | null; straight?: boolean }) => spot.straight
    ? (spot.walkMeters === null ? '' : ` 直線約 ${round(spot.walkMeters)}m（道は go が引く）`)
    : (spot.walkSeconds === null ? '' : ` 歩く約 ${tenth(spot.walkSeconds)} 秒`);
  const cells = (dragon.approach?.wait ?? []).slice(0, 3).map(spot => `${place(spot)}${seconds(spot)}`);
  if (!cells.length) return null;
  const line = waitCells(end, sitting, cells);
  return line + aloftWaitWords(end);
}
function waitCells(end: EndView | null, sitting: boolean, cells: string[]): string {
  return sitting ? `待ち場の候補（竜の向きの横 10〜14m の足場）${cells.length} 件: ${cells.join(' / ')}`
    : `${tooNearPerch(end)}${crystalsFirst(end)}待ち場の候補（次の座りを待つ所、止まり木から 10〜14m）${cells.length} 件: ${cells.join(' / ')}`;
}

/** The wait line while she is aloft (11/27): how much higher her feet are than the cells, how long coming down takes, and that a sit cannot be reached from up there. */
function aloftWaitWords(end: EndView | null): string {
  const drop = aloftBy(end), feetY = end?.feet?.y ?? null, spots = end?.dragon?.approach?.wait ?? [];
  if (drop === null || feetY === null || !spots.length) return '';
  const nearest = [...spots].sort((a, b) => (a.walkMeters ?? Infinity) - (b.walkMeters ?? Infinity))[0]!;
  const above = Math.round(feetY - nearest.y), walk = nearest.walkMeters === null ? null : Math.round(nearest.walkMeters / 4);
  return `。今の足は待ち場より ${above} m 高い。降りる時間の目安: 飛び降り 約 3 秒${walk === null ? '' : `＋着水から待ち場まで歩く約 ${walk} 秒`}、掘って降りるなら 1 段ごとに足す（黒曜石 約 9.4 秒・エンドストーン 約 0.6 秒）。`
    + '座りは約 27 秒で、ここからは座りに間に合わず剣もベッドも届かない（座りに間に合うのは、先に降りて待ち場に立った時）';
}

/** The waiting line for an urgent decision: only while she flies and the body stands on the perch (e03 11/9: after a fireball's reflex the urgent
 * decision had no waiting line, the head waited 5 s more in the basin and the breath killed it). */
export function dragonWaitUrgentLine(end: EndView | null): string | null {
  const line = dragonWaitLine(end);
  return line && line.startsWith('今いる ') ? line : null;
}

/** While any crystal stands (caged ones too) she heals 2 a second between sits, however many stand, so the crystals come before waiting for the next sit (e04c 11/9; 11/27 the heal is not by the count). */
function crystalsFirst(end: EndView | null): string {
  const standing = end?.crystals.remaining ?? null;
  return standing !== null && standing >= 1 ? `結晶が ${standing} 本残る間は待たず、結晶を壊しに行く（1 本でも竜は毎秒 2 回復し、座りの傷が周回中に戻るため。檻つきも壊す）。` : '';
}

/** Waiting on the perch itself while she flies: her landing breath falls there, and the basin has no way out that the floor reflex can walk. */
function tooNearPerch(end: EndView | null): string {
  const feet = end?.feet, perch = end?.perch;
  if (!feet || !perch) return '';
  const meters = Math.hypot(feet.x - perch.x, feet.z - perch.z);
  return meters < 8 ? `今いる ${place(feet)} は止まり木から ${round(meters)}m で、待ち場ではない: 着地の前の息の雲が落ちる所で、窪みから歩いて出る道が無い。ここで待たず下の候補へ go して待つ。` : '';
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

/** The distance at which a body may climb a pillar while she circles: her strafe turns on a body within about 30 m (e04e). */
export const CLIMB_CLEAR_METRES = 30;

/**
 * Without a bow the crystals are struck from a pillared column beside the pillar. e04e (11/9): the line opened with 「今は撃てない」 and gave
 * the climbing rule as a condition; with her circling at 26-56 m the head recited 「30m 以上で登る」 and still waited about 250 s (the replay
 * of the wording alone moved 1 of 9). The line now says what the present phase and distance mean: climb now, or not yet and why.
 */
/**
 * The pillar to climb: uncaged first (caged ones when none is left), away from her (the replay of e04e's decision 49 went for a far caged one when the named crystal stood
 * 6 m from her), then the one with the least climbing and walking (a block climbed counts as about 2 m walked).
 */
function climbTarget(end: EndView | null): EndCrystal | null {
  const all = end?.crystals.list ?? [];
  // 11/27: with no uncaged crystal left the pillar to climb is a caged one (all crystals go down before the dragon is fought).
  const open = all.some(crystal => crystal.caged !== true) ? all.filter(crystal => crystal.caged !== true) : all;
  const her = end?.dragon?.position ?? null;
  const fromHer = (crystal: EndCrystal) => her ? Math.hypot(crystal.position.x - her.x, crystal.position.z - her.z) : Infinity;
  const away = open.filter(crystal => fromHer(crystal) >= CLIMB_CLEAR_METRES);
  const feetY = end?.feet?.y ?? null;
  const cost = (crystal: EndCrystal) => (feetY === null ? 0 : crystal.position.y - feetY) + (crystal.distance ?? 0) / 2;
  return [...(away.length ? away : open)].sort((a, b) => cost(a) - cost(b))[0] ?? null;
}

/**
 * How many crystals are left when every one left is caged and in the list (null otherwise): the line then names the caged ones, with the bars to dig,
 * where it said 「檻なしの結晶の柱の脇へ walk」 for a crystal that no longer stood.
 */
function cagedLeft(end: EndView | null): number | null {
  const list = end?.crystals.list ?? [];
  const left = end?.crystals.remaining ?? list.length;
  return list.length > 0 && list.length >= left && list.every(crystal => crystal.caged === true) ? list.length : null;
}

/** The drop under the feet (m) from which she is taken to be aloft (on a pillar's top or a bridge in the air): the bow-less line then starts from the ground, not from the feet. */
export const ALOFT_FROM_METRES = 10;
export const aloftBy = (end: EndView | null): number | null => {
  const drop = end?.drop;
  return typeof drop === 'number' && Number.isFinite(drop) && drop >= ALOFT_FROM_METRES ? drop : null;
};

/**
 * Aloft (the drop under her feet is 10 m or more): the ways down and what each costs are the descent line (`descentLine`); this says what the bow-less line's plan is from here.
 * A crystal's pillar was crossed on a bridge laid in the air from the top of another until the blocks ran out, and she stood on a one-wide foothold 40 high for four minutes.
 */
function aloftLine(end: EndView | null, drop: number, target: EndCrystal | null, name: string | null, phase: number | null): string {
  const ground = end?.feet ? Math.round(end.feet.y - drop) : null;
  const rise = target && ground !== null ? Math.round(target.position.y - ground) - 2 : null;
  const dragon = phase === 1 || phase === 8 ? `竜は${phase === 1 ? '火の玉を狙う' : '体当たりの'} phase ${phase}: 高所の橋で渡ることも、登ることと同じ（火の玉の線に立つ）。` : '';
  const then = name && rise !== null && rise > 0 ? `降りた後に ${name} の柱を登るなら、地面から約 ${rise} 段。` : '';
  return `今は宙・塔の上（地面まで ${drop} m）。降りる手は費用つきで「高所:」の行に並べた。${dragon}`
    + `高さのまま橋で渡ると置く物が尽き宙に残る。次の柱へ短く渡るのは、置ける足場の行の往復分が足りる時だけ。${then}`;
}

/** The ground the dragon's waiting cells stand on (the lowest of them): an estimate of the island's floor when no footing line measured it. */
const waitGround = (end: EndView | null): number | null => {
  const ys = (end?.dragon?.approach?.wait ?? []).map(spot => spot.y).filter(y => Number.isFinite(y));
  return ys.length ? Math.floor(Math.min(...ys)) : null;
};

/** The numbers of the jump: the run's greatest fall that the bucket took, the lab's, and the cap of go's maxDrop. */
export const FALL_SEEN_METRES = 25;
export const FALL_LAB_METRES = 90;
export const MAX_DROP_CAP = 70;
const OBSIDIAN_SECONDS = 9.4, END_STONE_SECONDS = 0.6;

export type HeightBasis = 'measured' | 'remembered' | 'estimated';
/** What the height watch hands to the lines: the End view with its drop filled, and what the head counted of the stay up there. */
export interface HeightView { end: EndView | null; basis: HeightBasis | null; minutes: number | null; hits: number; lost: number; waits: number; sit: string | null }

/** Acts of waiting in a row after which the streak line speaks (one run: about 60 waits on a pillar's top). */
export const WAIT_STREAK = 10;
/**
 * The head's own count of a stay up high (nothing here is the body's): where the ground is (a footing line measured it, or the last measure, or the waiting cells' height), when she
 * went up, what health she lost there between two inputs, the acts of waiting in a row, and the dragon's health across her sits. 11/27: on a nine-wide obsidian top there is no gap, so
 * no footing line, so no drop: the input said nothing of the 39 m for 13 minutes, and a wait was chosen about 60 times until the breath killed her.
 */
export function createHeightWatch() {
  let ground: number | null = null, since: number | null = null, lastHealth: number | null = null, hits = 0, lost = 0, waits = 0;
  let sitting = false, sitFrom: number | null = null, sitLast: number | null = null, sitEnd: { health: number; at: number } | null = null;
  let lastSit: { from: number; to: number } | null = null, regained: { to: number; seconds: number; gain: number } | null = null;
  return {
    /** An act's result: acts made of waits only, in a row. */
    noteActs(kinds: readonly string[]): void {
      waits = kinds.length > 0 && kinds.every(kind => kind === 'wait' || kind === 'sleep') ? waits + 1 : 0;
    },
    view(end: EndView | null, health: number | null, now: number): HeightView {
      const feetY = end?.feet?.y ?? null;
      let drop: number | null = null, basis: HeightBasis | null = null;
      if (feetY !== null) {
        if (typeof end?.drop === 'number' && Number.isFinite(end.drop) && end.drop >= 0) { drop = end.drop; basis = 'measured'; ground = feetY - end.drop; }
        else if (ground !== null && feetY - ground > 0) { drop = Math.round(feetY - ground); basis = 'remembered'; }
        else { const floor = waitGround(end); if (floor !== null && feetY - floor > 0) { drop = Math.round(feetY - floor); basis = 'estimated'; } }
      }
      const aloft = drop !== null && drop >= ALOFT_FROM_METRES;
      if (aloft) since ??= now; else { since = null; hits = 0; lost = 0; }
      if (health !== null) {
        if (aloft && lastHealth !== null && health < lastHealth - 0.5) { hits += 1; lost += lastHealth - health; }
        lastHealth = health;
      }
      const dragon = end?.dragon ?? null, dh = dragon?.health ?? null, sits = dragon?.phase !== null && dragon?.phase !== undefined && SITTING.has(dragon.phase);
      if (dh !== null) {
        if (sits && !sitting) { sitFrom = dh; if (sitEnd) regained = { to: dh, seconds: Math.round((now - sitEnd.at) / 1000), gain: Math.round(dh - sitEnd.health) }; }
        if (sits) sitLast = dh;
        if (!sits && sitting && sitFrom !== null && sitLast !== null) { lastSit = { from: sitFrom, to: sitLast }; sitEnd = { health: sitLast, at: now }; }
        sitting = sits;
      }
      const sit = lastSit ? `前の座りで竜 ${round(lastSit.from)}→${round(lastSit.to)}（傷 ${round(lastSit.from - lastSit.to)}）`
        + (regained ? `、次の座りの手前では ${round(regained.to)}（${regained.seconds} 秒で ${regained.gain >= 0 ? '+' : ''}${regained.gain}）` : '（次の座りの手前の体力は、その座りで分かる）') : null;
      const minutes = aloft && since !== null ? Math.round((now - since) / 6000) / 10 : null;
      return { end: end && drop !== null ? { ...end, drop } : end, basis, minutes, hits, lost: Math.round(lost * 10) / 10, waits, sit };
    },
  };
}

/** What the descent line reads of her pack and the block she stands on (from the frame; the body does not say which slot the bucket is in). */
export interface HeightCtx { under: string | null; underSymbol: string | null; top: number | null; bucket: boolean; pickaxe: { name: string; left: number; max: number } | null }
export function heightCtxOf(world: Rec, counts: ReadonlyMap<string, number>): HeightCtx {
  const map = typeof world.localMap === 'string' ? readLayers(world.localMap) : null;
  const layer = map?.layers.get(map.feet.y - 1);
  const symbol = map && layer ? layer.get(`${map.feet.x},${map.feet.z}`) ?? null : null;
  const top = layer ? [...layer.values()].filter(cell => blocked(cell)).length : null;
  const picks = (Array.isArray(world.inventory) ? world.inventory : []).flatMap(raw => {
    const item = rec(raw), durability = rec(item?.durability), left = Number(durability?.left), max = Number(durability?.max);
    const name = String(item?.name ?? '').replace(/^minecraft:/u, '');
    return item && /_pickaxe$/u.test(name) && Number.isFinite(left) && Number.isFinite(max) ? [{ name, left, max }] : [];
  });
  const fit = picks.filter(pick => symbol !== 'O' || /^(?:diamond|netherite)_pickaxe$/u.test(pick.name)).sort((a, b) => b.left - a.left);
  return { under: symbol ? NAMES[symbol] ?? null : null, underSymbol: symbol, top, bucket: (counts.get('water_bucket') ?? 0) > 0, pickaxe: fit[0] ?? null };
}

/**
 * The height line (11/27): every time she stands on a top 10 m or more over the ground (a pillar, a bridge, a ledge or the natural obsidian top), where the ground is and the ways down with what each costs
 * in one sentence. Facts: none of the three is chosen for her and the jump is not said to be the last hand. The jump's numbers are what was measured: the run's greatest fall that the bucket took
 * (the whole fall from the highest point to the ground, the water poured about 4 m before it; no damage) and the lab's.
 */
export function descentLine(end: EndView | null, view: Pick<HeightView, 'basis' | 'minutes' | 'hits' | 'lost'> | null, ctx: HeightCtx | null): string | null {
  const drop = aloftBy(end);
  if (drop === null || !end?.feet) return null;
  const standY = Math.round(end.feet.y), ground = standY - drop;
  const basis = view?.basis === 'estimated' ? '待ち場の高さからの見積もり' : view?.basis === 'remembered' ? '前に測った地面' : '足場の測定';
  const wide = ctx?.top !== null && ctx?.top !== undefined && ctx.top >= 9 ? `（幅の広い天辺。地図の範囲で ${ctx.top} マス以上）` : '';
  const head = `高所: 足の下は y=${standY - 1}${ctx?.under ? ` の${ctx.under}` : ''}${wide}、地面は約 y=${ground}（${basis}）で ${drop} 段`;
  const stay = view?.minutes !== null && view?.minutes !== undefined && (view.minutes >= 0.5 || view.hits > 0)
    ? `。ここに ${view.minutes} 分居て、体力が減った回数 ${view.hits}・合計 ${view.lost}（入力と入力の間で数えた）` : '';
  const cap = Math.min(MAX_DROP_CAP, drop + 3);
  const cell = [...(end.dragon?.approach?.wait ?? [])].sort((x, y) => (x.walkMeters ?? Infinity) - (y.walkMeters ?? Infinity))[0];
  const target = cell ? `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)} range=3` : '<地面の足場> range=3';
  const fall = ctx?.bucket
    ? `(a) 飛び降り＝go ${target} maxDrop=${cap}（待ち場の候補か地面の足場へ。水バケツが手か hotbar に無ければ、先に同じ act の頭に equip water_bucket）。体が落ちる途中、地面の約 4m 手前で床へ水を置いて着水する（約 3 秒）。`
      + `着水の実績: 実走 3 回（総落差 ${FALL_SEEN_METRES}・17・13m）はすべて被害 0、ラボは垂直 10・25・${FALL_LAB_METRES}m を各 1 回で成功。今の ${drop}m はラボの範囲内で、実走ではこの高さは未経験。`
      + `水で止められなかった時（水を置けない・外れ。実績は 0 回）は約 ${Math.max(0, drop - 3)} の被害で、20 を超えると即死。条件: 真下が固い床・体力が十分。火の玉が飛んでいる入力（「火の玉:」の行がある間）と、息の雲が足元にある入力では出さず、行が無い次の入力で出す（竜が phase 1 のままでも、玉が飛んでいない入力は続く）`
    : '(a) 飛び降り＝水バケツが荷に無いので水で止められない（20 ブロックで被害 17、それ以上は死ぬ）';
  const steps = Math.max(1, drop - 1), obsidian = ctx?.underSymbol === 'O';
  const seconds = obsidian ? Math.round(steps * OBSIDIAN_SECONDS) : ctx?.underSymbol === 'E' ? Math.round(steps * END_STONE_SECONDS) : null;
  const dig = ctx?.underSymbol ? (DIG_NAMES[ctx.underSymbol] ?? []).join(',') : '';
  const pick = ctx?.pickaxe ? `つるはし ${ctx.pickaxe.name} 残り ${ctx.pickaxe.left}/${ctx.pickaxe.max}` : '使えるつるはしが無い';
  const short = obsidian && (ctx?.pickaxe?.left ?? 0) < steps;
  const shaft = `(b) 掘って降りる＝vertical down shaft y=${ground}${dig ? ` dig=${dig}` : ''} liquid=stop で ${steps} 段${seconds !== null ? `・約 ${seconds} 秒` : ''}（${pick}`
    + `${short ? `。黒曜石は 1 段 1 使いで足りない（必要 ${steps}・残り ${ctx?.pickaxe?.left ?? 0}）` : ''}）。ダイヤの残りは黒曜石用だが、降りる・逃げる命が先: 降りるのに使ってよい`;
  const wait = `(c) 待つ＝高所に長居した実走 2 回はどちらも死んだ（落下 1・息の雲 1）。今回はここに ${view?.minutes ?? 0} 分居て、体力が ${view?.hits ?? 0} 回減り合計 ${view?.lost ?? 0}。この天辺にも火の玉と息の雲は来て、雲の中から歩いて出る道が無い時がある。ここからは座りに間に合わず剣もベッドも届かない`;
  return `${head}${stay}。降りる手と費用: ${fall}／${shaft}／${wait}`;
}

/** After ten waits in a row: the reason and the cost of waiting in one line, so the earlier reasons are not copied. */
export function waitStreakLine(view: Pick<HeightView, 'minutes' | 'hits' | 'lost' | 'waits'> | null, aloft: boolean): string | null {
  if (!view || view.waits < WAIT_STREAK) return null;
  return `待つ手が ${view.waits} 回続いている${aloft ? `（高所に ${view.minutes ?? 0} 分・体力が減った回数 ${view.hits}・合計 ${view.lost}）` : ''}。`
    + '前の判断に書いた待つ理由を写さず、今の入力（足の高さ・体力・竜の位置・降りる手の費用）から理由と費用を書き直す。待つ手を続けるなら、何が変わるのを待つのかを why に書く';
}

/**
 * 11/27 (the bow and arrows are made on the way): the arrows against the crystals that need one each, as one line of facts ahead of the shooting places. An arrow breaks an uncaged
 * crystal in one shot; what the arrows do not cover is the climb. Null: the arrows or the crystals are not counted, or no uncaged crystal is left.
 */
export function arrowBudgetLine(end: EndView | null, arrows: number | null): string | null {
  const left = end?.crystals.remaining;
  if (arrows === null || left === null || left === undefined) return null;
  const open = left - (end?.crystals.caged ?? 0);
  if (open <= 0) return null;
  return `檻なしの結晶 ${open} 本・矢 ${arrows} 本（1 本 1 発で壊れる）。${arrows < open ? `矢が ${open - arrows} 本足りない分は柱を登る形になる` : '矢は結晶の数に足りている'}`;
}

/** The iron bars the body names for a caged crystal (`blockedBy`): " (iron_bars x,y,z)", or "" when none is named. */
function barsOf(end: EndView | null, id: number | null): string {
  const block = (end?.crystals.openings ?? []).find(opening => id !== null && opening.id === id)?.blockedBy ?? null;
  return block ? ` (${[block.name, place(block)].filter(Boolean).join(' ')})` : '';
}

/** The caged crystal whose pillar she stands on (within 3.5 m across and at most 8 m under its top): the climb there ends with the bars and the strike. */
function cageAtFeet(end: EndView | null): EndCrystal | null {
  const feet = end?.feet;
  if (!feet) return null;
  return (end?.crystals.list ?? []).find(crystal => crystal.caged === true
    && Math.hypot(crystal.position.x - feet.x, crystal.position.z - feet.z) <= 3.5 && feet.y >= crystal.position.y - 8 && feet.y <= crystal.position.y + 2) ?? null;
}

/**
 * The caged crystals (11/27, the owner's rule: every crystal goes down before the dragon, caged ones too). One crystal left heals her 2 a second, the same as ten (vanilla 1.21.11), so a sit's
 * bed damage (121 at most) is gone by the next sit. The way is the uncaged climb with the bars dug between the climb and the strike. What is measured: the climb 2.5-6.5 min (uncaged, run 13), the jump
 * down passed in run 16, and the bars not yet dug in any run (the isolated lab: 2 of 2). No walking to a pillar while she is about to sit is for the phase rules of the line this is joined to.
 */
function cagedWords(end: EndView | null, caged: number, sit: string | null): string {
  const list = (end?.crystals.list ?? []).filter(crystal => crystal.caged === true);
  const feetY = end?.feet?.y ?? null, drop = typeof end?.drop === 'number' ? end.drop : 0;
  const ground = feetY === null ? null : Math.round(feetY - drop);
  const names = list.slice(0, 2).map(crystal => {
    const rise = ground === null ? null : Math.max(0, Math.round(crystal.position.y - ground) - 2);
    return `${crystal.id === null ? '' : `#${crystal.id} `}${place(crystal.position)}${rise === null ? '' : `（地面から約 ${rise} 段・材料 ${rise + 3} 個）`}${barsOf(end, crystal.id)}`;
  }).join('・');
  return `檻つき ${caged} 本${names ? `: ${names}` : ''}。壊す理由: 1 本でも残ると竜は毎秒 2 回復し（本数に比例しない）、ベッドの傷が次の座りまでに戻る`
    + `。登り方: 檻なしと同じ柱で、${'格子ごしにそのまま殴る（格子は掘らない。格子の壁が爆風をほぼ遮るので損は 0〜1。掘って覆わずに殴ると爆風が直に来て 7 回中 7 回死んだ）'}。attack が blast_unsafe で断られた時だけ、dig at=[格子 2 マス] collect=false → place block=obsidian で同じ 2 マスを覆う → attack。実測: 柱を登って殴るのは 2.5〜6.5 分（檻なし）、格子ごしの殴りは隔離ラボで 8/8（1 本約 30 秒）、飛び降りは 16 回目に通った`
    + `${sit ? `。${sit}` : ''}`;
}

export function noBowLine(end: EndView | null, sit: string | null = null): string {
  const head = 'クリスタルの射点: 弓か矢が無いので射点は使わない（結晶は柱の脇を積んで登って殴る）';
  const dragon = end?.dragon ?? null;
  const phase = dragon?.phase ?? null;
  const far = dragon?.distance ?? null;
  const target = climbTarget(end);
  const name = target ? `${target.id === null ? '' : `#${target.id} `}${place(target.position)}${target.distance === null ? '' : ` 自分から ${metres(target.distance)}`}` : null;
  const rise = target && end?.feet ? Math.round(target.position.y - end.feet.y) - 2 : null;
  // e04e (11/9): 17 minutes for two crystals, the climb, the strike and the way down each its own decision. One decision now queues all four.
  const chain = '。この 4 手は 1 つの判断の hands に続けて並べ、stopIf は hpBelow だけ（hostileWithin を付けると周りのエンダーマンで止まる）。列に待ちが走っていても、この手を足す（足した手は待ちの後ろに付く）';
  const cagedTarget = target?.caged === true;
  const kind = cagedTarget ? '檻つき' : '檻なし';
  const bars = '';
  const hit = cagedTarget ? '（格子ごしにそのまま。格子は掘らない）' : '';
  const climb = name
    ? `${kind}で竜から遠く低い ${name} の柱の脇へ walk → vertical pillar up で${cagedTarget ? '結晶と同じ高さ' : '上端の 1〜2 段下'}まで${rise !== null && rise > 0 ? `（約 ${rise} 段）` : ''}${bars} → attack target=end_crystal${hit} → すぐ vertical down shaft で降りる${chain}`
    : `${kind}の結晶の柱の脇へ walk → vertical pillar up${bars} → 結晶と同じ高さから attack${hit} → すぐ vertical down shaft で降りる${chain}`;
  const foot = name ? `${name} の柱の根` : `${kind}の結晶の柱の根`;
  // Caged crystals count too (11/27): named whenever one stands, as the reason and the measures; the climb itself is the line's own.
  const cagedCount = end?.crystals.list.filter(crystal => crystal.caged === true).length ?? 0;
  const cagedNote = cagedLeft(end) !== null ? `。${cagedWords(end, cagedLeft(end)!, sit)}` : cagedCount > 0 ? `。檻つき ${cagedCount} 本も全部壊す（檻なしの後で、結晶と同じ高さまで登って格子ごしに殴る。格子は掘らない）` : '';
  const tail = `${cagedNote}。柱の上で黒曜石を掘って材料にしない`;
  if (phase === 9) return `${head}${tail}`;
  // 11/27: the aloft words come before the climb words (from a pillar's top the head waited 13 minutes with no word of the height).
  const aloft = aloftBy(end);
  if (aloft !== null) {
    const atCage = cageAtFeet(end);
    if (atCage) return `${head}。今は檻つき ${atCage.id === null ? '' : `#${atCage.id} `}の柱の上（結晶の ${Math.max(0, Math.round(atCage.position.y - (end?.feet?.y ?? atCage.position.y)))} 段下）: 結晶と同じ高さまで積んで attack target=end_crystal（格子ごしにそのまま。格子は掘らない）→ すぐ降りる（降りる手と費用は「高所:」の行）。blast_unsafe で断られた時だけ dig at=[格子${barsOf(end, atCage.id) || '（行の格子の座標）'}] collect=false → place block=obsidian で覆い直してから attack。降りないで待たない${tail}`;
    return `${head}。${aloftLine(end, aloft, target, name, phase)}${tail}`;
  }
  if (phase === 1 || phase === 8) {
    return `${head}。今は登らない（竜は${phase === 1 ? '火の玉を狙う' : '体当たりの'} phase ${phase}。高所の橋で渡ることも同じ: 火の玉の線に立つ）: ${foot}へ寄って待ち、phase が変わり 30m 以上離れたらすぐ登る${tail}`;
  }
  if (phase !== null && phase >= 3 && phase <= 7) return `${head}。今登れる（竜は止まり木。計画の節がベッドや待ちでも、結晶が残る間はこれが先）: ${climb}${tail}`;
  if (far === null || far >= CLIMB_CLEAR_METRES) {
    const why = far === null ? '竜が見えない' : `竜は phase ${phase ?? '?'} で自分から ${metres(far)}、30m 以上`;
    return `${head}。今登れる（${why}。座りや 60m を待たない。計画の節がベッドや待ちでも、結晶が残る間はこれが先）: ${climb}${tail}`;
  }
  return `${head}。まだ登らない（竜が自分から ${metres(far)}、30m 未満）: ${foot}へ寄り、30m 以上になったらすぐ登る${tail}`;
}

/** Whether the no-bow line says 「今登れる」 now (the same tests as `noBowLine`). */
export function climbNow(end: EndView | null): boolean {
  const phase = end?.dragon?.phase ?? null, far = end?.dragon?.distance ?? null;
  if (phase === 9 || phase === 1 || phase === 8 || aloftBy(end) !== null) return false;
  return (phase !== null && phase >= 3 && phase <= 7) || far === null || far >= CLIMB_CLEAR_METRES;
}

/** How long 「今登れる」 may stand with the feet not rising before the stall line speaks. */
export const CLIMB_STALL_MS = 40_000;
/** The rise of the feet that counts as climbing (a pillar block is one). */
const CLIMB_RISE = 3;

/**
 * The history's anchor (e04e 0046, 0/4 of the replays climbed after the line said 「今登れる」): once the head has written its wait's
 * reason several times, its queue still holds `wait` hands and its own rule (「座りか 60m 以上だけ」) beats the present line. When the
 * no-bow line has said 「今登れる」 for `CLIMB_STALL_MS` with crystals left and the feet have not risen `CLIMB_RISE`, one line says the
 * queued waits and the earlier reasons are spent. It starts over when the line stops saying it, the feet rise, or a crystal falls.
 */
export function createClimbWatch() {
  let since: number | null = null, baseY = 0, gone: number | null = null;
  return {
    line(end: EndView | null, shooting: boolean | null, now: number): string | null {
      const feet = end?.feet ?? null, left = end?.crystals.remaining ?? end?.crystals.list.length ?? 0;
      const goneNow = end?.crystals.gone ?? null;
      if (shooting !== false || !feet || left <= 0 || !climbNow(end) || feet.y - baseY >= CLIMB_RISE || (since !== null && goneNow !== gone)) {
        since = shooting === false && feet && left > 0 && climbNow(end) ? now : null;
        baseY = feet?.y ?? 0;
        gone = goneNow;
        return null;
      }
      if (since === null) { since = now; baseY = feet.y; gone = goneNow; return null; }
      const seconds = Math.round((now - since) / 1000);
      return now - since < CLIMB_STALL_MS ? null
        : `登りの止まり: 「今登れる」が ${seconds} 秒続き、足の高さは変わっていない。前の判断で並べた wait は replace で全部捨て、`
          + '前に書いた待つ理由や「座りか 60m 以上だけ」のような自分の決まりはもう当てはまらない。この判断で上の柱の行の手を並べて登る';
    },
  };
}

/** At most six existing fight lines, plus one basin line for normal decisions. Join hazards when the existing observations need the room. */
export function endFightLines(end: EndView | null, bedItem: string | null = null, shooting: boolean | null = null, arrows: number | null = null, height: { lead: readonly string[]; sit: string | null } | null = null): string[] {
  // e03 (11/9): with no bow the shooting places still named the perch "(1,62,1) から 4 基", and the head kept waiting there until a fireball's cloud killed it.
  const shots = shooting === false ? (end?.crystals.openings || end?.crystals.shootSets ? [noBowLine(end, height?.sit ?? null)] : []) : [crystalOpeningLine(end), crystalShootSetsLine(end)];
  const cagedOnly = shooting !== false && aloftBy(end) === null && cagedLeft(end) !== null ? [`クリスタルの射点: ${cagedWords(end, cagedLeft(end)!, height?.sit ?? null)}`] : [];
  const lines = [...(height?.lead ?? []), dragonLine(end), crystalLine(end), arrowBudgetLine(end, arrows), ...shots, ...cagedOnly].filter((line): line is string => line !== null);
  const positions = dragonApproachLine(end) ?? perchLine(end);
  const hazards = [breathLine(end), fireballLine(end)].filter((line): line is string => line !== null);
  if (lines.length + hazards.length + (positions ? 1 : 0) > 6) lines.push(hazards.join('・'));
  else lines.push(...hazards);
  if (positions) lines.push(positions);
  const bedHand = dragonBedLine(end, bedItem), basin = dragonBasinLine(end);
  if (bedHand) lines.push(bedHand);
  // With no bed hand (no bed held, or no cell to set one) the sword from the basin is the hand left: the act stands beside the footing, as section T's ②③.
  if (basin) lines.push(bedHand || (end?.crystals.remaining ?? 0) > 0 ? basin : `${basin}（ベッドの手が出ない間は剣の手: この行の先頭の足場へ go range=0.5 seconds=12 → 剣を持って attack target=ender_dragon seconds=30 onFail="continue" → 待ち場へ go。この足場から届くのは主に首・胴（傷は 1/4＋1）で、座りの間打ち続けて削る形: 頭の下へは寄らない。途中で竜が飛び立ったら replace で待ち場へ go（窪みに残らない））`);
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

/** 「ポータル 34m 北東 (12,63,-40) ↔overworld(100,64,-300)」: the body's remembered places the way to the dragon uses. With the frames remembered, beds
 * carried and no respawn bed among them, it says so and what leaving one does to the fight's count (`fightBeds` is `END_BEDS`; the gate counts the pack). */
export function placeLine(world: Rec, beds = 0, fightBeds = 8): string | null {
  const places = rec(world.rememberedPlaces);
  const said = (kind: string) => { const line = places?.[kind]; return typeof line === 'string' && line.trim() ? line.trim().slice(0, 90) : null; };
  const lines = PLACE_LABELS.flatMap(([kind, label]) => said(kind) ? [`${label} ${said(kind)}`] : []);
  if (beds > 0 && dimensionOf(world.dimension) === 'overworld' && said('end_portal_frame') && !said('respawn')) lines.push('リスポーン地点 未設定（枠の近くに bed を place→use して'
    + `残すと、エンドで死んでもここへ戻れる。置くと荷のベッドは ${beds}→${beds - 1}、戦い用の必須は ${fightBeds}）`);
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
