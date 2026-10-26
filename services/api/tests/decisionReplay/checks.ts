import { llmcPrepare } from '../../src/surfaces/minecraft/minecraftLlmc.js';
import { MC_ACT_TOOL } from '../../src/contracts/minecraftActContract.js';
import { expandShortAct } from '../../src/contracts/minecraftActShortContract.js';
import type { Decision } from './load.js';
import { denormalizeMap } from './liveRebuild.js';

/**
 * 決まった検査（機械で白黒が付く物）。場面ごとのファイル（scenes/*.json）が、これを名前で呼ぶ。
 * 検査は判断の答え（呼んだ道具と mc.act の入力）だけを、その場面の live・地図・直前の止まりに照らして見る。
 * 検査が決められない物（進み具合・作戦の良し悪し）は judge.ts が後知恵つきで採点する。
 */
export type Pos = { x: number; y: number; z: number };
export interface Hand { do: string; to?: Pos; path?: Pos[]; at?: Pos[]; block?: string; item?: string; target?: string; hold?: boolean; exposeOk?: boolean;
  seconds?: number; n?: number; on?: boolean; tool?: string; onFail?: string; [key: string]: unknown }
export interface Answer { /** 部分送りの組（送った前の手 + 聞き直しの答えの手）の、1 つの act の手の数の最大。本番では別々の act なので、手の数の決まりはこちらで見る。 */ partsMax?: number; tool: string | null; input: any; hands: Hand[]; stopIf?: Record<string, number>; accept?: string[]; why?: string; shapeProblem: string | null }

export function answerOf(content: Array<Record<string, any>>): Answer {
  const use = content.find(block => block.type === 'tool_use');
  const tool = use ? String(use.name).replace(/^mc_/, 'mc.').replace(/^plan_/, 'plan.').replace(/^fca_/, 'fca_') : null;
  const act = use && use.name === 'mc_act';
  // 10/26: 実走39（rel52 以降の記録）の本番の mc.act は短い書き方の行（hands が文字）。台は手の JSON で読むので、行を手に戻してから読む。
  const input = act ? (expandShortAct(use?.input ?? {}).input as Record<string, any>) : (use?.input ?? {});
  const prepared = act ? llmcPrepare(MC_ACT_TOOL, input) : null;
  return { tool, input, hands: act && Array.isArray(input.hands) ? input.hands as Hand[] : [], stopIf: act ? input.stopIf : undefined, accept: act ? input.accept : undefined,
    why: typeof input.why === 'string' ? input.why : undefined, shapeProblem: prepared?.problem ?? null };
}

/* ---------------------------------------------------------------- 地図 */
const SOLID = new Set('#:sIicdgroW%PD+FTCBHOnuNMGEQR$XS'.split(''));
const AIR = new Set(['.', ',', '*', '@', '!', 'm', '=', 'h', 't', 'f', 'x']);
export type Grid = Map<string, string>;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
/** 体の地図（layers 方式）を、(x,y,z) → 記号 に直す。読めない所は入れない。 */
export function decodeMap(text: unknown): Grid {
  const grid: Grid = new Map();
  if (typeof text !== 'string') return grid;
  const head = text.split('\n')[0] ?? '';
  const main = /x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+)/.exec(head);
  const lines = text.split('\n');
  let y: number | null = null, x0 = main ? Number(main[1]) : 0, columns = main ? Number(main[2]) - Number(main[1]) + 1 : 0;
  for (const line of lines.slice(1)) {
    const layer = /^y=(-?\d+)(?: x=(-?\d+)\.\.(-?\d+) z=(-?\d+)\.\.(-?\d+))?/.exec(line);
    if (layer) {
      y = Number(layer[1]);
      if (layer[2]) { x0 = Number(layer[2]); columns = Number(layer[3]) - Number(layer[2]) + 1; }
      else if (main) { x0 = Number(main[1]); columns = Number(main[2]) - Number(main[1]) + 1; }
      continue;
    }
    if (line.startsWith('縦') || line.startsWith('z\\x')) { if (line.startsWith('縦')) y = null; continue; }
    const row = /^\s*(-?\d+) (.*)$/.exec(line);
    if (row && y !== null) {
      const symbols = row[2]!.split(' ');
      if (symbols.length !== columns) continue;
      symbols.forEach((symbol, index) => grid.set(key(x0 + index, y!, Number(row[1])), symbol));
    }
  }
  return grid;
}
export const isSolid = (symbol: string | undefined) => symbol !== undefined && SOLID.has(symbol);
export const isAir = (symbol: string | undefined) => symbol !== undefined && AIR.has(symbol);

