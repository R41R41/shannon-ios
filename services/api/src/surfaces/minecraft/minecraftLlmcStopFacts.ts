import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { handContinuesOnFail, type ActHand, type ActHandLine, type ActPos, type ActResult } from '../../contracts/minecraftActContract.js';
import { mapSolid, readMap, type Drawn } from './minecraftLlmcFooting.js';
import { finite, plain, posText } from './minecraftLlmcProbeInput.js';
import { sightLineText } from './minecraftLlmcSightLine.js';
import { nearThreats } from './minecraftLlmcThreat.js';

/**
 * mb-llmc r10 (H3; run 34, 2026-10-22: of 50 acts 24 stopped — 一歩ではない 9, 見られる 8, 届かない 5 (+1 attack), 置けない 2 — each one asking for
 * the next decision, 48% of the calls at 6.2 a minute). A stopped hand's line is cut at 160 characters by the body and says the closed word and
 * the block the hand stopped at, but leaves out what the next decision needed. Each fact below is said from the result's own fields (`where`,
 * `at`, the hand it asked, the map after the act, the frame's hostiles) and was checked against the 29 stopped acts of the run
 * (`minecraftLlmcR10.test.ts` holds them):
 *
 * - 届かない (dig, 5 stops, all at 5.0–5.1 m; the cells dug before at 4.1 m or less): a dig does not walk, it reaches about 4.5 m from where she
 *   stands. The cell to walk to is the foot of the last column dug whole, and the cells that are left.
 * - 一歩ではない, 頭の高さが固い (walk, 5 stops, three of them the same cell): which of the step's two cells (foot, head) the map says is solid —
 *   the foot was open in four of five, the head cell alone was the wall — and that a walk never digs.
 * - 一歩ではない, 段差 (1): both cells of the rise are walls, not the lower one alone; 立てない (3): the filled cell to dig, or the floor to place.
 * - 見られる (dig, 8 stops): who would see the opening, from the frame's hostiles, and how far; the body's line holds the first only.
 * - 置けない (place, 2 stops in 6 tries at a bridge): a cell the body says is already filled needs no block (rock stands there); a cell with no
 *   face to put against needs a placed block beside it first; with `onFail: 'continue'` the cells after it were tried, which the cut line cannot say.
 * - 届かない (attack hold, 1 stop: 8.4 s standing against a piglin 6.4 m away): a hold never chases; the shooter's line is said (the urgent line's cell).
 * Facts only; what to do is the decision's, with the knowledge's words.
 */
/** How far a dig reaches from where she stands (the measured: dug up to 4.1 m, stopped at 5.0 m, run 34). */
export const DIG_REACH_METERS = 4.5;
const EYE = 1.62;
const same = (left: ActPos, right: ActPos) => left.x === right.x && left.y === right.y && left.z === right.z;
const meters = (from: ActPos, cell: ActPos) => Math.hypot(cell.x - from.x, cell.y + 0.5 - (from.y + EYE), cell.z - from.z);
const ONE = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
const cellsIn = (text: string): ActPos[] => [...text.matchAll(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/gu)]
  .map(match => ({ x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) }));
const listText = (cells: readonly ActPos[], most = 6) =>
  `${cells.slice(0, most).map(posText).join('・')}${cells.length > most ? `ほか${cells.length - most}` : ''}`;

/** The direction words of a cell against her feet, as the body writes them (「東11・北1・上10」). */
function relative(from: ActPos, cell: ActPos): string {
  const parts: string[] = [];
  if (cell.x !== from.x) parts.push(`${cell.x > from.x ? '東' : '西'}${Math.abs(cell.x - from.x)}`);
  if (cell.z !== from.z) parts.push(`${cell.z > from.z ? '南' : '北'}${Math.abs(cell.z - from.z)}`);
  if (cell.y !== from.y) parts.push(`${cell.y > from.y ? '上' : '下'}${Math.abs(cell.y - from.y)}`);
  return parts.join('・') || '同じマス';
}

/** 届かない: the cell and how far, the cell to walk to (the foot of the last column dug whole) and the dig cells that are left. */
function reachFact(line: ActHandLine, hand: ActHand, at: ActPos): string | null {
  if (hand.do !== 'dig' || !line.where || !/^届かない/u.test(line.line)) return null;
  const stop = line.where, distance = meters(at, stop);
  const list = hand.at ?? [], index = list.findIndex(cell => same(cell, stop));
  const base = `止まった所 ${posText(stop)} は止まった時の足 ${posText(at)} から ${ONE(distance)}m（dig は歩かず、足の場所から約 ${DIG_REACH_METERS}m までしか届かない）`;
  // The column of the cell it stopped at is not dug whole (a column is its foot and its head, dug one after the other).
  const dug = (index > 0 ? list.slice(0, index) : []).filter(cell => !(cell.x === stop.x && cell.z === stop.z));
  const last = dug[dug.length - 1];
  if (!last) return `${base}。先に walk で ${posText(stop)} の 4m 手前まで寄る`;
  const foot = Math.min(...dug.filter(cell => cell.x === last.x && cell.z === last.z).map(cell => cell.y));
  const left = list.slice(index);
  return `${base}。続きは walk で ${posText({ x: last.x, y: foot, z: last.z })}（最後に掘り終えた列の足のマス）へ進んでから dig（残り ${left.length} マス: ${listText(left)}）`;
}

