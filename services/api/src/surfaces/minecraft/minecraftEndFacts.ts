import { framesOf, marksOf } from './minecraftSeenMarks.js';

/**
 * The facts of the way to the dragon, as lines for the live state (a pure reading of the body's frame; nothing is kept here).
 * The body says them in its world fields (`world.dragon`, `world.crystals`, `world.perch`, `world.dragonBreath`, `world.lastDeath`,
 * `world.deaths`, `world.rememberedPlaces`, and the marks of `world.mapLandmarks`); this only puts them in words the decision can use.
 * A field the body does not send is left out of the lines: an absent field is never an absent fact. Where the body sends the older
 * form only (the dragon and the crystals as map marks), that is read instead.
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round = (value: number): number => Math.round(value);
const at = (value: unknown): string | null => {
  const point = rec(value);
  const x = num(point?.x);
  const y = num(point?.y);
  const z = num(point?.z);
  return x === null || y === null || z === null ? null : `(${round(x)},${round(y)},${round(z)})`;
};
const meters = (value: unknown): string => {
  const distance = num(value);
  return distance === null ? '' : `${round(distance)}m`;
};

/** The dragon's phases by the game's numbers (the body sends the number, or the name of the phase). */
export const DRAGON_PHASES: readonly string[] = ['holding_pattern', 'strafe_player', 'landing_approach', 'landing', 'takeoff', 'sitting_flaming',
  'sitting_scanning', 'sitting_attacking', 'charging_player', 'dying', 'hovering'];
const PHASE_WORDS: readonly string[] = ['島の上を周回', '狙いを定めて火の玉', '止まり木へ降りる途中', '止まり木に着陸中', '飛び立つところ', '止まり木で息を吐いている',
  '止まり木で見回している', '止まり木で攻撃している', '体当たり', '倒れかけている', 'その場で浮いている'];
/** The phases in which the dragon sits on the perch and its head is within a sword's reach. */
const SITTING = new Set([5, 6, 7]);

/** A phase as its number, from the number or the phase's name; null when it is neither. */
export function phaseNumber(phase: unknown): number | null {
  if (typeof phase === 'number' && Number.isInteger(phase) && phase >= 0 && phase < DRAGON_PHASES.length) return phase;
  if (typeof phase !== 'string') return null;
  const index = DRAGON_PHASES.indexOf(phase.replace(/^minecraft:/u, '').toLowerCase());
  return index >= 0 ? index : null;
}

/** The dragon from the body's structured field, else from the older map mark (`! エンダードラゴン (x,y,z) … id 5 体力 142/200`). */
function dragonOf(world: Rec): { id: number | null; health: number | null; phase: number | null; position: string | null; head: string | null;
  distance: string; marked: boolean } | null {
  const dragon = rec(world.dragon);
  if (dragon) {
    return { id: num(dragon.id), health: num(dragon.health), phase: phaseNumber(dragon.phase), position: at(dragon.position), head: at(dragon.headPosition),
      distance: meters(dragon.distance), marked: false };
  }
  const mark = marksOf(world.mapLandmarks).find(item => item.label === 'エンダードラゴン');
  if (!mark) return null;
  const health = /体力\s*([\d.]+)\/200/u.exec(mark.rest);
  const id = /id\s*(\d+)/u.exec(mark.rest);
  return { id: id ? Number(id[1]) : null, health: health ? Number(health[1]) : null, phase: null, position: `(${mark.x},${mark.y},${mark.z})`, head: null,
    distance: /(\d+)m/u.exec(mark.rest)?.[0] ?? '', marked: true };
}

/** 「竜: 体力 142/200・止まり木で見回している（phase 6、剣が届く高さ）・頭 (0,66,0)・あなたから 14m」, or null with no dragon in view. */
export function dragonLine(world: Rec): string | null {
  const dragon = dragonOf(world);
  if (!dragon) return null;
  const phase = dragon.phase;
  const state = phase === null ? '' : `${PHASE_WORDS[phase]}（phase ${phase}${SITTING.has(phase) ? '、頭が剣の届く高さ。矢は効かない' : ''}）`;
  const where = dragon.head ? `頭 ${dragon.head}` : dragon.position ? `位置 ${dragon.position}` : '';
  const parts = [dragon.health === null ? '' : `体力 ${dragon.health}/200`, state, where, dragon.distance ? `あなたから ${dragon.distance}` : '',
    dragon.id === null ? '' : `#${dragon.id}`].filter(Boolean);
  return parts.length ? `竜: ${parts.join('・')}` : null;
}

/** 「エンドクリスタル: 残り 4（檻つき 1）。近い順: #12 (x,y,z) 21m・#15 (x,y,z) 34m 檻つき」 from the body's count, else the marks in view. */
export function crystalLine(world: Rec): string | null {
  const crystals = rec(world.crystals);
  const remaining = num(crystals?.remaining);
  if (crystals && remaining !== null) {
    const caged = num(crystals.caged);
    const list = (Array.isArray(crystals.list) ? crystals.list : []).flatMap(item => {
      const crystal = rec(item);
      const place = at(crystal?.position);
      const tag = num(crystal?.id) === null ? '' : `#${crystal?.id} `;
      return crystal && place ? [`${tag}${place} ${meters(crystal.distance)}${crystal.caged === true ? ' 檻つき' : ''}`.trim()] : [];
    }).slice(0, 3);
    return `エンドクリスタル: 残り ${remaining}${caged === null ? '' : `（檻つき ${caged}）`}${list.length ? `。近い順: ${list.join('・')}` : ''}`;
  }
  const seen = marksOf(world.mapLandmarks).filter(item => item.label === 'エンドクリスタル').length;
  return seen ? `エンドクリスタル: 見えている ${seen} 個（島全体の残りは体がまだ数えていない）` : null;
}

/** The breath clouds the body lists (`world.dragonBreath`: x, z, radius), nearest first, at most three. */
export function breathLine(world: Rec): string | null {
  const clouds = (Array.isArray(world.dragonBreath) ? world.dragonBreath : []).flatMap(item => {
    const cloud = rec(item);
    const x = num(cloud?.x);
    const z = num(cloud?.z);
    const radius = num(cloud?.radius);
    return x === null || z === null ? [] : [`(${round(x)},${round(z)}) 半径 ${radius === null ? '?' : round(radius)}`];
  }).slice(0, 3);
  return clouds.length ? `竜の息の雲: ${clouds.join('・')}（中で立ち止まらない）` : null;
}

/** The perch, where the dragon sits (the body's `world.perch`, else its map mark). */
export function perchLine(world: Rec): string | null {
  const place = at(world.perch) ?? (() => {
    const mark = marksOf(world.mapLandmarks).find(item => item.label === '止まり木');
    return mark ? `(${mark.x},${mark.y},${mark.z})` : null;
  })();
  return place ? `止まり木: ${place}` : null;
}

/** All the lines of the fight in the End, the dragon's first. */
export function endFightLines(world: Rec): string[] {
  return [dragonLine(world), crystalLine(world), breathLine(world), perchLine(world)].filter((line): line is string => line !== null);
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
