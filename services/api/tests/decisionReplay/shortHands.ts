import type { ActHand, ActInput } from '../../src/contracts/minecraftActContract.js';

/**
 * 手の短い書き方（v8 の出力の試み）。手 1 つが 1 行の文字列、頭のコードが今の JSON（ActHand）に直す。
 *   walk 225,57,63 | walk 1,2,3 4,5,6（path）sprint range=2 | dig x,y,z x,y,z tool=NAME exposeOk takeOk collect=false | place BLOCK x,y,z ... face=down
 *   pillarUp N [BLOCK] | wait S | sneak on | pickup range=N target=T | use ITEM x,y,z face=F | look x,y,z / look yaw=A pitch=B | craft ITEM [COUNT]
 *   equip ITEM [SLOT] | eat ITEM | attack TARGET hold seconds=N untilDead=false | jump N
 *   どの手にも rel（足からの差）と onFail=continue|stop を付けられる。上に無い形（chest・furnace・drop・shoot・use の ほかの欄 など）は `json {手の JSON}`。
 * 全体: { why, hands: string[], stopIf?: "hpBelow=8 hostileWithin=6", accept?: string[] }。
 * 往復（JSON → 短い書き方 → JSON）が全部の記録の手で元と同じになることを試験で確かめる（合わない手は json の行に落とす）。
 */
type Fields = Record<string, unknown>;
const pos = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;
const readPos = (token: string): { x: number; y: number; z: number } | null => {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/u.exec(token);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
};
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]));
  return value;
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
function tail(hand: ActHand): string[] {
  const out: string[] = [];
  if (hand.rel === true) out.push('rel');
  if (hand.onFail) out.push(`onFail=${hand.onFail}`);
  return out;
}
function shortLine(h: ActHand): string | null {
  const rest = tail(h);
  switch (h.do) {
    case 'walk': {
      const points = h.path?.length ? h.path : h.to ? [h.to] : [];
      if (!points.length || (h.path && h.to)) return null;
      if (h.path?.length === 1) return null;
      const opts = [...(h.sprint === true ? ['sprint'] : []), ...(typeof h.range === 'number' ? [`range=${h.range}`] : [])];
      return ['walk', ...points.map(pos), ...opts, ...rest].join(' ');
    }
    case 'dig': {
      if (!h.at?.length) return null;
      const opts = [...(h.tool ? [`tool=${h.tool}`] : []), ...(h.exposeOk === true ? ['exposeOk'] : []), ...(h.takeOk === true ? ['takeOk'] : []), ...(h.collect === false ? ['collect=false'] : h.collect === true ? ['collect=true'] : [])];
      return ['dig', ...h.at.map(pos), ...opts, ...rest].join(' ');
    }
    case 'place': return h.block && h.at?.length ? ['place', h.block, ...h.at.map(pos), ...(h.face ? [`face=${h.face}`] : []), ...rest].join(' ') : null;
    case 'pillarUp': return ['pillarUp', ...(h.n !== undefined ? [String(h.n)] : []), ...(h.block ? [h.block] : []), ...rest].join(' ');
    case 'wait': return h.seconds !== undefined ? ['wait', String(h.seconds), ...rest].join(' ') : null;
    case 'sneak': return h.on !== undefined ? ['sneak', h.on ? 'on' : 'off', ...rest].join(' ') : null;
    case 'jump': return ['jump', ...(h.n !== undefined ? [String(h.n)] : []), ...rest].join(' ');
    case 'eat': return h.item ? ['eat', h.item, ...rest].join(' ') : null;
    case 'equip': return h.item ? ['equip', h.item, ...(h.slot ? [h.slot] : []), ...rest].join(' ') : null;
    case 'craft': return h.item ? ['craft', h.item, ...(h.count !== undefined ? [String(h.count)] : []), ...rest].join(' ') : null;
    case 'pickup': return ['pickup', ...(h.range !== undefined ? [`range=${h.range}`] : []), ...(h.target ? [`target=${h.target}`] : []), ...rest].join(' ');
    case 'look':
      if (h.to) return ['look', pos(h.to), ...rest].join(' ');
      return h.yaw !== undefined && h.pitch !== undefined ? ['look', `yaw=${h.yaw}`, `pitch=${h.pitch}`, ...rest].join(' ') : null;
    case 'attack':
      return h.target ? ['attack', h.target, ...(h.hold === true ? ['hold'] : []), ...(h.seconds !== undefined ? [`seconds=${h.seconds}`] : []), ...(h.untilDead !== undefined ? [`untilDead=${h.untilDead}`] : []), ...rest].join(' ') : null;
    case 'use': return h.item && h.at?.length === 1 ? ['use', h.item, pos(h.at[0]!), ...(h.face ? [`face=${h.face}`] : []), ...rest].join(' ') : null;
    default: return null;
  }
}

