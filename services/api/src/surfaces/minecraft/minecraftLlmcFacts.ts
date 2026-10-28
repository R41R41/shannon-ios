import type { PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ControlHolder, ControlView, LifeView } from '../../contracts/continueContract.js';
import type { ActHand, ActInput, ActPos } from '../../contracts/minecraftActContract.js';
import { readActResult } from '../../contracts/minecraftActContract.js';
import { carriedItemCounts, EDIBLE_FOOD } from './minecraftItems.js';
import { FOOD_POINTS, stacks } from './minecraftLlmcLive.js';
import { nearThreats } from './minecraftLlmcThreat.js';
import { markDelivered, offer, pending, type OnceFact } from './minecraftLlmcOnceFacts.js';
import { packFacts, PACK_SLOTS } from './minecraftLlmcPack.js';
import { promiseLines } from './minecraftLlmcPromises.js';
import { FOOD_FISH, nearNeeds } from './minecraftLlmcReachWords.js';
import { PLAN_FACTS_KEY, type PlanFacts } from './minecraftPlanFacts.js';
import { round1 } from './minecraftTransientObservation.js';

/**
 * The facts a decision must be given whatever version of the input it reads (the continue contract, chapter 8, 「判断に届ける事実」: the normal input, the urgent one, and the
 * one after the live state was shortened). One line each, in the words of what is, and **none says what to do** (the model decides; the instructions' words are not added to).
 *
 * | fact | lines |
 * |---|---|
 * | health, hunger, the food she carries and what eating it gives | `vitalsLine` |
 * | the blows taken in the last 10 s (a count and an amount) | `createHitWatch` (the body's frames carry no log of blows: the watch reads her health frame to frame) |
 * | who holds the body now and her life's number | `holderLine` (`state.control`, `state.life`) |
 * | the promises | `promiseLines` (four at most) |
 * | the pack's free slots, what the queue's next hands add, what fills it | `packLines` |
 * | the creatures near that she can eat (animals and fish) | `foodCandidates` |
 * | the queue's items with what each hand will do | `queueNowLines` |
 * | where a go or a vertical stopped and how far the goal is from there | `stopFactsOf` (from the act's result, not its words) |
 *
 * The numbers (24 m, three candidates, the 10 s window) are first values and a guess; they are said in the code once (below).
 */
export const FACT_WINDOW_MS = 10_000;
/** The creatures that are food are listed within this many metres (the near words' own reach for food animals). */
export const FOOD_NEAR_METERS = 24;
/** Food candidates an urgent or shortened input keeps; the normal input lists up to `FOOD_NORMAL_MAX`, and at least this many when there are. */
export const FOOD_KEPT = 3, FOOD_NORMAL_MAX = 6;
/** A blow is told with the hostile that stood within this many metres when it fell. */
const HIT_BY_METERS = 6;
const HITS_KEPT = 16;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const one = (value: number): string => value.toFixed(1);
const cell = (at: ActPos | null | undefined): string => at ? `(${at.x},${at.y},${at.z})` : '';
const world = (observation: BodyObservation | null): Rec => rec(observation?.state.world) ?? {};

// ---- who holds the body, and the life -------------------------------------------------------------------------------------------------------

const HOLDERS: ReadonlySet<string> = new Set(['idle', 'command', 'reflex', 'bridge', 'cleanup']);
/**
 * The body's `state.control` (contract 4), or null when the frame has none. Written for the frame as the body writes it; a field it leaves out is left out here
 * (the reader tolerates a holder without its `since` and ids). The life's own reader may take this over.
 */