/* ---------------------------------------------------------------- 場面の文脈 */
export interface Threat { id: string; name: string; meters: number; pos: Pos }
export interface Context {
  decision: Decision; live: Record<string, any>; self: Pos; hp: number; food: number; threats: Threat[]; grid: Grid;
  /** The previous act's stopped hand (from the previous round's call and the result the live carries), if any. */
  stopped: { do: string; reason: string; hand: Hand; cell?: Pos } | null;
  /** 直近の止まり（live.body.stops）で、行き先がはっきりしている物。 */
  recentStops: Array<{ from?: Pos; to: Pos; reason: string; secondsAgo: number }>;
  visible: Array<{ name: string; id: string; meters: number }>;
  urgent: boolean; hasAnswerLine: boolean; inventory: string[];
}
const pos = (text: string): Pos | null => { const m = /\((-?\d+),(-?\d+),(-?\d+)\)/.exec(text); return m ? { x: +m[1]!, y: +m[2]!, z: +m[3]! } : null; };

export function contextOf(decision: Decision): Context {
  const live = decision.live, body = (live.body ?? {}) as Record<string, any>, state = (body.state ?? {}) as Record<string, any>;
  const self = pos(String(state.at ?? '')) ?? { x: 0, y: 0, z: 0 };
  const threats: Threat[] = (Array.isArray(body.threats) ? body.threats : []).flatMap((text: string) => {
    const m = /^#(\d+) (\S+) ([\d.]+)m \((-?\d+),(-?\d+),(-?\d+)\)/.exec(text);
    return m ? [{ id: m[1]!, name: m[2]!, meters: Number(m[3]), pos: { x: +m[4]!, y: +m[5]!, z: +m[6]! } }] : [];
  });
  const visible = (Array.isArray(body.urgent) ? body.urgent : []).flatMap((text: string) => {
    const m = /(?:^|\s)(\S+) #(\d+) ([\d.]+)m・.*見える/.exec(text) ?? /^(\S+) ([\d.]+)m・.*見える/.exec(text);
    return m ? [m.length === 4 ? { name: m[1]!, id: m[2]!, meters: Number(m[3]) } : { name: m[1]!, id: '', meters: Number(m[2]) }] : [];
  });
  const recentStops = (Array.isArray(body.stops) ? body.stops : []).flatMap((text: string) => {
    const m = /^\((-?\d+),(-?\d+),(-?\d+)\)(?:→\((-?\d+),(-?\d+),(-?\d+)\))? (\S+) (\d+)秒前/.exec(text);
    if (!m) return [];
    const from = { x: +m[1]!, y: +m[2]!, z: +m[3]! }, to = m[4] ? { x: +m[4], y: +m[5]!, z: +m[6]! } : from;
    return [{ from: m[4] ? from : undefined, to, reason: m[7]!, secondsAgo: Number(m[8]) }];
  });
  return { decision, live, self, hp: Number(state.health ?? 20), food: Number(state.food ?? 20), threats, grid: decodeMap(typeof body.map === 'string' ? denormalizeMap(body.map) ?? body.map : body.map), stopped: stoppedHand(decision),
    recentStops, visible, urgent: Array.isArray(body.urgent) && body.urgent.length > 0, hasAnswerLine: typeof body.answer === 'string',
    inventory: Array.isArray(body.inventory) ? body.inventory : [] };
}

