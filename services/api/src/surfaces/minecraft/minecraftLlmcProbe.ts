import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { MC_ACT_TOOL, type ActHand, type ActInput, type ActPos } from '../../contracts/minecraftActContract.js';
import type { ProbeInput, WorldScan } from '../../contracts/minecraftProbeContract.js';
import { normalizeActInput } from './minecraftLlmcShape.js';
import { llmcTokens } from './minecraftLlmcLive.js';
import { clamp, COLUMN_DOWN, COLUMN_UP, finite, LLMC_PROBE, plain, posText, probeAnswerText, probeLabel } from './minecraftLlmcProbeInput.js';

export { LLMC_PROBE } from './minecraftLlmcProbeInput.js';
/**
 * mb-llmc r4 (owner 2026-10-22, shared note `r4-contract.md` 1–2; arch-check 6: the code that probes after a surprise and says what it found
 * was the fastest and cheapest of five ways, 7.4 s and $0.019 a decision, as right as Opus as it is; a model left to probe by itself did not
 * call its tools in 2 of 6 scenes). Three parts:
 *
 * 1. `mc.probe` as the model writes it, put into the body's form (`prepareProbeInput`): a creature named is sent as its `#id`, a column
 *    always with its x, z and y bounds, a radius within its kind's range.
 * 2. The surprises of a step (`createSurpriseWatch`), from the facts alone: health down 5 or more in one decision or under 10, air under 10,
 *    a fall of 5 or more, the same stop or refusal twice, no hit or the same dig stopped three times, a find-blocks far from the plan's
 *    place. Each names its fixed probes (at most 2 a step).
 * 3. The probing itself before the decision (`runInvestigation`): the probes sent at once, the answers that came within the time said in
 *    the live state first (`驚き: …` then `調べ …: …`), at most `LLMC_PROBE.tokens` in all; past the time it goes on without them.
 *
 * How an answer reads matters (arch-check 6, S1: a prototype wrote 「切れ目：足元の土」 and the model dug the earth and fell seven blocks): the
 * body says the dangerous fact as it is (「下 7 段は空気（落差 7）」), and the head adds only the coordinates a hand can use (a path's points,
 * where to stand, what is in between), never a word of its own about what to dig.
 */
/**
 * One surprise of a step: its closed code (for the metrics line), its line, and its fixed probes. r5: `nth`, how many times this same one
 * has come (the second notes its fact as a caution, `minecraftLlmcCaution.ts`), and the stopped hand it came from.
 */
export interface Surprise { code: 'health' | 'oxygen' | 'fall' | 'repeat' | 'dig' | 'miss' | 'found'; line: string; probes: ProbeInput[];
  nth?: number; hand?: { do: string; aim: ActPos | null; line: string } | null }
/** What the watch reads of a frame; r5: `items`, the dropped items near her, nearest first (a pickup's surprise looks at one). */
export interface SurpriseFrame { health: number | null; oxygen: number | null; feet: ActPos | null; dimension: string | null; arrival: number | null;
  items?: ActPos[] }
export function surpriseFrame(observation: BodyObservation | null, arrival: number | null): SurpriseFrame {
  const world = plain(observation?.state.world) ?? {};
  const at = plain(world.position);
  const feet = at && [at.x, at.y, at.z].every(value => typeof value === 'number' && Number.isFinite(value))
    ? { x: at.x as number, y: at.y as number, z: at.z as number } : null;
  const dimension = world.dimension ?? observation?.facts.dimension;
  return { health: finite(world.health), oxygen: finite(world.oxygen), feet, arrival, items: droppedItems(world.nearbyEntities),
    dimension: typeof dimension === 'string' ? dimension.replace(/^minecraft:/u, '') : null };
}
/** The dropped items of a frame's entities (`name: item`), nearest first, as whole blocks (at most 4). */
function droppedItems(entities: unknown): ActPos[] {
  return (Array.isArray(entities) ? entities : []).flatMap(item => {
    const entity = plain(item), at = plain(entity?.position);
    const x = finite(at?.x), y = finite(at?.y), z = finite(at?.z);
    return entity?.name === 'item' && x !== null && y !== null && z !== null
      ? [{ at: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, distance: finite(entity.distance) ?? 99 }] : [];
  }).sort((left, right) => left.distance - right.distance).slice(0, 4).map(item => item.at);
}

