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
    return `${id}${cage}撃てる位置 ${place(shot)}${shot.distance === null ? '' : ` 距離 ${tenth(shot.distance)}m`}`;
  });
  const placed = new Set((end?.crystals.openings ?? []).filter(crystal => crystal.caged !== true && crystal.positions.length > 0).map(crystal => crystal.id));
  const unplaced = end?.crystals.openings ? (end.crystals.list ?? []).filter(crystal => crystal.caged !== true && !placed.has(crystal.id)).slice(0, 2)
    .map(crystal => `${crystal.id === null ? '' : `#${crystal.id} `}${place(crystal.position) ?? ''}`.trim()).filter(Boolean) : [];
  const far = unplaced.length ? [`檻なし ${unplaced.join('・')} は今の床から射点なし（64m 以内の開けた床へ近づくと出る）`] : [];
  const all = [...words, ...far];
  return all.length ? `クリスタルの射点: ${all.join('・')}` : null;
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
  const standing = end?.crystals.remaining ?? null;
  if (standing !== null && standing >= 3) return `ベッドの手: 今は使わない（結晶が ${standing} 本残る間は、削った分が周回中に +2 体力/秒で戻る。実走で 173→200 を約 13 秒。ベッドは結晶を残り 2 以下にしてから）`;
  const bed = bedItem ?? 'red_bed', foot = place(offer.foot);
  const build = offer.build.length ? ` → place block=obsidian at=[${offer.build.map(cell => place(cell)).join(',')}]（${offer.build.some(cell => cell.role === 'screen') ? '自分を守る壁' : 'ベッドの下の支え'}）` : '';
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
  return sitting ? `待ち場の候補（竜の向きの横 10〜14m の足場）${cells.length} 件: ${cells.join(' / ')}`
    : `${tooNearPerch(end)}${crystalsFirst(end)}待ち場の候補（次の座りを待つ所、止まり木から 10〜14m）${cells.length} 件: ${cells.join(' / ')}`;
}

/** The waiting line for an urgent decision: only while she flies and the body stands on the perch (e03 11/9: after a fireball's reflex the urgent
 * decision had no waiting line, the head waited 5 s more in the basin and the breath killed it). */
export function dragonWaitUrgentLine(end: EndView | null): string | null {
  const line = dragonWaitLine(end);
  return line && line.startsWith('今いる ') ? line : null;
}

