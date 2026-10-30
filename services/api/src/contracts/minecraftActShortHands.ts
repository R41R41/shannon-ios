import { slotWordOf, type ActHand } from './minecraftActContract.js';

/**
 * 手の短い書き方（mb-llmc-cand、再現台 v8d/v9c の `shortHands.ts` を本番の形にした物）。手 1 つが 1 行の文字列で、頭のコードが体へ送る前に
 * 今の JSON（`ActHand`）に直す。
 *   go X,Y,Z [X,Y,Z ...] [dig=stone,dirt] [place=cobblestone] [range=N] [seconds=N] [maxDrop=N] [maxDig=N] [maxPlace=N] [waterOk] [sprint]
 *     （座標 1 つが to、2〜8 個が goals。dig= は canDig、place= は canPlace）
 *   obsidian X,Y,Z [X,Y,Z ...] [count=N] [seconds=N] [place=a,b] [maxPlace=N]   （溶岩の源のマス。水を注いで黒曜石にして掘る）
 *   fight 相手 [flee] [item=名] [retreatHp=N] [range=N] [seconds=N]   mine ブロック名 X,Y,Z ... [count=N] [tool=名] [dig=a,b] [maxDig=N] [collect=false] [seconds=N]
 *   chest X,Y,Z look|takeAll | chest X,Y,Z take|put 物 [数] [物 [数] ...]   furnace X,Y,Z take | furnace X,Y,Z put 物 個数 [fuel=名] [fuelCount=N]
 *   make 物 [個数]   portal X,Y,Z x|z [block=名] [place=a,b] [maxPlace=N] [seconds=N] [noEnter]
 *   smelt 物 個数 [fuel=名] [fuelCount=N] [furnaces=N] [X,Y,Z ...] [seconds=N]
 *   vertical down|up stairs|shaft|pillar [north|east|south|west] y=N dig=a,b liquid=stop|seal|seal_water [maxDig=N] [place=a,b] [maxPlace=N] [range=1|2] [seconds=N]
 *     （縦の長い移動。y= は toY、stairs だけ向き。dir・形・向き・liquid・dig= は書く。組み合わせの断りは handProblem）
 *   walk 225,57,63 | walk 1,2,3 4,5,6（path）[sprint] [range=2] | dig x,y,z x,y,z [tool=名] [exposeOk] [takeOk] [collect=false]
 *   place ブロック x,y,z ... [face=down] | pillarUp N [ブロック] | wait 秒 | sneak on|off | jump N | eat [物] | equip 物 [slot] | craft 物 [個数]
 *   pickup [range=N] [target=T] | look x,y,z か look yaw=A pitch=B | attack 相手 [hold] [seconds=N] [untilDead=false] | use 物 [x,y,z] [face=F] [target=T]
 *   どの手にも rel（足からの差）、onFail=continue|stop、dependsOn=1,3（頼る前の手の番号。dependsOn=none は何にも頼らない）、note="短い説明" を付けられる。
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
type Words = string[] | null;
const flag = (on: boolean | undefined, word: string): string[] => on === true ? [word] : [];
const given = (key: string, value: unknown): string[] => value === undefined ? [] : [`${key}=${String(value)}`];
const points = (hand: ActHand): readonly Cell[] => hand.path?.length ? hand.path : hand.to ? [hand.to] : [];

/** go: where (one cell is `to`, 2–8 are `goals`), the blocks it may dig and place, and its limits. A hand with both `to` and `goals` is a json line. */
function goWords(hand: ActHand): Words {
  if (hand.to && hand.goals?.length) return null;
  const cells = hand.to ? [hand.to] : hand.goals ?? [];
  if (!cells.length) return null;
  return [...cells.map(pos), ...listWord('dig', hand.canDig), ...listWord('place', hand.canPlace),
    ...given('range', hand.range), ...given('seconds', hand.seconds), ...given('maxDrop', hand.maxDrop), ...given('maxDig', hand.maxDig),
    ...given('maxPlace', hand.maxPlace), ...flag(hand.waterOk, 'waterOk'), ...flag(hand.sprint, 'sprint')];
}
/** obsidian, mine, portal: the cells, then the blocks the hand may place or dig, and its limits. */
function obsidianWords(hand: ActHand): Words {
  return hand.at?.length ? [...hand.at.map(pos), ...given('count', hand.count), ...given('seconds', hand.seconds), ...listWord('place', hand.canPlace),
    ...given('maxPlace', hand.maxPlace), ...(hand.do === 'obsidian' ? given('maxDig', hand.maxDig) : [])] : null;
}
function mineWords(hand: ActHand): Words {
  return hand.block && hand.at?.length ? [hand.block, ...hand.at.map(pos), ...given('count', hand.count), ...given('tool', hand.tool),
    ...listWord('dig', hand.canDig), ...given('maxDig', hand.maxDig), ...given('collect', hand.collect), ...given('seconds', hand.seconds)] : null;
}
function portalWords(hand: ActHand): Words {
  return hand.at?.length === 1 && hand.axis ? [pos(hand.at[0]!), hand.axis, ...given('block', hand.block), ...listWord('place', hand.canPlace),
    ...given('maxPlace', hand.maxPlace),
    ...given('seconds', hand.seconds), ...(hand.enter === false ? ['noEnter'] : given('enter', hand.enter))] : null;
}
function fightWords(hand: ActHand): Words {
  if (!hand.target) return null;
  return [hand.target, ...(hand.stance === 'flee' ? ['flee'] : given('stance', hand.stance)), ...given('item', hand.item),
    ...given('retreatHp', hand.retreatHp),    ...given('range', hand.range), ...given('seconds', hand.seconds)];
}
/** smelt: one kind of input in a line (several kinds are a json line). */
function smeltWords(hand: ActHand): Words {
  const only = hand.items?.length === 1 && hand.items[0]!.count !== undefined ? hand.items[0]! : null;
  if (!only) return null;
  return [only.item, String(only.count), ...given('fuel', hand.fuel), ...given('fuelCount', hand.fuelCount), ...given('furnaces', hand.furnaces),
    ...given('seconds', hand.seconds), ...(hand.at ?? []).map(pos)];
}
const listWord = (key: string, list: readonly string[] | undefined): string[] => list?.length ? [`${key}=${list.join(',')}`] : [];
/** vertical: the way, the form (and `toward` for stairs), then `y=` and the blocks it may dig and place, and its limits, in the order of the grammar above. */
function verticalWords(hand: ActHand): Words {
  if (!hand.dir || !hand.shape || typeof hand.toY !== 'number') return null;
  return [hand.dir, hand.shape, ...(hand.toward ? [hand.toward] : []), `y=${hand.toY}`, ...listWord('dig', hand.canDig), ...given('maxDig', hand.maxDig),
    ...listWord('place', hand.canPlace), ...given('maxPlace', hand.maxPlace), ...given('liquid', hand.liquid), ...given('range', hand.range),
    ...given('seconds', hand.seconds)];
}
/** chest: the box's cell, the op, and the items with their counts (a list that does not read back is a json line). */
function chestWords(hand: ActHand): Words {
  if (hand.at?.length !== 1 || !hand.op || hand.target !== undefined) return null;
  return [pos(hand.at[0]!), hand.op, ...(hand.items ?? []).flatMap(entry => [entry.item, ...(entry.count !== undefined ? [String(entry.count)] : [])])];
}
/** furnace: the cell, take, or put with the item, its count and the fuel. */
function furnaceWords(hand: ActHand): Words {
  if (hand.at?.length !== 1 || (hand.op !== 'put' && hand.op !== 'take')) return null;
  if (hand.op === 'take') return hand.item || hand.count !== undefined || hand.fuel ? null : [pos(hand.at[0]!), 'take'];
  if (!hand.item || hand.count === undefined) return null;
  return [pos(hand.at[0]!), 'put', hand.item, String(hand.count), ...given('fuel', hand.fuel), ...given('fuelCount', hand.fuelCount)];
}
const WRITERS: Partial<Record<ActHand['do'], (hand: ActHand) => Words>> = {
  chest: chestWords, furnace: furnaceWords,
  go: goWords, obsidian: obsidianWords, mine: mineWords, portal: portalWords, fight: fightWords, smelt: smeltWords, vertical: verticalWords,
  make: hand => hand.item ? [hand.item, ...(hand.count !== undefined ? [String(hand.count)] : [])] : null,
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
/** `dependsOn=1,3`; an empty list (relies on no hand) is `dependsOn=none`. */
const dependsWord = (hand: ActHand): string[] => hand.dependsOn === undefined ? [] : [`dependsOn=${hand.dependsOn.length ? hand.dependsOn.join(',') : 'none'}`];
function tail(hand: ActHand): string[] {
  return [...flag(hand.rel, 'rel'), ...given('onFail', hand.onFail), ...dependsWord(hand),
    ...(typeof hand.note === 'string' ? [`note=${JSON.stringify(hand.note)}`] : [])];
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

/** The names of `dig=a,b` / `place=a,b` as the list a go takes. */
const names = (value: unknown): string[] => String(value).split(',').map(name => name.trim()).filter(Boolean);
/** A hand's `dig=a,b` / `place=a,b` words moved to the fields the contract names. */
function blocksOf(hand: Fields): Fields {
  // The long field names are read too (run 39 bench: `mine ... canDig=stone` was refused).
  const { dig, place, canDig, canPlace, ...rest } = hand;
  const digs = dig ?? canDig, places = place ?? canPlace;
  return { ...rest, ...(digs !== undefined ? { canDig: names(digs) } : {}), ...(places !== undefined ? { canPlace: names(places) } : {}) };
}
/** chest: `X,Y,Z op [物 [数] ...]`; the items are names, each followed by its count when it has one. */
function chestHand({ cells, words, hand }: Read): ActHand | { error: string } {
  const [op, ...rest] = words;
  if (cells.length !== 1 || !op || !['look', 'take', 'put', 'takeAll'].includes(op)) return bad('chest', '箱の座標 1 つと look・take・put・takeAll が要る');
  const items: Array<{ item: string; count?: number }> = [];
  for (const word of rest) {
    if (isCount(word) && items.length && items[items.length - 1]!.count === undefined) items[items.length - 1]!.count = Number(word);
    else if (!isCount(word)) items.push({ item: word });
    else return bad('chest', `個数 ${word} の前に物の名前が要る`);
  }
  return done({ ...hand, at: cells, op, ...(items.length ? { items } : {}) });
}
function furnaceHand({ cells, words, hand }: Read): ActHand | { error: string } {
  const [op, item, count] = words;
  if (cells.length !== 1 || (op !== 'put' && op !== 'take')) return bad('furnace', 'かまどの座標 1 つと put か take が要る');
  if (op === 'put' && (!item || !isCount(count))) return bad('furnace', 'put には 物 と 個数 が要る（furnace X,Y,Z put iron_ore 8 fuel=coal fuelCount=2）');
  return done({ ...hand, at: cells, op, ...(op === 'put' ? { item, count: Number(count) } : {}) });
}
/** The names of vertical's fields written with `=` (a word of these in the place of the compass word is a field written without it). */
const VERTICAL_FIELDS: ReadonlySet<string> = new Set(['maxDig', 'maxPlace', 'seconds', 'range', 'dig', 'place', 'liquid', 'y']);
const READERS: Record<string, Reader> = {
  chest: chestHand, furnace: furnaceHand,
  obsidian: ({ cells, hand }) => cells.length ? done(blocksOf({ ...hand, at: cells })) : bad('obsidian', '溶岩の源の座標が要る'),
  mine: ({ cells, words, hand }) => cells.length && words[0] ? done(blocksOf({ ...hand, block: words[0], at: cells })) : bad('mine', 'ブロック名と座標が要る'),
  make: ({ words, hand }) => words[0] ? done({ ...hand, item: words[0], ...(isCount(words[1]) ? { count: Number(words[1]) } : {}) }) : bad('make', '物の名前が要る'),
  fight: ({ words, hand }) => {
    if (!words[0]) return bad('fight', '相手（#id か名前）が要る');
    const { flee, ...rest } = hand;
    return done({ ...rest, target: words[0], ...(flee === true ? { stance: 'flee' } : {}) });
  },
  portal: ({ cells, words, hand }) => {
    const axis = words.find(word => word === 'x' || word === 'z');
    if (cells.length !== 1 || !axis) return bad('portal', '枠の内側の左下の座標 1 つと向き x か z が要る');
    const { noEnter, ...rest } = blocksOf({ ...hand, at: cells, axis });
    return done({ ...rest, ...(noEnter === true ? { enter: false } : {}) });
  },
  smelt: ({ cells, words, hand }) => {
    if (!words[0] || !isCount(words[1])) return bad('smelt', '入れる物と個数が要る（種類が 2 つ以上なら json）');
    return done({ ...hand, items: [{ item: words[0], count: Number(words[1]) }], ...(cells.length ? { at: cells } : {}) });
  },
  // `vertical down|up stairs|shaft|pillar [north|east|south|west] y=N dig=.. liquid=..`: the words are only the way, the form and the compass word; whether they fit
  // each other is `handProblem`'s (the same refusal for a json hand).
  vertical: ({ words, hand }) => {
    const [dir, shape, toward, ...extra] = words;
    if (dir !== 'down' && dir !== 'up') return bad('vertical', 'dir（down か up）が要る（vertical down stairs south y=10 dig=stone liquid=stop）');
    if (!shape) return bad('vertical', '形（stairs・shaft・pillar）が要る');
    if (extra.length) {
      // A field written as a word and a value (「maxDig 200」): said with its form, not read as that field (the model writes the form, the head does not guess it).
      const forms = extra.flatMap((word, index) => VERTICAL_FIELDS.has(word) ? [`${word}=${extra[index + 1] ?? '値'}`] : []);
      return bad('vertical', `読めない語 ${extra.join(' ')}${forms.length ? `（${forms.join('・')} の形で書く。= で結ぶ）` : ''}`);
    }
    const { y, toY, ...rest } = blocksOf(hand), target = toY ?? y;
    return done({ ...rest, dir, shape, ...(toward ? { toward } : {}), ...(target !== undefined ? { toY: target } : {}) });
  },
  go: ({ cells, hand }) => {
    if (!cells.length) return bad('go', '座標が無い');
    const rest = blocksOf(hand);
    if (cells.length === 1) rest.to = cells[0]; else rest.goals = cells;
    return done(rest);
  },
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
    ? done({ ...hand, item: words[0], ...(words[1] ? { slot: slotWordOf(words[1]) } : {}) }) : bad('equip', '物の名前が要る'),
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
const FLAGS: Record<string, string> = { rel: 'rel', sprint: 'sprint', exposeOk: 'exposeOk', takeOk: 'takeOk', hold: 'hold', waterOk: 'waterOk', flee: 'flee',
  noEnter: 'noEnter' };
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
    else if (key && key[1] === 'dependsOn') {
      const numbers = key[2] === '' || key[2] === 'none' ? [] : key[2]!.split(',').map(Number);
      if (numbers.some(number => !Number.isInteger(number))) return bad(verb, 'dependsOn= は前の手の番号をコンマで（dependsOn=1,3）。何にも頼らないなら dependsOn=none');
      out.hand.dependsOn = numbers;
    } else if (key && key[1] === 'slot') out.hand.slot = slotWordOf(key[2]!);
    else if (key) out.hand[key[1]!] = valueOf(key[2]!);
    else out.words.push(token);
  }
  return out;
}
/** A hand that names its slot with a variation of a hand word (A-11 3) has the body's word. */
export function withSlotWord<T extends object>(hand: T): T {
  const slot = (hand as { slot?: unknown } | null)?.slot;
  return typeof slot === 'string' && slotWordOf(slot) !== slot ? { ...hand, slot: slotWordOf(slot) } : hand;
}
/** 1 行 → 手。読めない行は { error }。 */
export function lineToHand(line: string): ActHand | { error: string } {
  const text = line.trim();
  if (text.startsWith('json ')) {
    try { return withSlotWord(JSON.parse(text.slice(5)) as ActHand); } catch { return { error: `json の行が読めない: ${text.slice(0, 40)}` }; }
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