/** The hand that ended the previous act: the previous round's call and the result the live carries. */
function stoppedHand(decision: Decision): Context['stopped'] {
  const previous = decision.run.rows[decision.index - 1];
  if (!previous) return null;
  const call = previous.entries.flatMap(entry => entry.role === 'assistant' && Array.isArray(entry.content) ? entry.content as Array<Record<string, any>> : [])
    .find(block => block.type === 'tool_use' && block.name === 'mc_act');
  const results = decision.live.body?.lastResults;
  const text = Array.isArray(results) && typeof results[0] === 'string' ? results[0] : decision.run.rows[decision.index - 1]!.entries
    .flatMap(entry => Array.isArray(entry.content) ? entry.content as Array<Record<string, any>> : []).find(block => block.type === 'tool_result')?.content;
  if (!call || typeof text !== 'string') return null;
  const m = /^(\d+) (\w+) (?:止|失) ([^:：\s]+)(.*)$/mu.exec(text);
  // A hand cut off from outside (a reflex, a stopIf, the body's own cancel) was not wrong by itself: nothing to repeat.
  if (!m || /server_cancel|命令が止められた|stopIf|反射/u.test(m[0])) return null;
  const hand = (call.input.hands ?? [])[Number(m[1]) - 1] as Hand | undefined;
  // 止まった所のマス（結果の行に座標があれば）: 手が複数のマスを持つ時、止まったのはそのうちの 1 つだけ（他は済んでいる）。
  const at = ['掘れない', '届かない', '見られる'].includes(m[3]!) ? /\((-?\d+),(-?\d+),(-?\d+)\)/.exec(m[4] ?? '') : null;
  return hand ? { do: m[2]!, reason: m[3]!, hand, ...(at ? { cell: { x: +at[1]!, y: +at[2]!, z: +at[3]! } } : {}) } : null;
}

/* ---------------------------------------------------------------- 手の照合 */
export function cellsOf(hand: Hand): Pos[] {
  if (hand.at?.length) return hand.at;
  if (hand.path?.length) return [hand.path.at(-1)!];
  return hand.to ? [hand.to] : [];
}
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const BENIGN = new Set(['sneak', 'look', 'jump', 'equip', 'wait', 'eat']);
const CHANGES_WORLD = new Set(['walk', 'dig', 'place', 'pillarUp', 'craft', 'use', 'attack', 'pickup', 'furnace', 'chest', 'drop']);

/** 同じ止まりの手のくり返し: 直前に止まった手と同じ種類・同じ行き先（先頭のマス）の手が、世界を変える手の前に無いまま出ている。 */
export function repeatsStop(answer: Answer, context: Context): string | null {
  const targets: Array<{ do: string; cells: Pos[]; hand?: Hand; reason: string; exposeOkFixes: boolean }> = [];
  if (context.stopped) targets.push({ do: context.stopped.do, cells: context.stopped.cell ? [context.stopped.cell] : cellsOf(context.stopped.hand), hand: context.stopped.hand, reason: context.stopped.reason,
    exposeOkFixes: context.stopped.reason === '見られる' });
  const doesOf: Record<string, string[]> = { 一歩ではない: ['walk'], 置けない: ['place'], 見られる: ['dig'], 掘れない: ['dig'], 届かない: ['dig', 'attack', 'use', 'pickup'] };
  for (const stop of context.recentStops) {
    if (stop.secondsAgo > 20) continue;
    // 「掘れない」は Digging aborted のように一時の物が多く、その間の act が先へ進めた後の掘り直し（本番の正しい手も同じ）は、同じ手のくり返しではない。直前の act 自身の止まり（context.stopped）だけで見る。
    if (stop.reason === '掘れない') continue;
    // 止まった時の足の場所から今は離れている（別の場所から同じマスへ向かう）なら、同じ手のくり返しではない。
    if (stop.from && dist(stop.from, context.self) > 1.5) continue;
    for (const kind of doesOf[stop.reason] ?? []) targets.push({ do: kind, cells: [stop.to], reason: stop.reason, exposeOkFixes: stop.reason === '見られる' });
  }
  for (let index = 0; index < answer.hands.length; index += 1) {
    const hand = answer.hands[index]!;
    const before = answer.hands.slice(0, index);
    // Something that changes the world was done first in this act (a dig that opens the cell, a place that gives support): not a plain repeat.
    if (before.some(item => CHANGES_WORLD.has(item.do) && !BENIGN.has(item.do))) continue;
    for (const target of targets) {
      if (hand.do !== target.do) continue;
      const cells = cellsOf(hand);
      if (target.cells.length) {
        if (!cells.length || !target.cells.some(other => same(cells[0]!, other))) continue;
      } else if (!target.hand) continue;
      if (target.exposeOkFixes && hand.exposeOk) continue;
      // 「掘れない」（道具が無い等）の後に、道具を名指しして掘り直す手は、同じ手ではない。
      if (target.reason === '掘れない' && hand.do === 'dig' && hand.tool !== undefined && (target.hand?.tool ?? undefined) !== hand.tool) continue;
      const shown = cells[0] ? ` (${cells[0].x},${cells[0].y},${cells[0].z})` : '';
      return `手${index + 1} ${hand.do} が直前に止まった手（${target.reason}）と同じ${shown}`;
    }
  }
  return null;
}