/** The solid cells of the next two steps along a level way (foot and head), by the map; a cell the map does not show counts as solid. */
function levelAhead(top: ActPos, foot: ActPos, at: ActPos, map: Drawn | null): ActPos[] {
  const step = { x: Math.sign(top.x - at.x), z: Math.sign(top.z - at.z) };
  const ahead: ActPos[] = [];
  for (let n = 1; n < 3; n += 1) {
    for (const cell of [{ x: foot.x + step.x * n, y: foot.y, z: foot.z + step.z * n }, { x: top.x + step.x * n, y: top.y, z: top.z + step.z * n }]) {
      if (mapSolid(map, cell.x, cell.y, cell.z) !== false) ahead.push(cell);
    }
  }
  return ahead;
}

/** 一歩ではない, 頭の高さが固い: which cell of the step the map says is solid (a walk never digs), and the cells ahead when the way is level. */
function headFact(line: ActHandLine, hand: ActHand, at: ActPos, map: Drawn | null): string | null {
  const head = /頭の高さ \((-?\d+),(-?\d+),(-?\d+)\) が (\S+?) で通れない/u.exec(line.line);
  if (hand.do !== 'walk' || !head) return null;
  const top = { x: Number(head[1]), y: Number(head[2]), z: Number(head[3]) }, foot = { ...top, y: top.y - 1 };
  const footSolid = mapSolid(map, foot.x, foot.y, foot.z);
  const footSays = footSolid === true ? '足のマスも固い' : footSolid === false ? `足のマス ${posText(foot)} は空いている` : '足のマスは地図に無い';
  const target = cellsIn(line.line.slice(0, 40))[0] ?? hand.to ?? null;
  const ahead = target !== null && target.y === foot.y ? levelAhead(top, foot, at, map) : [];
  const dig = [...(footSolid === true ? [foot] : []), top, ...ahead];
  return `この 1 歩の頭のマス ${posText(top)} が ${head[4]} で塞がっている（${footSays}）: walk は掘らない。先に dig at [${listText(dig, 6)}] してから walk し直す`
    + `${target ? `。目的地 ${posText(target)} までの途中も岩なら、1 歩ごとに 足と頭の 2 マスを dig して 1 歩 walk を交互に並べる` : ''}`;
}

/** 一歩ではない, 段差: both cells of the rise are walls (a block at her foot's height and one above it), and what makes a way of them. */
function stepFact(line: ActHandLine): string | null {
  const wall = /壁: 段差 (\d+)（\((-?\d+),(-?\d+),(-?\d+)\) ([^\s。]+) と \((-?\d+),(-?\d+),(-?\d+)\) ([^\s。]+)/u.exec(line.line);
  if (!wall) return null;
  const low = { x: Number(wall[2]), y: Number(wall[3]), z: Number(wall[4]) }, high = { x: Number(wall[6]), y: Number(wall[7]), z: Number(wall[8]) };
  return `段差 ${wall[1]}: ${posText(low)} ${wall[5]} と ${posText(high)} ${wall[9]} の 2 マスが壁（walk の上りは 1 段まで）。通るには 2 マスとも dig at で空けて歩く、`
    + 'または手前の足元に place で段を積んで上がる。walk のやり直しでは通れない';
}

/** 一歩ではない, 立てない: what fills the target or lacks under it, and the cell to dig or to floor. */
function standFact(line: ActHandLine, hand: ActHand): string | null {
  const filled = /そのものには立てない（足のマスが (\S+?) で埋まっている/u.exec(line.line);
  const void_ = /そのものには立てない（下 (\d+)( 以上)? マスが空気/u.exec(line.line);
  const target = line.line.match(/^一歩ではない: \((-?\d+),(-?\d+),(-?\d+)\)/u);
  const cell = target ? { x: Number(target[1]), y: Number(target[2]), z: Number(target[3]) } : hand.to ?? null;
  if (hand.do !== 'walk' || !cell || (!filled && !void_)) return null;
  if (filled) return `目的地 ${posText(cell)} は ${filled[1]} で埋まっている: dig at [${posText(cell)}] で空けてから立つか、「立てる隣」へ walk する`;
  const floor = posText({ ...cell, y: cell.y - 1 });
  return `目的地 ${posText(cell)} の下は空気が ${void_![1]}${void_![2] ? ' 以上' : ''} マス: 立つ床が無い。place で床 ${floor} を置いてから立つか、「立てる隣」へ walk する`
    + '（溶岩や深い穴の上なら、岩の中を dig で進む道を考える）';
}

