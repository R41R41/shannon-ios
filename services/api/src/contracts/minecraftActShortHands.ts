import type { ActHand } from './minecraftActContract.js';

/**
 * 手の短い書き方（mb-llmc-cand、再現台 v8d/v9c の `shortHands.ts` を本番の形にした物）。手 1 つが 1 行の文字列で、頭のコードが体へ送る前に
 * 今の JSON（`ActHand`）に直す。
 *   walk 225,57,63 | walk 1,2,3 4,5,6（path）[sprint] [range=2] | dig x,y,z x,y,z [tool=名] [exposeOk] [takeOk] [collect=false]
 *   place ブロック x,y,z ... [face=down] | pillarUp N [ブロック] | wait 秒 | sneak on|off | jump N | eat [物] | equip 物 [slot] | craft 物 [個数]
 *   pickup [range=N] [target=T] | look x,y,z か look yaw=A pitch=B | attack 相手 [hold] [seconds=N] [untilDead=false] | use 物 [x,y,z] [face=F] [target=T]
 *   どの手にも rel（足からの差）、onFail=continue|stop、note="短い説明" を付けられる。
 *   drop 物 [数] [target=#id か x,y,z]
 *   上に無い形（furnace・chest・shoot、use の ほかの欄など）は `json {手の JSON}` の 1 行。
 * 往復（手 → 1 行 → 手）が元と同じにならない手は、必ず json の行に落ちる（欄を黙って失わない）。
 */
type Fields = Record<string, unknown>;
type Cell = { x: number; y: number; z: number };
export const pos = (cell: Cell): string => `${cell.x},${cell.y},${cell.z}`;
export const readPos = (token: string): Cell | null => {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u.exec(token);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
};
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/* ------------------------------------------------------------------ 手 → 1 行 */
/**
 * The slot words of `equip` the body takes are hand, offhand, head, chest, legs and feet. Bench 2026-10-24 (run 38 d127, the iron armour made and put on):
 * 2 answers of 3 wrote `equip iron_chestplate torso` (the live state's worn line says 頭・胴・脚・足・左手), and the act was refused. Those words are read as the body's.
 */
const SLOT_WORDS: Readonly<Record<string, string>> = { torso: 'chest', body: 'chest', chestplate: 'chest', helmet: 'head', leg: 'legs', leggings: 'legs',
  boots: 'feet', foot: 'feet', mainhand: 'hand', main: 'hand', off: 'offhand', off_hand: 'offhand', 頭: 'head', 胴: 'chest', 脚: 'legs', 足: 'feet',
  右手: 'hand', 左手: 'offhand' };
type Words = string[] | null;
const flag = (on: boolean | undefined, word: string): string[] => on === true ? [word] : [];
const given = (key: string, value: unknown): string[] => value === undefined ? [] : [`${key}=${String(value)}`];
const points = (hand: ActHand): readonly Cell[] => hand.path?.length ? hand.path : hand.to ? [hand.to] : [];