/**
 * 歩く先が塞がっている（足か頭のマスが固い）か、足元に床が無いか、1 段の上り下りで通る隣の柱の頭が塞がっている。
 * その手の前までに掘る・置く・歩くを地図に写して見る（地図の外のマスは見ない）。
 */
export function walksIntoBlock(answer: Answer, context: Context): string | null {
  const grid: Grid = new Map(context.grid);
  let at: Pos = context.self;
  for (const [index, hand] of answer.hands.entries()) {
    if (hand.do === 'dig') for (const cell of hand.at ?? []) if (grid.has(key(cell.x, cell.y, cell.z))) grid.set(key(cell.x, cell.y, cell.z), '.');
    if (hand.do === 'place') for (const cell of hand.at ?? []) grid.set(key(cell.x, cell.y, cell.z), '#');
    if (hand.do === 'pillarUp') { at = { ...at, y: at.y + (hand.n ?? 1) }; continue; }
    if (hand.do !== 'walk') continue;
    const to = hand.path?.at(-1) ?? hand.to;
    if (!to) continue;
    const feet = grid.get(key(to.x, to.y, to.z)), head = grid.get(key(to.x, to.y + 1, to.z)), floor = grid.get(key(to.x, to.y - 1, to.z));
    if (isSolid(feet) || isSolid(head)) return `手${index + 1} walk (${to.x},${to.y},${to.z}) は塞がっている（足 ${feet} 頭 ${head}）`;
    if (isAir(feet) && isAir(floor)) return `手${index + 1} walk (${to.x},${to.y},${to.z}) は足元が空気（床が無い）`;
    // One column over and one level up or down: the column of the higher level must be free for the body's height.
    const dx = Math.abs(to.x - at.x), dz = Math.abs(to.z - at.z), dy = to.y - at.y;
    if (!hand.path && dx <= 1 && dz <= 1 && dx + dz >= 1 && Math.abs(dy) === 1) {
      const level = Math.max(at.y, to.y);
      const cells = dy < 0 ? [[to.x, level, to.z], [to.x, level + 1, to.z]] : [[at.x, level + 1, at.z], [to.x, level, to.z], [to.x, level + 1, to.z]];
      for (const [x, y, z] of cells as Array<[number, number, number]>) {
        if (isSolid(grid.get(key(x, y, z)))) return `手${index + 1} walk (${to.x},${to.y},${to.z}) へ 1 段${dy < 0 ? '下る' : '上る'}途中の (${x},${y},${z}) が塞がっている`;
      }
    }
    at = to;
  }
  return null;
}

/** stopIf: hpBelow が今の体力以上（頭が外す）か、待つ手に hostileWithin が無い（頭が足す）。本番では頭が直して送るので、減点でなく数える。 */
export function stopIfFixes(answer: Answer, context: Context): string[] {
  const out: string[] = [];
  const hp = answer.stopIf?.hpBelow;
  if (typeof hp === 'number' && hp >= context.hp) out.push(`hpBelow ${hp} は今の体力 ${context.hp} 以上`);
  const waits = answer.hands.some(hand => (hand.do === 'attack' && hand.hold === true) || (hand.do === 'wait' && (hand.seconds ?? 0) >= 3));
  if (waits && typeof answer.stopIf?.hostileWithin !== 'number') out.push('待つ手に hostileWithin が無い');
  return out;
}