export function controlOf(observation: BodyObservation | null): ControlView | null {
  const raw = rec(observation?.state.control), holder = rec(raw?.holder);
  if (!raw || !holder || typeof holder.kind !== 'string' || !HOLDERS.has(holder.kind)) return null;
  const episode = rec(raw.reflexEpisode), mark = rec(raw.combatMark);
  return { holder: holder as unknown as ControlHolder,
    ...(episode && typeof episode.reflex === 'string' ? { reflexEpisode: episode as unknown as NonNullable<ControlView['reflexEpisode']> } : {}),
    ...(mark && typeof mark.skill === 'string' ? { combatMark: mark as unknown as NonNullable<ControlView['combatMark']> } : {}),
    waiting: (Array.isArray(raw.waiting) ? raw.waiting : []).filter((item): item is ControlView['waiting'][number] => !!rec(item) && typeof rec(item)!.command === 'string') };
}
/** The body's life, `state.life` first and `facts.life` (the bare number) else; null when the frame has neither. */
export function lifeOf(observation: BodyObservation | null): Pick<LifeView, 'life'> & Partial<LifeView> | null {
  const raw = rec(observation?.state.life);
  if (raw && Number.isSafeInteger(raw.life)) return raw as unknown as Pick<LifeView, 'life'> & Partial<LifeView>;
  const bare = observation?.facts.life;
  return typeof bare === 'number' && Number.isSafeInteger(bare) ? { life: bare } : null;
}
/** The holder in words: 「反射 floor-melee（相手 #2601）」, 「命令 q52（attack）」, 「無し」. */
export function holderWords(holder: ControlHolder, view?: ControlView | null): string {
  switch (holder.kind) {
    case 'idle': return '無し（止まっている）';
    case 'command': return `命令 ${holder.command}${holder.item ? `（${holder.item}）` : ''}`;
    case 'reflex': {
      const fight = view?.reflexEpisode ? `。この戦いで ${view.reflexEpisode.hands} 手・${view.reflexEpisode.hits} 打` : '';
      return `反射 ${holder.reflex}${holder.target !== undefined ? `（相手 #${holder.target}）` : ''}${holder.episode && !fight ? '（戦いが続いている）' : ''}${fight}`;
    }
    case 'bridge': return `反射の後のつなぎ（${holder.hold === 'shield' ? '盾を構えている' : '一歩下がっている'}・${holder.after} の後${holder.target !== undefined ? `・相手 #${holder.target}` : ''}）`;
    case 'cleanup': return `片付け（${holder.command}）`;
    default: return '不明';
  }
}
/** 「体を動かしている物: 反射 floor-melee（相手 #2601）・命 3」; null when the frame says neither the holder nor the life. */
export function holderLine(observation: BodyObservation | null): string | null {
  const control = controlOf(observation), life = lifeOf(observation), episode = control?.reflexEpisode;
  const parts = [
    ...control ? [`体を動かしている物: ${holderWords(control.holder, control)}`] : [],
    // The reflex's fight goes on while it lets the lock go for a moment (the holder is then not the reflex): it is told beside the holder.
    ...control && episode && control.holder.kind !== 'reflex'
      ? [`反射 ${episode.reflex} の戦いが続いている（${episode.target !== undefined ? `相手 #${episode.target}・` : ''}${episode.hands} 手・${episode.hits} 打）`] : [],
    ...life ? [`命 ${life.life}`] : [],
    ...control?.waiting.length ? [`${control.waiting.length} 件が反射の後を待っている`] : []];
  return parts.length ? parts.join('・') : null;
}

// ---- the blows of the last ten seconds --------------------------------------------------------------------------------------------------------

export interface Hit { at: number; amount: number; by: string | null }
/**
 * The health lost from frame to frame, kept for `FACT_WINDOW_MS`. The body's frame carries her health and no log of blows, so a drop between two frames is one blow here (two
 * blows between two frames are one: the amount is right, the count may be short). It does not say what hit her; the hostile that stood near when it fell is said beside it.
 * Fed by every frame the step reads (`note`), whatever reads it.
 */
export function createHitWatch(now: () => number = Date.now) {
  let last: { health: number; at: number } | null = null, lastSeq: number | null = null, lastRun: string | null = null;
  const hits: Hit[] = [];
  const keep = (at: number) => { while (hits.length && at - hits[0]!.at > FACT_WINDOW_MS) hits.shift(); while (hits.length > HITS_KEPT) hits.shift(); };
  return {
    note(observation: BodyObservation | null, at: number = now()): void {
      const health = finite(world(observation).health);
      if (!observation || health === null) return;
      // A frame of another connection starts the count again (no blow is read across it); an older frame of the same connection is not read (a late frame would read as health lost twice).
      const run = rec(observation.state.bodyRun), key = `${String(run?.bodyBoot ?? '')}/${String(run?.connectionId ?? '')}`;
      if (lastRun !== null && key !== lastRun) last = null;
      else if (lastSeq !== null && observation.sequence <= lastSeq && last && (observation.sequence < lastSeq || last.health === health)) return;
      lastRun = key;
      lastSeq = observation.sequence;
      if (last && health < last.health - 0.04) {
        const near = nearThreats(observation).find(threat => threat.distance <= HIT_BY_METERS);
        hits.push({ at, amount: last.health - health, by: near ? `${near.name}${near.id !== null ? ` #${near.id}` : ''} ${one(near.distance)}m` : null });
      }
      last = { health, at };
      keep(at);
    },
    /** The blows still in the window at `at`, oldest first. */
    recent(at: number = now()): Hit[] { return hits.filter(hit => at - hit.at <= FACT_WINDOW_MS); },
    /** 「直近 10 秒で 2 回ダメージを受けた（合計 10.2: 5.3（9 秒前）・4.9（4 秒前））。その時近くにいた敵: zombie #2601 2.1m」, or null when there was none. */
    line(at: number = now()): string | null {
      const list = hits.filter(hit => at - hit.at <= FACT_WINDOW_MS);
      if (!list.length) return null;
      const total = list.reduce((sum, hit) => sum + hit.amount, 0);
      const by = [...new Set(list.flatMap(hit => hit.by ? [hit.by] : []))].slice(0, 3);
      return `直近 ${FACT_WINDOW_MS / 1000} 秒で ${list.length} 回ダメージを受けた（合計 ${one(total)}: ${list.map(hit => `${one(hit.amount)}（${Math.max(0, Math.round((at - hit.at) / 1000))} 秒前）`).join('・')}）`
        + `${by.length ? `。その時近くにいた敵: ${by.join('・')}` : ''}`;
    },
  };
}
export type HitWatch = ReturnType<typeof createHitWatch>;

// ---- health, hunger and what she can eat ------------------------------------------------------------------------------------------------------

/** The food she carries as 「bread×1（+11 点）」, the best first. */
function foodItems(observation: BodyObservation | null): { text: string; points: number }[] {
  const out: { text: string; points: number }[] = [];
  const w = world(observation);
  for (const [name, count] of carriedItemCounts(w, observation?.facts)) {
    if (!EDIBLE_FOOD.test(name) && !(name in FOOD_POINTS)) continue;
    const each = FOOD_POINTS[name] ?? 2;
    out.push({ text: `${name}×${count}（+${round1(each * count)} 点）`, points: each * count });
  }
  return out.sort((a, b) => b.points - a.points);
}
/** 「体力 6.4/20・満腹 11/20・食べ物 bread×1（+11 点）」. A part the frame does not say is left out; no food is said (「食べ物 無し」) only when the frame lists a pack. */
export function vitalsLine(observation: BodyObservation | null): string | null {
  const w = world(observation), health = finite(w.health), hunger = finite(w.food);
  if (health === null && hunger === null) return null;
  const food = foodItems(observation), listed = Array.isArray(w.inventory) || rec(w.inventory) !== null;
  return [...health !== null ? [`体力 ${round1(health)}/20`] : [], ...hunger !== null ? [`満腹 ${round1(hunger)}/20`] : [],
    ...food.length ? [`食べ物 ${food.slice(0, 5).map(item => item.text).join('・')}`] : listed ? ['食べ物 無し'] : []].join('・');
}

const FOOD_ANIMAL = new Set(['cow', 'pig', 'chicken', 'rabbit', 'mooshroom', 'sheep']);
/** The creatures within 24 m that are food: animals and fish, nearest first, as 「cod #501 18.2m (x,y,z)」. */
export function foodCandidates(observation: BodyObservation | null): { name: string; id: number | null; distance: number; at: ActPos | null }[] {
  const list = Array.isArray(world(observation).nearbyEntities) ? world(observation).nearbyEntities as unknown[] : [];
  return list.flatMap(item => {
    const entity = rec(item), distance = finite(entity?.distance);
    if (!entity || typeof entity.name !== 'string' || distance === null || distance > FOOD_NEAR_METERS) return [];
    if (!FOOD_ANIMAL.has(entity.name) && !FOOD_FISH.has(entity.name)) return [];
    const at = rec(entity.position);
    return [{ name: entity.name, id: Number.isInteger(entity.id) ? entity.id as number : null, distance,
      at: at && finite(at.x) !== null ? { x: Math.floor(Number(at.x)), y: Math.floor(Number(at.y)), z: Math.floor(Number(at.z)) } : null }];
  }).sort((a, b) => a.distance - b.distance);
}
/**
 * Whether food is what the situation is short of: the near words' own reading (food level 14 or less, food points under 40, a food node under the plan, the shortage or the
 * recovery naming food), so the candidates and the near lines (`nearWorthy`) agree. `body` is a live body's parts.
 */
export function wantsFood(parts: { fullness: number | null; points: number; shortage?: string | null; recovery?: readonly string[] | null; planFacts?: PlanFacts | null }): boolean {
  return nearNeeds({ state: { ...parts.fullness !== null ? { fullness: parts.fullness } : {} }, foodPoints: { total: parts.points }, ...parts.shortage ? { shortage: parts.shortage } : {},
    ...parts.recovery?.length ? { recovery: [...parts.recovery] } : {}, ...parts.planFacts ? { [PLAN_FACTS_KEY]: parts.planFacts } : {} }).food;
}
export function foodLine(observation: BodyObservation | null, shown: number): string | null {
  const list = foodCandidates(observation).slice(0, shown);
  if (!list.length) return null;
  return `近くの食べ物の候補（${FOOD_NEAR_METERS} m 以内の動物と魚）: ${list.map(item => `${item.name}${item.id !== null ? ` #${item.id}` : ''} ${one(item.distance)}m${item.at ? ` ${cell(item.at)}` : ''}`).join('・')}`;
}

// ---- the pack, and the queue ----------------------------------------------------------------------------------------------------------------

/** What one hand does, in the hand's own words, for the queue's line: where it goes, what it places, digs, makes, whom it hits. */
export function handEffect(hand: ActHand): string {
  const where = (at: readonly ActPos[] | undefined, extra = '') => at?.length ? ` ${cell(at[0])}${at.length > 1 ? `ほか ${at.length - 1}` : ''}${extra}` : '';
  const rel = hand.rel ? '（足元からの相対）' : '';
  switch (hand.do) {
    case 'go': case 'walk': return `${hand.do}${hand.to ? ` ${cell(hand.to)}` : hand.goals?.length ? ` ${hand.goals.length} か所のどれか ${cell(hand.goals[0])}` : hand.path?.length ? ` ${cell(hand.path.at(-1))}` : ''}${rel}`;
    case 'dig': return `dig${where(hand.at, rel)}`;
    case 'place': return `place ${hand.block ?? ''}${where(hand.at, rel)}`.replace(/\s+/gu, ' ').trim();
    case 'pillarUp': return `pillarUp${hand.n ? ` ${hand.n} 段` : ''}${hand.block ? ` ${hand.block}` : ''}`;
    case 'make': case 'craft': case 'mine': return `${hand.do} ${hand.item ?? hand.block ?? ''}${hand.count && hand.count > 1 ? `×${hand.count}` : ''}`.trim();
    case 'smelt': return `smelt ${hand.item ?? ''}${hand.count && hand.count > 1 ? `×${hand.count}` : ''}`.trim();
    case 'attack': case 'fight': case 'pickup': case 'shoot': return `${hand.do}${hand.target ? ` ${hand.target}` : ''}`;
    case 'vertical': return `vertical ${hand.dir ?? ''} ${hand.shape ?? ''} y=${hand.toY ?? '?'}`.replace(/\s+/gu, ' ');
    case 'eat': case 'equip': case 'use': return `${hand.do}${hand.item ? ` ${hand.item}` : ''}`;
    case 'chest': case 'furnace': return `${hand.do}${hand.op ? ` ${hand.op}` : ''}${where(hand.at)}`;
    case 'wait': return `wait${hand.seconds ? ` ${hand.seconds} 秒` : ''}`;
    default: return hand.do;
  }
}
/** The effects of an item's hands, in order (three at most). */
export function inputEffect(input: ActInput): string {
  const hands = input.hands.slice(0, 3).map(handEffect);
  return `${hands.join(' → ')}${input.hands.length > 3 ? ` ほか ${input.hands.length - 3} 手` : ''}${input.repeat && input.repeat > 1 ? `（${input.repeat} 回繰り返す）` : ''}`;
}
const ITEM_LINE = /^(▶|・) /u;
/**
 * The queue's lines with what each item's hands will do (「予定: go (172,-19,236)」) and its time left as 「残り 20 秒（見込み）」 (the queue's own words are 「残り約 20 秒」). `ahead` is the
 * open items' inputs in the queue's order. Nothing is checked against another item's work: that two items aim at the same cell is for the model to see.
 */
export function queueNowLines(lines: readonly string[], ahead: readonly ActInput[]): string[] {
  let at = 0;
  return lines.map(line => {
    if (!ITEM_LINE.test(line)) return line;
    const input = ahead[at++];
    const timed = line.replace(/残り約 (\d+) 秒/u, '残り $1 秒（見込み）');
    return input ? `${timed}${/: /u.test(timed) ? '・' : ': '}予定: ${inputEffect(input)}` : timed;
  });
}

/** What the next hands add to the pack, from the queue's inputs: a make or craft adds its item; a dig or mine, pickup and chest take add what they get. */
export function nextGains(ahead: readonly ActInput[]): string[] {
  const out: string[] = [];
  for (const input of ahead) {
    for (const hand of input.hands) {
      const n = Math.max(1, hand.count ?? 1);
      if ((hand.do === 'make' || hand.do === 'craft') && hand.item) out.push(`${hand.do} ${hand.item} で +${n} 個`);
      else if (hand.do === 'mine' && (hand.item ?? hand.block)) out.push(`mine ${hand.item ?? hand.block} で +${n} 個（拾う）`);
      else if (hand.do === 'dig') out.push('dig で掘った物（collect が真なら拾う）');
      else if (hand.do === 'pickup') out.push('pickup で拾う物');
      else if (hand.do === 'smelt' && hand.item) out.push(`smelt ${hand.item} の取り出しで増える`);
      else if (hand.do === 'chest' && (hand.op === 'take' || hand.op === 'takeAll')) out.push('chest から取る物');
    }
  }
  return [...new Set(out)].slice(0, 3);
}
const STACK_KIND = /^([a-z_0-9]+)×(\d+)/u;
/** The kinds that take the most slots, from the pack's lines: 「cobbled_deepslate×105（2 マス）」. A kind of one slot is told only when that stack is more than half full. */
function takers(lines: readonly string[]): string[] {
  const kinds = new Map<string, { n: number; slots: number }>();
  for (const line of lines) {
    const match = STACK_KIND.exec(line);
    if (!match) continue;
    const kind = kinds.get(match[1]!) ?? { n: 0, slots: 0 };
    kinds.set(match[1]!, { n: kind.n + Number(match[2]), slots: kind.slots + 1 });
  }
  return [...kinds].filter(([, kind]) => kind.slots >= 2 || kind.n > 32).sort((a, b) => b[1].slots - a[1].slots || b[1].n - a[1].n).slice(0, 4).map(([name, kind]) => `${name}×${kind.n}（${kind.slots} マス）`);
}
/** Free slots at or under this: the line also says what fills the pack. */
const NEAR_FULL = 3;
/**
 * The pack's free slots, what the next hands add, and (nearly full) what takes the slots. Normal: the free slots with the gains, and the takers on a line of their own.
 * Shortened: one line. The count is the body's own inventory lines (`packFacts`), the omitted ones (「ほか N件」) counted.
 */
export function packLines(observation: BodyObservation | null, ahead: readonly ActInput[], short: boolean): string[] {
  const inventory = world(observation).inventory;
  if (!Array.isArray(inventory)) return [];
  const lines = stacks(inventory), free = Math.max(0, PACK_SLOTS - packFacts(lines).used);
  const gains = nextGains(ahead);
  const head = `持ち物の空き ${free}/${PACK_SLOTS}${free === 0 ? '（満杯）' : free <= NEAR_FULL ? '（もうすぐ満杯）' : ''}${gains.length ? `・次の手で増える見込み: ${gains.join('・')}` : ''}`;
  if (short || free > NEAR_FULL) return [head];
  const fills = takers(lines);
  return fills.length ? [head, `場所を取っている物: ${fills.join('・')}`] : [head];
}

// ---- where a go or a vertical stopped ----------------------------------------------------------------------------------------------------------

/**
 * A go's or a vertical's stop, from the act's result (the receipt's `result` JSON, not its words): 「go の止まり: 止まった位置 (x,y,z) から行き先まで 35.9 m（道探しの先端からは 27.5 m）」.
 * Only hands that did not reach what they aimed at. The result's own sentences carry the same, in a text that a long result or a shortened input can cut; this line cannot be.
 */
export function stopFactsOf(resultJson: string | undefined): string[] {
  const result = readActResult(resultJson);
  if (!result) return [];
  const out: string[] = [];
  for (const line of result.lines) {
    const progress = line.progress;
    if (!progress || line.goal === 'done' || line.goal === 'already') continue;
    const num = (value: number) => String(Math.round(value * 10) / 10);
    if (progress.unit === 'meter' && progress.fromStopM !== undefined && (line.do === 'go' || line.do === 'walk')) {
      out.push(`${line.do} の止まり: ${progress.at ? `止まった位置 ${cell(progress.at)} から` : '止まった位置から'}行き先まで ${num(progress.fromStopM)} m`
        + `${progress.searchEndM !== undefined ? `（道探しの先端からは ${num(progress.searchEndM)} m）` : ''}`);
    } else if (line.do === 'vertical') {
      out.push(`vertical の止まり: ${progress.at ? `${cell(progress.at)} で止まった・` : ''}今も有効な段 ${num(progress.done)}${progress.left === null ? '・残りは分からない' : `・残り ${num(progress.left)} 段`}${line.code ? `（${line.code}）` : ''}`);
    }
  }
  return out;
}

// ---- the facts of one input -------------------------------------------------------------------------------------------------------------------

export interface FactsContext {
  /** The blows line (`HitWatch.line`), or null. */
  hits?: string | null;
  /** The plan's promises, and the time of the previous decision (ISO) their 「直前に」 counts from. */
  promises?: readonly PlanPromise[];
  since?: string;
  /** The open queue items' inputs in order. */
  ahead?: readonly ActInput[];
  /** Food is short (`wantsFood`): the candidates are listed. */
  wantsFood?: boolean;
  /** The stops of the last results (`stopFactsOf`). */
  stops?: readonly string[];
}
export interface InputFacts { lines: string[]; compressed: string[] }
/**
 * The facts of one input, for the normal version (`urgent` false) or the urgent one. `compressed` is the same facts as the version after the live state was shortened keeps
 * them: the pack in one line, three food candidates at most. Every line is short (under a few hundred characters), so a shortening of a long text does not reach it.
 */
export function inputFacts(observation: BodyObservation | null, context: FactsContext, urgent: boolean): InputFacts {
  const ahead = context.ahead ?? [];
  const head = [vitalsLine(observation), context.hits ?? null, holderLine(observation)];
  const promises = promiseLines(context.promises ?? [], { ...context.since ? { since: context.since } : {}, observation, limit: 4 });
  const stops = [...context.stops ?? []];
  const food = (shown: number) => context.wantsFood ? [foodLine(observation, shown)] : [];
  const make = (short: boolean) => [...head, ...food(short || urgent ? FOOD_KEPT : FOOD_NORMAL_MAX), ...packLines(observation, ahead, short), ...promises, ...stops]
    .filter((line): line is string => !!line);
  return { lines: make(false), compressed: make(true) };
}

// ---- the facts said once -----------------------------------------------------------------------------------------------------------------------

/** The facts said once that the preparation node's alone (`minecraftLlmcBody.ts`, `prep_unmet:`) is for the normal input only (chapter 8's table: 「1 度出す」, 「—」, 「—」). */
const NORMAL_ONLY = ['prep_unmet:'];
/** The facts said once that an input of this version takes: the normal one all, the urgent one all but the preparation's, the shortened one none. */
export function onceFor(taskId: string, version: 'normal' | 'urgent' | 'compressed'): OnceFact[] {
  if (version === 'compressed') return [];
  const all = pending(taskId);
  return version === 'normal' ? all : all.filter(fact => !NORMAL_ONLY.some(prefix => fact.key.startsWith(prefix)));
}
/**
 * The facts said once that other owners make (chapter 8's table: a placement that was ok and the world differs after it - a block update, a push-back, the steps counted again;
 * a resume - the earlier result, whether it was sent again, how the old command and the new one are related): `kind` and an `id` of the occasion make the key, so that the same
 * occasion is offered once and a later one again. They go with the normal and the urgent input and not the shortened one (`onceFor`).
 */
export const ONCE_KINDS = ['placement_corrected', 'resume'] as const;
export function offerOnce(taskId: string, kind: typeof ONCE_KINDS[number], id: string, text: string): boolean {
  return offer(taskId, `${kind}:${id}`, text);
}
/** The text of the request's last message (the live state), as a string. */
function lastMessageText(request: unknown): string {
  const messages = rec(request)?.messages;
  const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined;
  const content = rec(last)?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}
/**
 * The request is going out (`MinecraftV2Hooks.requestSent`, called by the model right before it dispatches): the facts said once whose words are in the last message are
 * delivered; the rest are kept and offered with the next input. Returns the keys marked.
 */
export function deliverOnceFacts(taskId: string, request: unknown): string[] {
  const facts = pending(taskId);
  if (!facts.length) return [];
  const text = lastMessageText(request);
  const sent = facts.filter(fact => text.includes(JSON.stringify(fact.text).slice(1, -1))).map(fact => fact.key);
  if (sent.length) markDelivered(taskId, sent);
  return sent;
}