/** While three or more crystals stand she heals between sits, so waiting for the next sit comes after the crystals (e04c 11/9). */
function crystalsFirst(end: EndView | null): string {
  const standing = end?.crystals.remaining ?? null;
  return standing !== null && standing >= 3 ? `結晶が ${standing} 本残る間は待たず、結晶を壊しに行く（座りの傷が周回中に戻るため）。` : '';
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
 * The pillar to climb: uncaged, away from her (the replay of e04e's decision 49 went for a far caged one when the named crystal stood
 * 6 m from her), then the one with the least climbing and walking (a block climbed counts as about 2 m walked).
 */
function climbTarget(end: EndView | null): EndCrystal | null {
  const open = (end?.crystals.list ?? []).filter(crystal => crystal.caged !== true);
  const her = end?.dragon?.position ?? null;
  const fromHer = (crystal: EndCrystal) => her ? Math.hypot(crystal.position.x - her.x, crystal.position.z - her.z) : Infinity;
  const away = open.filter(crystal => fromHer(crystal) >= CLIMB_CLEAR_METRES);
  const feetY = end?.feet?.y ?? null;
  const cost = (crystal: EndCrystal) => (feetY === null ? 0 : crystal.position.y - feetY) + (crystal.distance ?? 0) / 2;
  return [...(away.length ? away : open)].sort((a, b) => cost(a) - cost(b))[0] ?? null;
}

/**
 * How many crystals are left when every one left is caged and in the list (null otherwise). With no uncaged crystal the line said
 * 「檻なしの結晶の柱の脇へ walk → vertical pillar up」 and the climb watch pressed for a climb, though the order (crystals down to 2,
 * then the bed) already puts the two caged ones last.
 */
function cagedLeft(end: EndView | null): number | null {
  const list = end?.crystals.list ?? [];
  const left = end?.crystals.remaining ?? list.length;
  return list.length > 0 && list.length >= left && list.every(crystal => crystal.caged === true) ? list.length : null;
}

export function noBowLine(end: EndView | null): string {
  const head = 'クリスタルの射点: 弓か矢が無いので射点は使わない（結晶は柱の脇を積んで登って殴る）';
  const dragon = end?.dragon ?? null;
  const phase = dragon?.phase ?? null;
  const far = dragon?.distance ?? null;
  const target = climbTarget(end);
  const name = target ? `${target.id === null ? '' : `#${target.id} `}${place(target.position)}${target.distance === null ? '' : ` 自分から ${metres(target.distance)}`}` : null;
  const rise = target && end?.feet ? Math.round(target.position.y - end.feet.y) - 2 : null;
  // e04e (11/9): 17 minutes for two crystals, the climb, the strike and the way down each its own decision. One decision now queues all four.
  const chain = '。この 4 手は 1 つの判断の hands に続けて並べ、stopIf は hpBelow だけ（hostileWithin を付けると周りのエンダーマンで止まる）';
  const climb = name
    ? `檻なしで竜から遠く低い ${name} の柱の脇へ walk → vertical pillar up で上端の 1〜2 段下まで${rise !== null && rise > 0 ? `（約 ${rise} 段）` : ''}→ attack target=end_crystal → すぐ vertical down shaft で降りる${chain}`
    : `檻なしの結晶の柱の脇へ walk → vertical pillar up → 上端の少し下から attack → すぐ vertical down shaft で降りる${chain}`;
  const foot = name ? `${name} の柱の根` : '檻なしの結晶の柱の根';
  const tail = '。檻つきの結晶は後回し。柱の上で黒曜石を掘って材料にしない';
  if (phase === 9) return `${head}${tail}`;
  const caged = cagedLeft(end);
  if (caged !== null && caged <= 2) {
    return `${head}。檻なしの結晶はもう無い（残りは檻つき ${caged} 本）: 檻つきは残したまま竜を倒す。竜が座ったらベッドの手の行、飛んでいる間は待ち場の行の所で次の座りを待つ（柱は登らない）`;
  }
  if (phase === 1 || phase === 8) {
    return `${head}。今は登らない（竜は${phase === 1 ? '火の玉を狙う' : '体当たりの'} phase ${phase}）: ${foot}へ寄って待ち、phase が変わり 30m 以上離れたらすぐ登る${tail}`;
  }
  if (phase !== null && phase >= 3 && phase <= 7) return `${head}。今登れる（竜は止まり木）: ${climb}${tail}`;
  if (far === null || far >= CLIMB_CLEAR_METRES) {
    const why = far === null ? '竜が見えない' : `竜は phase ${phase ?? '?'} で自分から ${metres(far)}、30m 以上`;
    return `${head}。今登れる（${why}。座りや 60m を待たない）: ${climb}${tail}`;
  }
  return `${head}。まだ登らない（竜が自分から ${metres(far)}、30m 未満）: ${foot}へ寄り、30m 以上になったらすぐ登る${tail}`;
}

/** Whether the no-bow line says 「今登れる」 now (the same tests as `noBowLine`). */
export function climbNow(end: EndView | null): boolean {
  const phase = end?.dragon?.phase ?? null, far = end?.dragon?.distance ?? null;
  if (phase === 9 || phase === 1 || phase === 8) return false;
  const caged = cagedLeft(end);
  if (caged !== null && caged <= 2) return false;
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
export function endFightLines(end: EndView | null, bedItem: string | null = null, shooting: boolean | null = null): string[] {
  // e03 (11/9): with no bow the shooting places still named the perch "(1,62,1) から 4 基", and the head kept waiting there until a fireball's cloud killed it.
  const shots = shooting === false ? (end?.crystals.openings || end?.crystals.shootSets ? [noBowLine(end)] : []) : [crystalOpeningLine(end), crystalShootSetsLine(end)];
  const lines = [dragonLine(end), crystalLine(end), ...shots].filter((line): line is string => line !== null);
  const positions = dragonApproachLine(end) ?? perchLine(end);
  const hazards = [breathLine(end), fireballLine(end)].filter((line): line is string => line !== null);
  if (lines.length + hazards.length + (positions ? 1 : 0) > 6) lines.push(hazards.join('・'));
  else lines.push(...hazards);
  if (positions) lines.push(positions);
  const bedHand = dragonBedLine(end, bedItem);
  if (bedHand) lines.push(bedHand);
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
