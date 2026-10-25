import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActHand, ActPos } from '../../contracts/minecraftActContract.js';
import { BODY_RULES, cellKey, mapView, posText, readLayers, SOLID, type BodyRules, type Cell, type MapView } from './minecraftLlmcPreflightMap.js';
import type { ColumnOf } from './minecraftLlmcPreflightStand.js';
import { lookOf, type Look } from './minecraftLlmcSurfaceLook.js';
import { columnKey, keptColumnFact } from './minecraftLlmcFooting.js';
import { keptThreatSight, nearThreats, threatSightKey, type NearThreat } from './minecraftLlmcThreat.js';

/**
 * mb-llmc-cand 規則の守り（改修案 §2.4、Syzygy ADR-0014 D3「決まりはまずコードで守る」）。書き直しの後も Opus が守らなかった規則のうち、
 * コードで確かめられる物を、体へ送る前に止めて事実を返す。手は直さず・足さない。
 *
 * 規則: 敵が見えている（射線の中）時に、落差 4 以上の空所の上へ、壁の無い幅 1 の橋を伸ばさない（実走32 の死: 橋の上で 3 回打たれ、押し出されて
 * 溶岩へ落ちた。再現台の 45 場面で、事実が live にあっても橋を伸ばした答えが 4 つ）。
 *
 * 「壁の無い幅 1 の橋を伸ばす手」= `place` の 1 マス C が、次を全部、地図で確かに満たす時（地図の外・分からない記号が 1 つでもあれば止めない）:
 * 1. C は今、空気で、C の水平の隣のうち固い物（地図の固い記号、または同じ act の前の手が置く・掘って空ける物の写し）はちょうど 1 つ（橋を伸ばしてきた側。
 *    隣が 2 つ以上固い・1 つも固くない所は、穴埋めか宙で、橋の延長とは言い切れない）。
 * 2. C の真下 4 段（C.y−1 … C.y−4）が全部空気（落差 4 以上）。
 * 3. 伸ばす向きの左右（その隣と反対の軸の 2 マス）の、床の高さ（C.y）と足の高さ（C.y+1）の 4 マスが全部空気で、この act が後で置くマスでもない
 *    （両脇の壁は、橋の手と同じ act で置かれる）。
 * 4. 敵が見えている（`seenThreats`）。
 * 手の順に、dig が空ける・place が埋めるマスを写しながら見る。`rel: true` の手が来たら、その先は足の場所が分からないので見ない。
 */
const FALL_MIN = 4;
const DEEPEST = 64;
const NEAR_METERS = 24;

/** 見えている敵 1 体: 名前（id つき）、足から見た向きの文、距離。 */
export interface SeenThreat { label: string; distance: number; rel: string }
export interface RuleStop {
  /** 1 始まり。結果の行の手の番号と同じ。 */
  hand: number;
  kind: 'place';
  /** 閉じた語。 */
  word: '壁の無い橋';
  code: 'bare_bridge';
  cell: ActPos;
  why: string;
}
export interface RuleWorld { map: string | undefined; feet: ActPos | null; column?: ColumnOf; rules?: BodyRules }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const cellOf = (value: unknown): Cell | null => {
  const at = value as Record<string, unknown> | null;
  return at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null;
};
const isSolid = (symbol: string | undefined): boolean => symbol !== undefined && SOLID.has(symbol);
const isOpen = (look: Look, x: number, y: number, z: number): boolean => look(x, y, z).kind === 'open';

/** C の真下の空気の続き: 段数と、その下の記号（分からない所は undefined）。 */
function fallBelow(look: Look, cell: Cell): { n: number; bottom: string | undefined } {
  for (let n = 0; n < DEEPEST; n += 1) {
    const state = look(cell.x, cell.y - 1 - n, cell.z);
    if (state.kind !== 'open') return { n, bottom: state.kind === 'closed' ? state.symbol : undefined };
  }
  return { n: DEEPEST, bottom: undefined };
}
const bottomWords = (bottom: string | undefined): string => bottom === 'L' || bottom === 'l' ? '、下は溶岩' : bottom === 'w' || bottom === '-' ? '、下は水' : '';
const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** C を橋の延長と言い切れる時の、その軸（x か z の向きの単位）。言い切れなければ null。 */
function bridgeAxis(look: Look, cell: Cell): readonly [number, number] | null {
  const supports = DIRS.filter(([dx, dz]) => isSolid((s => s.kind === 'closed' ? s.symbol : undefined)(look(cell.x + dx, cell.y, cell.z + dz))));
  return supports.length === 1 ? supports[0]! : null;
}