/** 1 行 → 手。読めない行は { error }。 */
export function lineToHand(line: string): ActHand | { error: string } {
  const text = line.trim();
  if (text.startsWith('json ')) {
    try { return JSON.parse(text.slice(5)) as ActHand; } catch { return { error: `json の行が読めない: ${text.slice(0, 40)}` }; }
  }
  const [verb, ...tokens] = text.split(/\s+/u);
  const hand: Fields = { do: verb };
  const cells: Array<{ x: number; y: number; z: number }> = [];
  const words: string[] = [];
  for (const token of tokens) {
    const cell = readPos(token);
    if (cell) cells.push(cell);
    else if (token === 'rel') hand.rel = true;
    else if (token === 'sprint') hand.sprint = true;
    else if (token === 'exposeOk') hand.exposeOk = true;
    else if (token === 'takeOk') hand.takeOk = true;
    else if (token === 'hold') hand.hold = true;
    else if (/^[A-Za-z]+=/u.test(token)) {
      const [key, ...value] = token.split('=');
      const raw = value.join('=');
      const number = Number(raw);
      hand[key!] = raw === 'false' ? false : raw === 'true' ? true : raw !== '' && Number.isFinite(number) ? number : raw;
    } else words.push(token);
  }
  const bad = (reason: string) => ({ error: `${verb}: ${reason}` });
  switch (verb) {
    case 'walk':
      if (!cells.length) return bad('座標が無い');
      if (cells.length === 1) hand.to = cells[0]; else hand.path = cells;
      return hand as unknown as ActHand;
    case 'dig':
      if (!cells.length) return bad('座標が無い');
      hand.at = cells;
      return hand as unknown as ActHand;
    case 'place':
      if (!cells.length || !words[0]) return bad('ブロック名と座標が要る');
      hand.block = words[0];
      hand.at = cells;
      return hand as unknown as ActHand;
    case 'pillarUp': {
      const n = words.find(word => /^\d+$/u.test(word)), block = words.find(word => !/^\d+$/u.test(word));
      if (n) hand.n = Number(n);
      if (block) hand.block = block;
      return hand as unknown as ActHand;
    }
    case 'wait': return /^[\d.]+$/u.test(words[0] ?? '') ? { ...hand, seconds: Number(words[0]) } as unknown as ActHand : bad('秒が要る');
    case 'sneak': return words[0] === 'on' || words[0] === 'off' ? { ...hand, on: words[0] === 'on' } as unknown as ActHand : bad('on か off');
    case 'jump': return (/^\d+$/u.test(words[0] ?? '') ? { ...hand, n: Number(words[0]) } : hand) as unknown as ActHand;
    case 'eat': return words[0] ? { ...hand, item: words[0] } as unknown as ActHand : bad('物の名前が要る');
    case 'equip': return words[0] ? { ...hand, item: words[0], ...(words[1] ? { slot: words[1] } : {}) } as unknown as ActHand : bad('物の名前が要る');
    case 'craft': return words[0] ? { ...hand, item: words[0], ...(words[1] && /^\d+$/u.test(words[1]) ? { count: Number(words[1]) } : {}) } as unknown as ActHand : bad('物の名前が要る');
    case 'pickup': return hand as unknown as ActHand;
    case 'look':
      if (cells.length) hand.to = cells[0];
      return hand as unknown as ActHand;
    case 'attack': return words[0] ? { ...hand, target: words[0] } as unknown as ActHand : bad('相手が要る');
    case 'use':
      if (!words[0] || !cells.length) return bad('物の名前と座標が要る');
      return { ...hand, item: words[0], at: [cells[0]!] } as unknown as ActHand;
    default: return bad(`知らない手 ${String(verb)}`);
  }
}

export interface ShortAct { why?: string; hands: string[]; stopIf?: string; accept?: string[] }
/** act 全体 → 短い書き方。 */
export function actToShort(input: ActInput): ShortAct {
  const out: ShortAct = { ...(input.why ? { why: input.why } : {}), hands: input.hands.map(handToLine) };
  // blockChanged（見張るマス）は短い書き方に無い（記録に出たら往復の試験が数える）。
  const stop = input.stopIf ? Object.entries(input.stopIf).filter(([key]) => key !== 'blockChanged') : [];
  if (stop.length) out.stopIf = stop.map(([key, value]) => `${key}=${String(value)}`).join(' ');
  if (input.accept?.length) out.accept = [...input.accept];
  return out;
}
/** 短い書き方 → act。読めない行は errors に（act は読めた手だけ）。 */
export function shortToAct(input: unknown): { act: ActInput; errors: string[] } {
  const value = (input ?? {}) as { why?: unknown; hands?: unknown; stopIf?: unknown; accept?: unknown };
  const errors: string[] = [];
  const hands: ActHand[] = [];
  const lines = Array.isArray(value.hands) ? value.hands : typeof value.hands === 'string' ? value.hands.split('\n') : [];
  if (!lines.length) errors.push('hands が無い');
  for (const line of lines) {
    if (typeof line !== 'string' || !line.trim()) continue;
    const hand = lineToHand(line);
    if ('error' in hand) errors.push(hand.error); else hands.push(hand);
  }
  const act: Fields = { hands };
  if (typeof value.why === 'string') act.why = value.why;
  if (typeof value.stopIf === 'string' && value.stopIf.trim()) {
    const stopIf: Fields = {};
    for (const token of value.stopIf.trim().split(/\s+/u)) {
      const [key, raw] = token.split('=');
      if (key && raw !== undefined && Number.isFinite(Number(raw))) stopIf[key] = Number(raw); else errors.push(`stopIf が読めない: ${token}`);
    }
    act.stopIf = stopIf;
  }
  if (Array.isArray(value.accept)) act.accept = value.accept.filter(item => typeof item === 'string');
  return { act: act as unknown as ActInput, errors };
}