/* ---------------------------------------------------------------- 場面ごとの検査 */
/** 場面ファイルの検査 1 つ。 */
export interface Match {
  do?: string | string[]; near?: [number, number, number, number]; block?: string | string[]; exposeOk?: boolean; hold?: boolean;
  target?: string; item?: string | string[]; yAtMost?: number; yAtLeast?: number;
  /** dig: the tool the hand names (null: none named). */
  tool?: string | null;
  /** walk: the end is farther from this threat (an id like "#696" or "nearest") than she is now, by at least 1 block. */
  awayFrom?: string;
  /** walk: the end is nearer to it. */
  towards?: string;
  /** walk/dig: the end is at x (or z) smaller / larger than she is now by at least 2: "west"/"east"/"north"/"south". */
  heading?: 'west' | 'east' | 'north' | 'south';
}
export type Check =
  | { kind: 'tool'; in: string[] }
  | { kind: 'first'; match: Match | Match[]; skip?: string[] }
  | { kind: 'some'; match: Match; within?: number; atLeast?: number }
  | { kind: 'none'; match: Match; within?: number; atMost?: number }
  | { kind: 'hands'; min?: number; max?: number }
  | { kind: 'stopIf'; hpBelowAtMost?: number; hpBelowAtLeast?: number; hostileWithin?: boolean }
  | { kind: 'order'; before: Match; after: Match }
  | { kind: 'whyTag' }
  /** 急ぎの最初の手が安全（置く・食べる・持ち替える・掘る・打つ・敵から離れる）。待つ・作る・拾う・箱・敵へ近づく歩きは不可。 */
  | { kind: 'urgentSafe' }
  /** 壁の無い橋: 床の高さ（floorMax 以下）に置く手が minFloor 以上あり、その上の高さに置く手（壁・天井）が無い。pass = そうではない。 */
  | { kind: 'noBareBridge'; floorMax: number; minFloor?: number }
  /** plan_update の current が prefix で始まらない（飛ばして遠出の節へ入らない）。plan_update でない答えは通る。 */
  | { kind: 'planCurrentNot'; prefix: string }
  /** 急ぎの答え方の行（live.body.answer）が言う「手は 3 つまで」。行が無い場面では通る。 */
  | { kind: 'answerLine' };
export interface CheckResult { pass: boolean; detail: string }

const arr = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function threatOf(context: Context, spec: string): Threat | undefined {
  if (spec === 'nearest') return [...context.threats].sort((a, b) => a.meters - b.meters)[0];
  return context.threats.find(threat => `#${threat.id}` === spec || threat.name === spec);
}
export function matches(hand: Hand, match: Match, context: Context): boolean {
  if (match.do && !arr(match.do).includes(hand.do)) return false;
  if (match.block && !arr(match.block).includes(String(hand.block))) return false;
  if (match.exposeOk !== undefined && Boolean(hand.exposeOk) !== match.exposeOk) return false;
  if (match.hold !== undefined && Boolean(hand.hold) !== match.hold) return false;
  if (match.target && !new RegExp(match.target).test(String(hand.target ?? ''))) return false;
  if (match.item && !arr(match.item).includes(String(hand.item))) return false;
  if (match.tool !== undefined && (hand.tool ?? null) !== match.tool) return false;
  const cells = cellsOf(hand);
  if (match.near) { const [x, y, z, r] = match.near; if (!cells.some(cell => dist(cell, { x, y, z }) <= r)) return false; }
  if (match.yAtMost !== undefined && !cells.some(cell => cell.y <= match.yAtMost!)) return false;
  if (match.yAtLeast !== undefined && !cells.some(cell => cell.y >= match.yAtLeast!)) return false;
  const end = hand.path?.at(-1) ?? hand.to ?? hand.at?.at(-1);
  if (match.awayFrom) {
    const threat = threatOf(context, match.awayFrom);
    if (!threat || !end || dist(end, threat.pos) < dist(context.self, threat.pos) + 1) return false;
  }
  if (match.towards) {
    const threat = threatOf(context, match.towards);
    if (!threat || !end || dist(end, threat.pos) > dist(context.self, threat.pos) - 1) return false;
  }
  if (match.heading) {
    if (!end) return false;
    const delta = { west: context.self.x - end.x, east: end.x - context.self.x, north: context.self.z - end.z, south: end.z - context.self.z }[match.heading];
    if (delta < 2) return false;
  }
  return true;
}
const describe = (match: Match) => JSON.stringify(match);