/** The stop words that are no surprise of the decision's own (a reflex or a stopIf cut it: the urgent step's; a full pack says itself). */
const NOT_A_STOP = new Set(['反射', 'stopIf', '満杯', '未実行']);
/** A hand that hit nothing: 「0回当たった」, 「当てた 0回」, a hold's 「0回打った」. */
const NO_HIT = /(?:^|[^\d])0回当たった|当てた 0回|(?:^|[^\d])0回打った/u;
interface ActRecord {
  /** `do:reason` of the stopped (or failed) hand, or of a refusal; null for an act that went as asked. */
  key: string | null; reason: string | null; dig: boolean; miss: boolean;
  /** Where the stopped hand went (a walk's) or what it aimed at (a dig's, a use's, an attack's; r5: a pickup's drop its line names). */
  dest: ActPos | null; target: ActPos | string | null;
  /** r5: the stopped hand's kind and its line as the result said it (for the fact noted at a second surprise). */
  hand?: { do: string; line: string } | null;
  /** r6: the attack hand that hit nothing, as its line said it (the fact of a second miss when no sight answered). */
  missHand?: { do: string; line: string } | null;
}
/** The act's hands as the body ran them (the model's input in the contract's shape). */
function handsOf(input: unknown): readonly ActHand[] {
  try {
    const hands = (normalizeActInput(input).input as ActInput | null)?.hands;
    return Array.isArray(hands) ? hands : [];
  } catch { return []; }
}
/** Where a hand went or what it aimed at (its own coordinates; a rel hand's are not known here). */
function aimOf(hand: ActHand | undefined): Pick<ActRecord, 'dest' | 'target'> {
  if (!hand || hand.rel) return { dest: null, target: null };
  if (hand.do === 'walk') return { dest: hand.path?.length ? hand.path[hand.path.length - 1]! : hand.to ?? null, target: null };
  if (hand.do === 'attack' || hand.do === 'shoot') return { dest: null, target: hand.target ?? hand.at?.[0] ?? null };
  return { dest: null, target: hand.at?.[0] ?? null };
}
/** One act's result read for the watch (its text as `actResultText` wrote it, and its input). */
export function readActRecord(ok: boolean, text: string, input: unknown): ActRecord {
  const hands = handsOf(input), lines = text.split('\n');
  // An attack hand that hit nothing, and what it aimed at.
  const missedLine = lines.find(line => /^\d+ attack /u.test(line) && NO_HIT.test(line));
  const miss = missedLine !== undefined, missed = miss ? Number(/^(\d+)/u.exec(missedLine)![1]) : null;
  // r6: a hold with no target names the nearest one in its line (the body's r6 words: 「最寄り blaze #9 (308,69,73) …」).
  const missAim = miss ? aimOf(hands[missed! - 1]).target ?? nearestNamed(missedLine) : null;
  const missHand = miss ? { do: 'attack', line: missedLine.replace(/^\d+ attack \S+ /u, '').slice(0, 160) } : null;
  for (const line of lines) {
    const match = /^(\d+) ([A-Za-z]+) [止失] (.+)$/u.exec(line);
    if (!match) continue;
    const reason = match[3]!.split(/[:：]/u)[0]!.trim().slice(0, 16);
    if (NOT_A_STOP.has(reason)) continue;
    const hand = hands[Number(match[1]) - 1];
    const aim = aimOf(hand);
    // r5: a pickup names no place in its input; the drop is where its line says (the body's r5 words), when it does.
    const target = aim.target ?? (match[2] === 'pickup' ? firstPos(match[3]!) : null) ?? missAim;
    return { key: `${match[2]}:${reason}`, reason, dig: match[2] === 'dig', miss, dest: aim.dest, target,
      hand: { do: match[2]!, line: match[3]!.slice(0, 160) }, missHand };
  }
  // A refusal before the body (not a shape the result already names: the act's own fields say how to mend it).
  if (!ok && !/^(act |急ぎ: |（頭が形を直して送った)/u.test(text) && !/^引数が|^手\d+（/u.test(text)) {
    const words = lines[0]!.replace(/[0-9.]+/gu, 'n').slice(0, 24);
    return { key: `拒否:${words}`, reason: words, dig: false, miss, dest: null, target: missAim, missHand };
  }
  return { key: null, reason: null, dig: false, miss, dest: null, target: missAim, missHand };
}