const WRITERS: Partial<Record<ActHand['do'], (hand: ActHand) => Words>> = {
  walk: hand => (hand.path && hand.to) || hand.path?.length === 1 || !points(hand).length
    ? null : [...points(hand).map(pos), ...flag(hand.sprint, 'sprint'), ...given('range', hand.range)],
  dig: hand => hand.at?.length
    ? [...hand.at.map(pos), ...given('tool', hand.tool), ...flag(hand.exposeOk, 'exposeOk'), ...flag(hand.takeOk, 'takeOk'), ...given('collect', hand.collect)]
    : null,
  place: hand => hand.block && hand.at?.length ? [hand.block, ...hand.at.map(pos), ...given('face', hand.face)] : null,
  pillarUp: hand => [...(hand.n !== undefined ? [String(hand.n)] : []), ...(hand.block ? [hand.block] : [])],
  wait: hand => hand.seconds !== undefined ? [String(hand.seconds)] : null,
  sneak: hand => hand.on !== undefined ? [hand.on ? 'on' : 'off'] : null,
  jump: hand => hand.n !== undefined ? [String(hand.n)] : [],
  eat: hand => hand.item ? [hand.item] : [],
  equip: hand => hand.item ? [hand.item, ...(hand.slot ? [hand.slot] : [])] : null,
  craft: hand => hand.item ? [hand.item, ...(hand.count !== undefined ? [String(hand.count)] : [])] : null,
  pickup: hand => [...given('range', hand.range), ...given('target', hand.target)],
  // `drop 物 [数] [target=#id か x,y,z]`: one kind, one place at most (a second kind or both a target and a place are a json line).
  drop: hand => hand.items?.length === 1 && (hand.at?.length ?? 0) <= 1 && !(hand.at?.length && hand.target)
    ? [hand.items[0]!.item, ...(hand.items[0]!.count !== undefined ? [String(hand.items[0]!.count)] : []), ...given('target', hand.target),
      ...(hand.at?.length ? [pos(hand.at[0]!)] : [])] : null,
  look: hand => hand.to ? [pos(hand.to)] : hand.yaw !== undefined && hand.pitch !== undefined ? [`yaw=${hand.yaw}`, `pitch=${hand.pitch}`] : null,
  attack: hand => hand.target
    ? [hand.target, ...flag(hand.hold, 'hold'), ...given('seconds', hand.seconds), ...given('untilDead', hand.untilDead)] : null,
  use: hand => hand.item && (hand.at?.length ?? 0) <= 1
    ? [hand.item, ...(hand.at?.length ? [pos(hand.at[0]!)] : []), ...given('face', hand.face), ...given('target', hand.target)] : null,
};
function tail(hand: ActHand): string[] {
  return [...flag(hand.rel, 'rel'), ...given('onFail', hand.onFail), ...(typeof hand.note === 'string' ? [`note=${JSON.stringify(hand.note)}`] : [])];
}
function shortLine(hand: ActHand): string | null {
  const words = WRITERS[hand.do]?.(hand);
  return words ? [hand.do, ...words, ...tail(hand)].join(' ') : null;
}

/** 手 → 1 行。往復して元と同じにならない手は `json {...}`。 */
export function handToLine(hand: ActHand): string {
  const line = shortLine(hand);
  if (line) {
    const back = lineToHand(line);
    if (!('error' in back) && same(back, hand)) return line;
  }
  return `json ${JSON.stringify(hand)}`;
}

/* ------------------------------------------------------------------ 1 行 → 手 */
type Read = { cells: Cell[]; words: string[]; hand: Fields };
type Reader = (read: Read) => ActHand | { error: string };
const done = (hand: Fields) => hand as unknown as ActHand;
const bad = (verb: string, reason: string) => ({ error: `${verb}: ${reason}` });
const isCount = (word: string | undefined) => /^\d+$/u.test(word ?? '');