export function runCheck(check: Check, answer: Answer, context: Context): CheckResult {
  switch (check.kind) {
    case 'tool': return { pass: !!answer.tool && check.in.includes(answer.tool), detail: `道具 ${answer.tool ?? '無し'}` };
    case 'hands': { const n = answer.hands.length; return { pass: (check.min === undefined || n >= check.min) && (check.max === undefined || n <= check.max), detail: `手 ${n} 個` }; }
    case 'first': {
      const skip = new Set(check.skip ?? ['sneak', 'look', 'jump']);
      const hand = answer.hands.find(item => !skip.has(item.do));
      const list = arr(check.match);
      return { pass: !!hand && list.some(match => matches(hand, match, context)), detail: hand ? `最初の手 ${hand.do}` : '手が無い' };
    }
    case 'some': {
      const hands = answer.hands.slice(0, check.within ?? answer.hands.length);
      const count = hands.filter(hand => matches(hand, check.match, context)).length;
      return { pass: count >= (check.atLeast ?? 1), detail: `${describe(check.match)} に当たる手 ${count}` };
    }
    case 'none': {
      const hands = answer.hands.slice(0, check.within ?? answer.hands.length);
      const count = hands.filter(hand => matches(hand, check.match, context)).length;
      return { pass: count <= (check.atMost ?? 0), detail: `${describe(check.match)} に当たる手 ${count}` };
    }
    case 'order': {
      const first = answer.hands.findIndex(hand => matches(hand, check.before, context)), last = answer.hands.findIndex(hand => matches(hand, check.after, context));
      return { pass: last === -1 || (first !== -1 && first < last), detail: `前 ${first + 1} 後 ${last + 1}` };
    }
    case 'stopIf': {
      const stopIf = answer.stopIf ?? {};
      const hp = stopIf.hpBelow;
      const okMax = check.hpBelowAtMost === undefined || typeof hp !== 'number' || hp <= check.hpBelowAtMost;
      const okMin = check.hpBelowAtLeast === undefined || (typeof hp === 'number' && hp >= check.hpBelowAtLeast);
      const okHostile = !check.hostileWithin || typeof stopIf.hostileWithin === 'number';
      return { pass: okMax && okMin && okHostile, detail: `stopIf ${JSON.stringify(stopIf)}` };
    }
    case 'urgentSafe': {
      const hand = answer.hands.find(item => !['sneak', 'look', 'jump'].includes(item.do));
      if (!hand) return { pass: false, detail: '手が無い' };
      if (['place', 'eat', 'equip', 'dig', 'pillarUp', 'attack'].includes(hand.do)) return { pass: true, detail: `最初の手 ${hand.do}` };
      if (hand.do === 'walk') {
        const near = [...context.threats].sort((a, b) => a.meters - b.meters)[0];
        const end = hand.path?.at(-1) ?? hand.to;
        const away = !near || !end || dist(end, near.pos) >= dist(context.self, near.pos) - 0.5;
        return { pass: away, detail: away ? '最初の手 walk（敵に近づかない）' : '最初の手 walk が敵へ近づく' };
      }
      return { pass: false, detail: `最初の手 ${hand.do}（急ぎの先頭に向かない）` };
    }
    case 'noBareBridge': {
      const floors = answer.hands.filter(hand => hand.do === 'place').flatMap(hand => hand.at ?? []);
      const low = floors.filter(cell => cell.y <= check.floorMax).length, high = floors.filter(cell => cell.y > check.floorMax).length;
      const bare = low >= (check.minFloor ?? 3) && high === 0;
      return { pass: !bare, detail: `床 ${low} 壁・天井 ${high}` };
    }
    case 'planCurrentNot': {
      const current = answer.tool === 'plan.update' ? String((answer.input as { current?: unknown }).current ?? '') : '';
      return { pass: !current.startsWith(check.prefix), detail: `plan current ${current || '-'}` };
    }
    case 'answerLine': {
      if (!context.hasAnswerLine) return { pass: true, detail: '答え方の行なし' };
      const n = answer.partsMax ?? answer.hands.length;
      return { pass: n <= 3, detail: `手 ${n} 個（答え方の行: 3 つまで）` };
    }
    case 'whyTag': {
      const tag = context.urgent ? /^\[(急ぎ|[a-z]\d+(\.\d+)*)\]/u : /^\[[a-z]\d+(\.\d+)*\]/u;
      return { pass: tag.test(answer.why ?? ''), detail: `why ${(answer.why ?? '').slice(0, 24)}` };
    }
  }
}