const WINDOW = 6, REPEAT_COOLDOWN = 4, OXYGEN_COOLDOWN = 3, FOUND_METERS = 24;
interface WatchState {
  last: SurpriseFrame | null; acts: ActRecord[]; fresh: ActRecord[]; found: ActPos | null; step: number; probed: Map<string, number>;
  /** r5: how many times each surprise (its probe key) has come. */
  fired: Map<string, number>;
}
const watches = new Map<string, WatchState>();
function watchOf(taskId: string): WatchState {
  let state = watches.get(taskId);
  if (!state) {
    state = { last: null, acts: [], fresh: [], found: null, step: 0, probed: new Map(), fired: new Map() };
    watches.set(taskId, state);
    if (watches.size > 32) watches.delete(watches.keys().next().value as string);
  }
  return state;
}
const firstPos = (text: string): ActPos | null => {
  const match = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/u.exec(text);
  return match ? { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) } : null;
};
/** The creature a line names after 「最寄り」 (its `#id`, else its place), or null. */
const nearestNamed = (line: string): ActPos | string | null => {
  const tail = line.split('最寄り')[1];
  if (!tail) return null;
  return /^\s*\S+ (#\d+)/u.exec(tail)?.[1] ?? firstPos(tail);
};
const around = (): ProbeInput => ({ kind: 'around', radius: 8 });
const column = (feet: ActPos, bounds: { up: number; down: number }): ProbeInput => ({ kind: 'column', x: Math.floor(feet.x), z: Math.floor(feet.z),
  yFrom: clamp(Math.floor(feet.y) + bounds.up, -64, 320), yTo: clamp(Math.floor(feet.y) - bounds.down, -64, 320) });
const block = (feet: ActPos): ActPos => ({ x: Math.floor(feet.x), y: Math.floor(feet.y), z: Math.floor(feet.z) });
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * A task's watch for surprises (kept across its steps). `noteResult` takes each body result as it comes; `detect`, once a step before its
 * decision, compares the frame now with the one the last decision read and the results since, and names the surprises and their probes
 * (the shared note's list; the same repeated stop is probed again only after `REPEAT_COOLDOWN` steps, low air every `OXYGEN_COOLDOWN`).
 */
export function createSurpriseWatch(taskId: string) {
  const state = watchOf(taskId);
  return {
    noteResult(name: string, ok: boolean, text: string, input: unknown): void {
      if (name === MC_ACT_TOOL) {
        const record = readActRecord(ok, text, input);
        state.fresh.push(record);
        state.acts.push(record);
        if (state.acts.length > WINDOW) state.acts.splice(0, state.acts.length - WINDOW);
      } else if (name === 'mc.find-blocks' && ok) state.found = firstPos(text);
    },
    detect(frame: SurpriseFrame, planWhere: string | null): Surprise[] {
      state.step += 1;
      const prev = state.last, fresh = state.fresh.splice(0), found = state.found;
      state.last = frame;
      state.found = null;
      const due = (key: string, every: number) => {
        const at = state.probed.get(key);
        if (at !== undefined && state.step - at < every) return false;
        state.probed.set(key, state.step);
        if (state.probed.size > 32) state.probed.delete(state.probed.keys().next().value as string);
        state.fired.set(key, (state.fired.get(key) ?? 0) + 1);
        if (state.fired.size > 64) state.fired.delete(state.fired.keys().next().value as string);
        return true;
      };
      const nth = (key: string) => state.fired.get(key) ?? 1;
      const foundOne = foundSurprise(found, planWhere);
      if (foundOne.length && found) {
        const key = `found:${posText(found)}`;
        state.fired.set(key, (state.fired.get(key) ?? 0) + 1);
        foundOne[0]!.nth = nth(key);
      }
      return [...bodySurprises(prev, frame, due), ...actSurprises(state.acts, fresh, frame, due, nth), ...foundOne];
    },
  };
}
type Due = (key: string, every: number) => boolean;
/** Health, a fall, air: from the frame now and the one the last decision read. */
function bodySurprises(prev: SurpriseFrame | null, frame: SurpriseFrame, due: Due): Surprise[] {
  // The body arrived again (a death, a login) or crossed into another dimension: health and height are not this decision's to compare.
  const comparable = prev !== null && prev.arrival === frame.arrival && prev.dimension === frame.dimension;
  const feet = frame.feet;
  if (!feet) return [];
  const air = frame.oxygen !== null && frame.oxygen < 10 && due('oxygen', OXYGEN_COOLDOWN)
    ? [{ code: 'oxygen' as const, line: `酸素 ${round1(frame.oxygen!)}（10 未満）`, probes: [column(feet, COLUMN_UP), around()] }] : [];
  return [...(comparable ? [...healthSurprise(prev, frame, feet), ...fallSurprise(prev, feet)] : []), ...air];
}
/** Health down 5 or more in one decision, or under 10 now. */
function healthSurprise(prev: SurpriseFrame, frame: SurpriseFrame, feet: ActPos): Surprise[] {
  if (prev.health === null || frame.health === null) return [];
  const lost = prev.health - frame.health;
  if (lost < 5 && !(frame.health < 10 && prev.health >= 10)) return [];
  return [{ code: 'health', line: `体力 ${round1(prev.health)}→${round1(frame.health)}（1 判断で −${round1(Math.max(0, lost))}）`,
    probes: [around(), column(feet, COLUMN_DOWN)] }];
}
/** Five blocks or more down in one decision. */
function fallSurprise(prev: SurpriseFrame, feet: ActPos): Surprise[] {
  if (!prev.feet || prev.feet.y - feet.y < 5) return [];
  const from = Math.floor(prev.feet.y), to = Math.floor(feet.y);
  return [{ code: 'fall', line: `1 判断で ${from - to} 段下がった（y ${from}→${to}）`, probes: [column(feet, COLUMN_DOWN), around()] }];
}
/** The same stop twice, the same dig stopped three times, no hit: from the acts since the last decision and the window before. */
function actSurprises(acts: readonly ActRecord[], fresh: readonly ActRecord[], frame: SurpriseFrame, due: Due,
  nth: (key: string) => number = () => 1): Surprise[] {
  const out: Surprise[] = [], latest = fresh.at(-1);
  const sight = (target: ActPos | string | null): ProbeInput[] => target ? [{ kind: 'sight', target }] : [];
  const hand = (record: ActRecord) => record.hand
    ? { ...record.hand, aim: record.dest ?? (typeof record.target === 'object' ? record.target : null) } : null;
  if (latest?.key) {
    const same = acts.filter(item => item.key === latest.key).length;
    const digs = latest.dig ? same : 0;
    if (digs >= 3 && due(`dig:${latest.key}`, REPEAT_COOLDOWN)) {
      out.push({ code: 'dig', line: `同じ掘りの中止が ${digs} 回: 「${latest.reason}」`, probes: [...sight(latest.target), around()],
        nth: nth(`dig:${latest.key}`), hand: hand(latest) });
    } else if (same >= 2 && due(`repeat:${latest.key}`, REPEAT_COOLDOWN)) {
      const [kind, reason] = latest.key.startsWith('拒否:') ? ['拒否', latest.reason] : latest.key.split(':');
      const next: ProbeInput[] = latest.dest ? [{ kind: 'path', to: latest.dest }] : latest.key.startsWith('pickup:')
        ? dropProbe(latest.target, frame) : sight(latest.target);
      out.push({ code: 'repeat', line: `同じ止まりの ${same} 回目: ${kind}「${reason}」`,
        probes: [...(frame.feet ? [{ kind: 'history' as const, at: block(frame.feet), radius: 4 }] : []), ...next],
        nth: nth(`repeat:${latest.key}`), hand: hand(latest) });
    }
  }
  return [...out, ...missSurprise(fresh, due, nth)];
}
/**
 * An attack that hit nothing: a sight of what it aimed at and around. r6 (run 29: two misses, no count, so the second never noted its
 * fact): counted as every other surprise, with the hand that missed.
 */
function missSurprise(fresh: readonly ActRecord[], due: Due, nth: (key: string) => number): Surprise[] {
  if (!fresh.some(item => item.miss) || !due('miss', 2)) return [];
  const aimed = [...fresh].reverse().find(item => item.miss && item.target)?.target ?? null;
  const missed = [...fresh].reverse().find(item => item.missHand)?.missHand ?? null;
  return [{ code: 'miss', line: '攻撃が 1 度も当たらなかった（当たり 0）', probes: [...(aimed ? [{ kind: 'sight' as const, target: aimed }] : []), around()],
    nth: nth('miss'), hand: missed ? { ...missed, aim: typeof aimed === 'object' ? aimed : null } : null }];
}
/** A drop within this many blocks of her feet is looked at (sight: a wall, a hole between); farther, the way to it (path). */
const DROP_SIGHT_METERS = 6;
/**
 * r5 (run 28: 19 pickups stopped with 「無い」, the drop behind a wall or where her head did not fit, and the repeat's probe was the history
 * alone, a pickup naming no place): the drop its line names, else the nearest dropped item of the frame; a sight to it when near, else a path.
 */
function dropProbe(named: ActPos | string | null, frame: SurpriseFrame): ProbeInput[] {
  const drop = typeof named === 'object' && named ? named : frame.items?.[0] ?? null;
  if (!drop) return [];
  const near = !frame.feet || Math.hypot(drop.x - frame.feet.x, drop.y - frame.feet.y, drop.z - frame.feet.z) <= DROP_SIGHT_METERS;
  return [near ? { kind: 'sight', target: drop } : { kind: 'path', to: drop }];
}
/** A find-blocks far from the current plan node's place. */
function foundSurprise(found: ActPos | null, planWhere: string | null): Surprise[] {
  const planned = planWhere ? firstPos(planWhere) : null;
  if (!found || !planned || Math.hypot(found.x - planned.x, found.z - planned.z) <= FOUND_METERS) return [];
  return [{ code: 'found', line: `find-blocks が計画の where ${posText(planned)} と違う所 ${posText(found)} を指した`, probes: [{ kind: 'path', to: found }] }];
}
export type SurpriseWatch = ReturnType<typeof createSurpriseWatch>;

/**
 * The probes of a step: in the surprises' order (the dangers first), each once, at most `LLMC_PROBE.maxProbes`. r6 (run 29: a health
 * surprise took both places with its around and column, and the miss's sight never went): each surprise's first probe first, then the rest.
 */
export function stepProbes(surprises: readonly Surprise[]): ProbeInput[] {
  const out: ProbeInput[] = [], seen = new Set<string>();
  const firsts = surprises.flatMap(item => item.probes.slice(0, 1)), rest = surprises.flatMap(item => item.probes.slice(1));
  for (const probe of [...firsts, ...rest]) {
    const key = probe.kind === 'around' ? 'around' : JSON.stringify(probe);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(probe);
    if (out.length >= LLMC_PROBE.maxProbes) break;
  }
  return out;
}

/** The last line of an investigation (the knowledge says the rest). */
export const INVESTIGATION_TAIL = '→ 調べた事実で前提（道・高さ・届く所・材料の所）を見直してから手を変える。原因が分かったら plan.update で forbid・caution に書く';

/**
 * The investigation of a step: the surprises, then each probe's answer that came within `budgetMs` (all sent at once through `run`, which
 * gives the body's result text or null), cut to `tokens` together. A probe not answered in time is named as such and left (its command
 * ends by itself; its answer is not read). Never throws.
 */
export async function runInvestigation(parts: { surprises: readonly Surprise[]; probes: readonly ProbeInput[]; feet: ActPos | null;
  run: ((input: ProbeInput, index: number) => Promise<string | null>) | null; budgetMs: number; tokens?: number; now?: () => number }):
  Promise<{ lines: string[]; answered: number; ms: number; answers: Array<string | null | undefined> }> {
  const now = parts.now ?? (() => performance.now()), began = now(), tokens = parts.tokens ?? LLMC_PROBE.tokens;
  const head = parts.surprises.slice(0, 3).map(item => `驚き: ${item.line}`);
  const answers: Array<string | null | undefined> = parts.probes.map(() => undefined);
  if (parts.run && parts.probes.length) {
    const jobs = parts.probes.map((probe, index) => (async () => {
      try { answers[index] = await parts.run!(probe, index); } catch { answers[index] = null; }
    })());
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(jobs), new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, parts.budgetMs)); })]);
    clearTimeout(timer);
  }
  const answered = answers.filter(item => typeof item === 'string').length;
  const lines = parts.probes.map((probe, index) => {
    const answer = answers[index], label = `調べ ${probeLabel(probe, parts.feet)}`;
    if (!parts.run) return null;
    if (answer === undefined) return `${label}: 時間切れ（添えずに進めた。要るなら mc.probe で）`;
    return answer === null ? `${label}: 答えが無かった` : `${label}: ${probeAnswerText(answer, true)}`;
  }).filter((line): line is string => line !== null);
  return { lines: fitInvestigation([...head, ...lines, ...(head.length ? [INVESTIGATION_TAIL] : [])], tokens), answered, ms: Math.round(now() - began),
    answers: [...answers] };
}
/** The lines within `tokens` (`llmcTokens` of their JSON): the longest line cut first, by halves, never under 40 characters. */
export function fitInvestigation(lines: readonly string[], tokens: number): string[] {
  const out = [...lines];
  const size = () => llmcTokens(JSON.stringify(out));
  for (let guard = 0; guard < 64 && size() > tokens; guard += 1) {
    let longest = 0;
    out.forEach((line, index) => { if (line.length > out[longest]!.length) longest = index; });
    const line = out[longest]!;
    if (line.length > 40) out[longest] = `${line.slice(0, Math.max(40, Math.floor(line.length * 0.6)))}…`;
    else out.pop();
  }
  return out;
}