const READERS: Record<string, Reader> = {
  walk: ({ cells, hand }) => {
    if (!cells.length) return bad('walk', '座標が無い');
    if (cells.length === 1) hand.to = cells[0]; else hand.path = cells;
    return done(hand);
  },
  dig: ({ cells, hand }) => cells.length ? done({ ...hand, at: cells }) : bad('dig', '座標が無い'),
  place: ({ cells, words, hand }) => cells.length && words[0] ? done({ ...hand, block: words[0], at: cells }) : bad('place', 'ブロック名と座標が要る'),
  pillarUp: ({ words, hand }) => {
    const n = words.find(isCount), block = words.find(word => !isCount(word));
    return done({ ...hand, ...(n ? { n: Number(n) } : {}), ...(block ? { block } : {}) });
  },
  wait: ({ words, hand }) => /^[\d.]+$/u.test(words[0] ?? '') ? done({ ...hand, seconds: Number(words[0]) }) : bad('wait', '秒が要る'),
  sneak: ({ words, hand }) => words[0] === 'on' || words[0] === 'off' ? done({ ...hand, on: words[0] === 'on' }) : bad('sneak', 'on か off'),
  jump: ({ words, hand }) => done(isCount(words[0]) ? { ...hand, n: Number(words[0]) } : hand),
  eat: ({ words, hand }) => done(words[0] ? { ...hand, item: words[0] } : hand),
  equip: ({ words, hand }) => words[0]
    ? done({ ...hand, item: words[0], ...(words[1] ? { slot: SLOT_WORDS[words[1]] ?? words[1] } : {}) }) : bad('equip', '物の名前が要る'),
  craft: ({ words, hand }) => words[0]
    ? done({ ...hand, item: words[0], ...(isCount(words[1]) ? { count: Number(words[1]) } : {}) }) : bad('craft', '物の名前が要る'),
  pickup: ({ hand }) => done(hand),
  drop: ({ words, cells, hand }) => words[0] && cells.length <= 1
    ? done({ ...hand, items: [{ item: words[0], ...(isCount(words[1]) ? { count: Number(words[1]) } : {}) }], ...(cells.length ? { at: [cells[0]] } : {}) })
    : bad('drop', '物の名前が要る（座標は 1 つまで）'),
  look: ({ cells, hand }) => done(cells.length ? { ...hand, to: cells[0] } : hand),
  attack: ({ words, hand }) => words[0] ? done({ ...hand, target: words[0] }) : bad('attack', '相手が要る'),
  use: ({ words, cells, hand }) => words[0]
    ? done({ ...hand, item: words[0], ...(cells.length ? { at: [cells[0]] } : {}) }) : bad('use', '物の名前が要る'),
};
const FLAGS: Record<string, string> = { rel: 'rel', sprint: 'sprint', exposeOk: 'exposeOk', takeOk: 'takeOk', hold: 'hold' };
const NOTE = /\s+note=("(?:[^"\\]|\\.)*")/u;

/** `key=value` の値: true・false・数はその型、それ以外は文字。 */
function valueOf(raw: string): unknown {
  const number = Number(raw);
  return raw === 'false' ? false : raw === 'true' ? true : raw !== '' && Number.isFinite(number) ? number : raw;
}
function readTokens(tokens: readonly string[], verb: string): Read | { error: string } {
  const out: Read = { cells: [], words: [], hand: { do: verb } };
  for (const token of tokens) {
    const cell = readPos(token), key = /^([A-Za-z]+)=(.*)$/su.exec(token);
    if (cell) out.cells.push(cell);
    else if (Object.hasOwn(FLAGS, token)) out.hand[FLAGS[token]!] = true;
    else if (key && key[1] === 'do') return bad(verb, 'do= は書けない');
    else if (key) out.hand[key[1]!] = valueOf(key[2]!);
    else out.words.push(token);
  }
  return out;
}
/** 1 行 → 手。読めない行は { error }。 */
export function lineToHand(line: string): ActHand | { error: string } {
  const text = line.trim();
  if (text.startsWith('json ')) {
    try { return JSON.parse(text.slice(5)) as ActHand; } catch { return { error: `json の行が読めない: ${text.slice(0, 40)}` }; }
  }
  const note = NOTE.exec(text);
  let noteText: string | undefined;
  if (note) {
    try { noteText = JSON.parse(note[1]!) as string; } catch { return { error: `note の引用が読めない: ${text.slice(0, 40)}` }; }
  }
  const [verb = '', ...tokens] = (note ? text.replace(NOTE, '') : text).split(/\s+/u);
  const reader = Object.hasOwn(READERS, verb) ? READERS[verb] : undefined;
  if (!reader) return bad(verb, '知らない手');
  const read = readTokens(tokens, verb);
  if ('error' in read) return read;
  const result = reader(read);
  return noteText !== undefined && !('error' in result) ? { ...result, note: noteText } : result;
}