/** 伸ばす向きと直角の左右の、床と足の高さの 4 マスが全部、地図で確かに空気で、この act が置くマスでもない時、両脇の落差の浅い方。そうでなければ null。 */
function openSides(look: Look, cell: Cell, axis: readonly [number, number], planned: ReadonlySet<string>): number | null {
  const across: ReadonlyArray<readonly [number, number]> = axis[0] !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
  let side = DEEPEST;
  for (const [dx, dz] of across) {
    for (const dy of [0, 1]) {
      const at = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
      if (!isOpen(look, at.x, at.y, at.z) || planned.has(cellKey(at))) return null;
    }
    side = Math.min(side, fallBelow(look, { x: cell.x + dx, y: cell.y, z: cell.z + dz }).n);
  }
  return side;
}

type BridgeFacts = { fall: number; bottom: string | undefined; side: number };
/** 橋の延長の C について、落差と両脇の事実。壁の無い幅 1 の橋と言い切れなければ null。 */
function bareBridgeFacts(look: Look, cell: Cell, planned: ReadonlySet<string>): BridgeFacts | null {
  if (!isOpen(look, cell.x, cell.y, cell.z)) return null;
  const axis = bridgeAxis(look, cell);
  if (!axis) return null;
  const fall = fallBelow(look, cell);
  if (fall.n < FALL_MIN) return null;
  const side = openSides(look, cell, axis, planned);
  if (side === null) return null;
  return { fall: fall.n, bottom: fall.bottom, side };
}

const cellsOf = (hand: ActHand): Cell[] => (hand.at ?? []).flatMap(value => {
  const cell = cellOf(value);
  return cell ? [cell] : [];
});
/** この act が置くマス全部（両脇の壁も、橋の手と同じ act に入る）。rel の手があれば null（足の場所が分からない）。 */
function plannedCells(hands: readonly ActHand[]): Set<string> | null {
  const planned = new Set<string>();
  for (const hand of hands) {
    if (hand.rel === true) return null;
    if (hand.do === 'place') for (const cell of cellsOf(hand)) planned.add(cellKey(cell));
  }
  return planned;
}

function bridgeWords(cell: Cell, facts: BridgeFacts, seen: readonly SeenThreat[]): string {
  const first = seen[0]!, more = seen.length > 1 ? `、ほか ${seen.length - 1} 体` : '';
  const exact = facts.bottom !== undefined && facts.fall < DEEPEST;
  const fall = `落差 ${facts.fall}${exact ? bottomWords(facts.bottom) : ' 以上'}`;
  const side = facts.side > 0 ? `・両脇の下も ${facts.side} 段以上が空気` : '';
  return `${first.label} が見えている（${first.rel}、${first.distance.toFixed(1)}m${more}）。置く ${posText(cell)} は足場が幅 1 で、`
    + `両脇（床と足の高さ）は空気で壁が無く、真下は${fall}${side}（壁の無い橋）。橋は壁付き（両脇の足の高さに壁）にするか、トンネルで回る。`
    + '見えている間は橋を伸ばして進まず、先に射線を切る（間にブロックを置く・live の away に立ち位置が出ていればそこへ）か、来た道を戻る';
}

/** 手を順に写す前の用意: 手の一覧、足の場所と合う地図、この act が置くマス。できなければ null。 */
interface Start { hands: ActHand[]; view: MapView; look: Look; planned: Set<string> }
function startOf(input: unknown, world: RuleWorld): Start | null {
  const hands = (input as { hands?: unknown } | null)?.hands;
  const layers = readLayers(world.map, world.rules);
  const feet = world.feet ? cellOf(world.feet) : null;
  if (!Array.isArray(hands) || !layers || !feet) return null;
  // 足と違う場所を描いた地図は、フレームより古い。
  if (feet.x !== layers.feet.x || feet.y !== layers.feet.y || feet.z !== layers.feet.z) return null;
  const planned = plannedCells(hands as ActHand[]);
  if (!planned) return null;
  const view = mapView(layers);
  return { hands: hands as ActHand[], view, look: lookOf(view, world.map, feet, world.column), planned };
}