/**
 * The body's scan as the live state shows it once (at most 10 lines: what it is and when, its words, its first rows); after a portal, the
 * line that the plan's next nodes are to be looked at again with it. Null when there is none or it was shown (`shownAt`).
 */
export function scanLines(scan: unknown, shownAt: string | null): { lines: string[]; at: string } | null {
  const value = plain(scan) as Partial<WorldScan> | null;
  if (!value || typeof value.at !== 'string' || typeof value.text !== 'string' || value.at === shownAt) return null;
  const portal = value.trigger === 'portal';
  // r5: the body's first row says the range it read (「範囲 読み込み …」), so one row more is shown (still 10 lines at most).
  const rows = (Array.isArray(value.rows) ? value.rows : []).filter(row => typeof row === 'string').slice(0, portal ? 8 : 9).map(row => row.slice(0, 120));
  const words = { login: 'ログイン', reconnect: '再接続', respawn: 'リスポーン', portal: '次元の移動' } as Record<string, string>;
  return { at: value.at, lines: [`走査（${words[value.trigger ?? ''] ?? '体'}の後${value.dimension ? `・${String(value.dimension).replace(/^minecraft:/u, '')}` : ''}`
    + `${typeof value.reach === 'number' ? `・${Math.round(value.reach)}m 内` : ''}）: ${value.text.slice(0, 300)}`, ...rows,
    ...(portal ? ['次元が変わった: この走査で、計画の次の節（材料・場所・順番）を plan.update で見直す'] : [])] };
}
/** The scan as the first plan reads it: its words and every row. */
export function scanForPlan(scan: unknown): string | null {
  const value = plain(scan) as Partial<WorldScan> | null;
  if (!value || typeof value.text !== 'string') return null;
  const rows = (Array.isArray(value.rows) ? value.rows : []).filter(row => typeof row === 'string').slice(0, 20);
  return [value.text.slice(0, 400), ...rows.map(row => `- ${row.slice(0, 160)}`)].join('\n');
}

/** For tests: no task holds a watch. */
export function forgetSurpriseWatches(): void { watches.clear(); }