/** 見られる: whom the opening would show, from the frame's hostiles (the body's line holds the first only). */
function seenFact(line: ActHandLine, hand: ActHand, at: ActPos, observation: BodyObservation | null): string | null {
  if (hand.do !== 'dig' || !line.where || !/^見られる/u.test(line.line)) return null;
  const hostiles = nearThreats(observation).filter(item => item.at && item.distance <= 24).slice(0, 4);
  const who = hostiles.map(item => `${item.name}${item.id !== null ? ` #${item.id}` : ''} ${item.distance.toFixed(1)}m（${relative(at, item.at!)}）`);
  const far = hostiles.length > 0 && hostiles.every(item => item.distance >= 10);
  return `開けるマス ${posText(line.where)}（足から ${relative(at, line.where)}）を開けると見られる敵: ${who.length ? who.join('・') : '枠に敵の位置が無い（体の文の先頭だけ）'}`
    + `${far ? '。どれも 10m 以上離れている' : ''}。開けて続けるなら exposeOk:true（種類を絞るなら ["blaze"] など）。避けるなら、敵との間に岩が残る別の段・向きのマスを掘る`;
}

/** 置けない: why the cell it stopped at was not placed (from the body's line), and the cells left when the hand stopped there. */
function placeFact(line: ActHandLine, hand: ActHand): string | null {
  if (hand.do !== 'place' || !/^置けない/u.test(line.line)) return null;
  const cells = hand.at ?? [], where = line.where;
  const filled = where ? new RegExp(`\\(${where.x},${where.y},${where.z}\\)[^。]*は埋まっている`, 'u').test(line.line) : false;
  const support = /支えになる面が無い/u.test(line.line);
  const why = filled ? `${posText(where!)} は既に固いブロックがある（置く必要は無い。壁のためならそのままでよい）。`
    : support ? '空中のマスには支えが要る（6 面とも空気だと置けない）: 先に、固いブロックに接するマス（床なら今立っている足元の隣）から順に置く。' : '';
  // With onFail 'continue' the cells after it were tried too, which the cut line cannot say: only the why is told then.
  const left = where && !handContinuesOnFail(hand) ? cells.slice(Math.max(0, cells.findIndex(cell => same(cell, where)))) : [];
  const rest = left.length ? `この手の置けていないマス: ${listText(left)}` : '';
  return why || rest ? `${why}${rest}` : null;
}

/** 届かない (attack hold): a hold never chases; the shooter's line when it is in sight. */
function holdFact(line: ActHandLine, hand: ActHand, observation: BodyObservation | null): string | null {
  if (hand.do !== 'attack' || hand.hold !== true || !/^届かない/u.test(line.line)) return null;
  const target = (hand.target ?? '').trim(), wanted = /^#(\d+)$/u.exec(target);
  const cell = sightLineText(observation, wanted ? Number(wanted[1]) : null, wanted ? undefined : target.toLowerCase());
  return `attack の hold は目から 3m 以内の相手にだけ当たり、追わない: 立って待つほど撃たれる${cell ? `。${cell}` : ''}`;
}

interface Stopped { line: ActHandLine; hand: ActHand; at: ActPos; map: Drawn | null; observation: BodyObservation | null }
/** The facts, tried in order: the first that has something to say about the stopped hand is its fact. */
const FACTS: ReadonlyArray<(item: Stopped) => string | null> = [
  item => reachFact(item.line, item.hand, item.at), item => headFact(item.line, item.hand, item.at, item.map), item => stepFact(item.line),
  item => standFact(item.line, item.hand), item => seenFact(item.line, item.hand, item.at, item.observation), item => placeFact(item.line, item.hand),
  item => holdFact(item.line, item.hand, item.observation),
];
function factOf(item: Stopped): string | null {
  for (const make of FACTS) {
    const fact = make(item);
    if (fact) return fact;
  }
  return null;
}

/** The facts of an act's stopped hands, one line each at most (the first three), or none. */
export function stopFacts(act: ActResult, input: unknown, observation: BodyObservation | null): string[] {
  const hands = (plain(input)?.hands ?? []) as readonly ActHand[];
  const at = act.at;
  if (act.ok || ![at?.x, at?.y, at?.z].every(value => finite(value) !== null)) return [];
  const map = readMap(act.map ?? (plain(observation?.state.world)?.localMap as string | undefined));
  const stopped = act.lines.filter(line => line.status === 'stopped' || line.status === 'failed');
  return stopped.flatMap(line => {
    const hand = hands[line.i - 1], fact = hand ? factOf({ line, hand, at, map, observation }) : null;
    return fact ? [`頭の補足（${line.i} ${line.do}）: ${fact}`] : [];
  }).slice(0, 3);
}