/** 1 つの手が橋を伸ばすなら、その最初のマスと事実。dig は空けるマスを、place は埋めるマスを写す（false: 手が読めない）。 */
function bridgeInHand(hand: ActHand, start: Start): { cell: Cell; facts: BridgeFacts } | null | false {
  const { view, look, planned } = start;
  if (!hand || typeof hand !== 'object') return false;
  if (hand.do === 'dig') for (const cell of cellsOf(hand)) view.open(cell);
  if (hand.do !== 'place') return null;
  for (const cell of cellsOf(hand)) {
    const facts = bareBridgeFacts(look, cell, planned);
    if (facts) return { cell, facts };
    view.fill(cell);
  }
  return null;
}

/**
 * The first hand of the act that stretches a bare one-wide bridge over a drop of four or more while a hostile sees her, or null (the act goes
 * as it is). `input` is the act as `llmcPrepare` leaves it; `seen`: the hostiles that see her now (`seenThreats`).
 */
export function ruleGuardAct(input: unknown, world: RuleWorld, seen: readonly SeenThreat[]): RuleStop | null {
  const start = seen.length ? startOf(input, world) : null;
  if (!start) return null;
  for (const [index, hand] of start.hands.entries()) {
    const found = bridgeInHand(hand, start);
    if (found === false) return null;
    if (found) return { hand: index + 1, kind: 'place', word: '壁の無い橋', code: 'bare_bridge', cell: found.cell, why: bridgeWords(found.cell, found.facts, seen) };
  }
  return null;
}

const relWords = (from: ActPos, to: ActPos): string => {
  const parts = [[to.x - from.x, '東', '西'], [to.z - from.z, '南', '北'], [to.y - from.y, '上', '下']] as const;
  const words = parts.flatMap(([delta, plus, minus]) => Math.round(delta) === 0 ? [] : [`${delta > 0 ? plus : minus}${Math.abs(Math.round(delta))}`]);
  return words.length ? words.join('・') : '同じマス';
};

/**
 * 体の最新フレームが「見えている」とする敵（近い順）。フレームの `canSee === true`（体が毎フレーム自分で確かめる。16m まで言う）を使う。
 * `canSee` を言わない体（r8 より前）の敵は、頭が持つ体の sight の答え（`keptThreatSight`）が見えるとする物だけ。24m まで。
 * 頭の sight の答えだけでは足りない理由: 答えは急ぎの 8m（止まった後は射手 16m）の敵にしか聞かず、act を送る時には古いことがあるため。
 */
export function seenThreats(observation: BodyObservation | null, taskId: string): SeenThreat[] {
  const world = observation?.state.world as { position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined;
  const at = world?.position, feet = at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
  if (!feet) return [];
  const sees = (threat: NearThreat): boolean => {
    if (threat.canSee === true) return true;
    if (threat.canSee === false || threat.id === null) return false;
    return keptThreatSight(taskId, threatSightKey(threat, feet))?.visible === true;
  };
  return nearThreats(observation).filter(threat => threat.distance <= NEAR_METERS && sees(threat)).map(threat => ({
    label: `${threat.id !== null ? `#${threat.id} ` : ''}${threat.name}`, distance: threat.distance, rel: threat.at ? relWords(feet, threat.at) : '向き不明' }));
}

/** The rule guard against the newest frame of the body (its map, her feet, the hostiles that see her). */
export function ruleGuardOfFrame(input: unknown, frame: BodyObservation | null, taskId: string): RuleStop | null {
  const world = frame?.state.world as { localMap?: unknown; dimension?: unknown; position?: { x?: unknown; y?: unknown; z?: unknown } } | undefined;
  const at = world?.position;
  const feet = at && finite(at.x) && finite(at.y) && finite(at.z) ? { x: at.x, y: at.y, z: at.z } : null;
  const map = typeof world?.localMap === 'string' ? world.localMap : undefined;
  const column = (cell: Cell, feetY: number) => keptColumnFact(taskId)(columnKey(cell, feetY));
  return ruleGuardAct(input, { map, feet, rules: BODY_RULES, column }, seenThreats(frame, taskId));
}
