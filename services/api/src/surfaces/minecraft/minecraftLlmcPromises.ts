import type { PlanPromise, PromiseEvent } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActClause, ActCondition } from '../../contracts/minecraftActCondition.js';
import { deathBetween, type DeathCounter, type InventoryEvent } from '../../contracts/continueContract.js';
import { carried, clauseHolds, clauseLack, clauseText, conditionHolds, doneFacts, validCondition, type DoneFacts } from './minecraftConditions.js';
import { carriedFood } from './minecraftLlmcLive.js';
import type { OnceFact } from './minecraftLlmcOnceFacts.js';

/**
 * The promises' ledger, the head's half (the continue contract, chapter 3; amendment A-1 4). Pure: the plan tool's owner (`fcaPlanTools.ts`) holds the tree and the
 * `LedgerSeen`, calls `applyLedger` and keeps what comes back; `promiseLines` makes the live state's line of each open promise.
 *
 * What the ledger does, and does not:
 * - The model writes the promises (`plan.update`); the ledger is the head's. Nothing here stops a hand or a use because of a promise.
 * - **What she has is what the observation says.** `have` is counted again from the newest observation, never added up from the events. An event is only
 *   the explanation of a change: a difference the events of the command do not explain stays `unexplained` and is not shared out by a guess.
 * - **An event is put to the ledger once**, by its id (`LedgerSeen.eventIds`, kept beyond the 32 lines a promise shows).
 * - **Whose use it was** is told by the definition the command was sent with (`UsesSnapshot`), not by the promise as it is now.
 */

/** A promise's definition as the command was sent with it (kept with the command; a later revision does not change the attribution of its events). */
export interface UsesSnapshot { id: number; rev: number; item: string; count: number; use: string }
/** The newest observation the ledger took: only a newer one (same connection: a larger `obsSeq`; a new connection) rewrites `have`. */
export interface LedgerObs { bodyBoot: string; connectionId: string; obsSeq: number }
/** An event applied whose observation the ledger has not taken yet: the next newer observation must find its effect (it is not an unexplained difference). */
export interface LedgerAhead { promise: number; delta: number; connection: string; obsSeq: number | null }
/**
 * The ledger's memory beside the tree (the checkpoint's `fcaPlanLedgerSeen`; gone when the task ends). `eventIds` and `lastObs` are the contract's; the rest are
 * the same memory kept for the same reason (`death`: the death counter last read, for `deathBetween`; `connections`: the connections replaced, so a late
 * observation of one is not taken for a new one; `ahead`: see `LedgerAhead`).
 */
export interface LedgerSeen { eventIds: string[]; lastObs: LedgerObs | null; death?: DeathCounter | null; connections?: string[]; ahead?: LedgerAhead[] }
export const emptyLedgerSeen = (): LedgerSeen => ({ eventIds: [], lastObs: null });

/** Where the events came from (the command the act was sent as; `do` is the hand's verb, which tells a smelt's ingredient from a craft's). */
export interface LedgerBy { command?: string; item?: string; pass?: number; hand?: number; do?: string }
export interface LedgerInput {
  /** The body's inventory events (a receipt's `delta`s and pages, or an act-less reflex's WorkingEvent `inventory.changed`). */
  events: readonly InventoryEvent[];
  by?: LedgerBy;
  /**
   * Amendment A-6 14: the verb of the hand each event came from, by the event's id (`${command}:${pass}:${hand}:${seq}` names the hand; the receipt's line or the act as it was
   * sent says what the hand was). One act can hold a craft and a smelt, so `by.do` (one verb for the whole call) is only the fallback of an event this does not name.
   */
  hands?: Readonly<Record<string, string>>;
  /** The definitions the command was sent with (`snapshotUses`). Absent: the act declared no use. */
  uses?: readonly UsesSnapshot[];
  /** The newest observation the caller has (an older one than the ledger took does not rewrite `have`). Call at each new observation too, with no events. */
  observation: BodyObservation | null;
  at: string;
  /** The connection the events were made on, when it is not the observation's (a receipt that came after a reconnect). Absent: the observation's. A reflex event names its own. */
  from?: { bodyBoot: string; connectionId: string };
  /** The body's `events` reply said `lost: true` (it lost its record in a restart): what the events do not explain is that, not a mystery. */
  lost?: boolean;
  /** The plan's nodes (`until.node` closes a promise when the node is done). */
  nodes?: ReadonlyArray<{ id: string; state: string }>;
}
export type LedgerAdded = PromiseEvent & { promise: number };
export interface LedgerResult {
  promises: PlanPromise[]; ledgerSeen: LedgerSeen;
  /** What was put to the ledgers by this call (a promise's number with each). */
  added: LedgerAdded[];
  /** Facts to say once (an `instead` that stopped holding), and the keys of ones that no longer hold (take them back if they are not delivered). */
  facts: OnceFact[]; withdrawn: string[];
  /** Whether a promise or the memory changed at all. */
  changed: boolean;
}

const LEDGER_LINES = 32, AHEAD_LIMIT = 128, CONNECTIONS_LIMIT = 8;
const round1 = (value: number) => Math.round(value * 10) / 10;
const key = (run: { bodyBoot: string; connectionId: string }) => `${run.bodyBoot}/${run.connectionId}`;
const sumShown = (list: ReadonlyArray<{ shown: number }>) => round1(list.reduce((total, item) => total + item.shown, 0));

/** The reasons the body gives (`InventoryEvent.reason`) as the ledger names them. `ingredient` of a smelt is told by the hand's verb. */
const REASONS: Readonly<Record<string, string>> = { ingredient: 'craft_ingredient', fuel: 'smelt_fuel', food: 'eat', placed: 'place', thrown: 'thrown', tool_broke: 'tool_broke',
  crafted: 'crafted', picked: 'picked', mined: 'mined', smelted: 'smelted', reflex_eat: 'reflex_eat', reflex_armor: 'reflex_armor', death: 'death', unexplained: 'unexplained',
  stored: 'stored', retrieved: 'retrieved' };
/** The reasons of the body's events the ledger names (any other is read as `unexplained`). */
export const LEDGER_REASONS: readonly string[] = Object.keys(REASONS);
function reasonOf(event: InventoryEvent, by: LedgerBy | undefined, hands?: LedgerInput['hands']): string {
  const reason = event.reason as string;
  return reason === 'ingredient' && (hands?.[event.id] ?? by?.do) === 'smelt' ? 'smelt_ingredient' : REASONS[reason] ?? 'unexplained';
}

/** What an observation gives the ledger: the connection it belongs to, its number, the counts, and the death counter it shows. */
interface Seen { run: { bodyBoot: string; connectionId: string }; obsSeq: number; facts: DoneFacts; frame: BodyObservation; life: { deathEpoch?: unknown; deathSeq?: unknown } }
function seenOf(observation: BodyObservation | null): Seen | null {
  const facts = doneFacts(observation);
  if (!observation || !facts || !Number.isFinite(observation.sequence)) return null;
  const run = observation.state.bodyRun as { bodyBoot?: unknown; connectionId?: unknown } | undefined;
  const life = observation.state.life as { deathEpoch?: unknown; deathSeq?: unknown } | undefined;
  return { run: { bodyBoot: typeof run?.bodyBoot === 'string' ? run.bodyBoot : '', connectionId: typeof run?.connectionId === 'string' ? run.connectionId : '' },
    obsSeq: observation.sequence, facts, frame: observation, life: life && typeof life === 'object' ? life : {} };
}
/** What she carries of a promise's item in a frame: the food points for `food`, else the count the conditions' `have` reads. */
const haveIn = (item: string, facts: DoneFacts): number => item === 'food' ? facts.food : carried(facts.counts, item);
/** The food points of `count` of an item (0 when it is not food: `food` is counted as the live state counts it). */
const foodOf = (item: string, count: number): number => carriedFood({ inventory: [{ name: item, count: 1 }] }, {}).points * count;
/** The change an event makes to what a promise of `item` counts (in food points for `food`), 0 when it is not that. */
function deltaFor(item: string, event: InventoryEvent): number {
  if (item === 'food') return round1(foodOf(event.item, event.count));
  return carried(new Map([[event.item, 1]]), item) > 0 ? event.count : 0;
}

type Relation = 'newer' | 'same' | 'older';
function relationOf(seen: LedgerSeen, now: Seen): Relation {
  const last = seen.lastObs;
  if (!last) return 'newer';
  if (last.bodyBoot === now.run.bodyBoot && last.connectionId === now.run.connectionId) return now.obsSeq > last.obsSeq ? 'newer' : now.obsSeq === last.obsSeq ? 'same' : 'older';
  return (seen.connections ?? []).includes(key(now.run)) ? 'older' : 'newer';
}

/**
 * Amendment A-2 3: armour put on (the body's `reflex_armor`: the `equip` of a head, torso, legs or feet slot) is the item going from the pack to the armour slot, not a use. The frame
 * counts what she wears (`carriedItemCounts`: `worn`), so the count of her `have` does not move: the event is told as `moved` and takes nothing off `have`.
 */
const WORN_REASONS: ReadonlySet<string> = new Set(['reflex_armor']);
const isWorn = (event: InventoryEvent): boolean => WORN_REASONS.has(event.reason as string);
/** `stored` and `retrieved` (a chest) and putting armour on are the item changing place: told as `moved`, never as consumed or gained. */
const isMoved = (event: InventoryEvent): boolean => event.reason === 'stored' || event.reason === 'retrieved' || isWorn(event);

/**
 * `delta` is what the event does to the count she has **of the item the promise is of now** (0 for armour put on: worn is counted, and 0 for an event of an item the promise was
 * revised away from: it changes another item's count, which this promise does not count); `shown` is what the event says of the item it is put to (a worn piece is 1).
 */
interface Entry { event: InventoryEvent; delta: number; shown: number; declared: boolean; rev: number; item: string; connection: string; old: boolean }

/** Where an event came from: the call's `by`, and what its id says (`${command}:${pass}:${hand}:${seq}`) where the call does not. */
function byOf(by: LedgerBy | undefined, id: string): PromiseEvent['by'] | undefined {
  const { do: _do, ...given } = by ?? {};
  const match = id.startsWith('reflex:') ? null : /^(.+):(\d+):(\d+):\d+$/u.exec(id);
  const value = match ? { command: match[1]!, pass: Number(match[2]), hand: Number(match[3]), ...given } : given;
  return Object.keys(value).length ? value : undefined;
}
/** A promise with lines added to its ledger: the oldest go past 32, and how many went is kept. */
function appended(promise: PlanPromise, lines: readonly PromiseEvent[]): PlanPromise {
  if (!lines.length) return promise;
  let ledger = [...promise.ledger, ...lines], dropped = promise.dropped ?? 0;
  if (ledger.length > LEDGER_LINES) { dropped += ledger.length - LEDGER_LINES; ledger = ledger.slice(-LEDGER_LINES); }
  return { ...promise, ledger, ...(dropped ? { dropped } : {}) };
}

/**
 * The promises with the events and the observation put to their ledgers. Chapter 3's rules, in this order: the events (once each, by id, put to the promise by the
 * definition the command was sent with), `have` from the observation (only a newer one), what the events do not explain (`unexplained`, or `lost_death` when the body
 * died), `instead` and `until` asked again of the observation. Nothing is refused.
 */
export function applyLedger(promises: readonly PlanPromise[], ledgerSeen: LedgerSeen, input: LedgerInput): LedgerResult {
  const seenIds = new Set(ledgerSeen.eventIds);
  const fresh: InventoryEvent[] = [];
  for (const event of input.events) {
    if (!event || typeof event.id !== 'string' || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    fresh.push(event);
  }
  const now = seenOf(input.observation), last = ledgerSeen.lastObs;
  const relation = now ? relationOf(ledgerSeen, now) : null, newer = relation === 'newer';
  const callConnection = input.from?.connectionId ?? now?.run.connectionId ?? last?.connectionId ?? '', bootOf = input.from?.bodyBoot ?? now?.run.bodyBoot ?? last?.bodyBoot ?? '';
  const connectionOf = (event: InventoryEvent) => event.id.startsWith('reflex:') ? event.id.split(':')[1] ?? callConnection : callConnection;
  const obsOf = (event: InventoryEvent): number | null => typeof event.obsSeq === 'number' && Number.isFinite(event.obsSeq) ? event.obsSeq : null;
  const replaced = new Set(ledgerSeen.connections ?? []);
  /** An event the ledger's newest observation already shows: its effect is in `have` already. */
  const isOld = (event: InventoryEvent): boolean => {
    if (!last) return false;
    const connection = connectionOf(event), at = obsOf(event);
    return replaced.has(`${bootOf}/${connection}`) || (bootOf === last.bodyBoot && connection === last.connectionId && at !== null && at <= last.obsSeq);
  };
  /** Whether the new observation shows the effect of something that happened on `connection` at `obsSeq`. */
  const coveredBy = (connection: string, obsSeq: number | null): boolean => !now || connection !== now.run.connectionId || obsSeq === null || obsSeq <= now.obsSeq;
  const deathNow = !!now && newer && typeof now.life.deathEpoch === 'string' && deathBetween(ledgerSeen.death ?? null, now.life).death;

  const added: LedgerAdded[] = [], facts: OnceFact[] = [], withdrawn: string[] = [], out: PlanPromise[] = [], aheadNext: LedgerAhead[] = [];
  let changed = fresh.length > 0 || newer;
  const sum = (list: ReadonlyArray<{ delta: number }>) => round1(list.reduce((total, item) => total + item.delta, 0));

  for (const promise of promises) {
    if (promise.state === 'closed') { out.push(promise); continue; }
    const snapshot = input.uses?.find(item => item.id === promise.id);
    // The events that are this promise's: by the definition the command was sent with when the item is that, else by the promise as it is.
    const entries: Entry[] = [];
    for (const event of fresh) {
      // Amendment A-6 13: the definition the command was sent with says whose the event is (its item and rev); what it does to the count the promise keeps is by the item the promise is of now.
      const viaSnapshot = snapshot ? deltaFor(snapshot.item, event) : 0, own = deltaFor(promise.item, event);
      const shown = viaSnapshot !== 0 ? viaSnapshot : own;
      if (shown === 0) continue;
      entries.push({ event, delta: isWorn(event) ? 0 : own, shown, declared: viaSnapshot !== 0, rev: viaSnapshot !== 0 ? snapshot!.rev : promise.rev,
        item: viaSnapshot !== 0 ? snapshot!.item : promise.item, connection: connectionOf(event), old: isOld(event) });
    }
    const pending = (ledgerSeen.ahead ?? []).filter(item => item.promise === promise.id);
    const live = entries.filter(entry => !entry.old);
    const newAhead = (list: Entry[]): LedgerAhead[] => list.filter(entry => entry.delta !== 0).map(entry => ({ promise: promise.id, delta: entry.delta, connection: entry.connection, obsSeq: obsOf(entry.event) }));
    // What the new observation shows of the events not seen before, and what it does not show yet.
    const coveredPending = newer ? pending.filter(item => coveredBy(item.connection, item.obsSeq)) : [];
    const coveredLive = newer ? live.filter(entry => coveredBy(entry.connection, obsOf(entry.event))) : [];
    const observed = newer && now ? haveIn(promise.item, now.facts) : null;
    const expected = observed !== null && promise.have !== undefined ? round1(promise.have + sum(coveredPending) + sum(coveredLive)) : null;
    const diff = observed !== null && expected !== null ? round1(observed - expected) : 0;
    const carriedOn = newer ? [...pending.filter(item => !coveredPending.includes(item)), ...newAhead(live.filter(entry => !coveredLive.includes(entry)))]
      : [...pending, ...newAhead(live)];
    aheadNext.push(...carriedOn);

    // The count each line shows as `have`: the count before, plus the events one by one (with no earlier look, the observation put back before them).
    let cur = round1((promise.have ?? (observed !== null ? round1(observed - sum(coveredPending) - sum(coveredLive)) : 0)) + sum(pending));
    // make's middle materials are put together: what was made and used within one hand is the net of it, one line.
    const lines: Array<{ entries: Entry[]; net: boolean }> = [], middles = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (!entry.event.intermediate) { lines.push({ entries: [entry], net: false }); continue; }
      const name = `${entry.event.item}|${entry.item}`, group = middles.get(name);
      if (group) group.push(entry);
      else { const created = [entry]; middles.set(name, created); lines.push({ entries: created, net: true }); }
    }
    const written: PromiseEvent[] = [];
    for (const line of lines) {
      const first = line.entries[0]!, net = sumShown(line.entries), worn = !line.net && isWorn(first.event);
      cur = round1(cur + sum(line.entries.filter(entry => !entry.old)));
      if (net === 0 && !worn) continue;
      const reason = line.net ? (net > 0 ? 'crafted' : 'craft_ingredient') : reasonOf(first.event, input.by, input.hands);
      const kind: PromiseEvent['kind'] = first.event.reason === 'death' ? 'lost_death' : first.event.reason === 'unexplained' ? 'unexplained' : !line.net && isMoved(first.event) ? 'moved' : net < 0 ? 'consumed' : 'gained';
      const source = byOf(input.by, first.event.id);
      written.push({ id: first.event.id, at: input.at, kind, count: kind === 'unexplained' ? net : Math.abs(net), have: Math.max(0, cur), declared: first.declared, reason,
        promiseRev: first.rev, item: first.item, ...(source ? { by: source } : {}) });
    }
    if (observed !== null && diff !== 0) {
      // What the events do not explain is said as it is, not shared out. Under a death the loss is the death's; a body that lost its record says so.
      const dead = deathNow && diff < 0;
      written.push({ id: dead ? `death:${String(now!.life.deathEpoch)}:${String(now!.life.deathSeq)}` : `unexplained:${key(now!.run)}:${now!.obsSeq}`, at: input.at,
        kind: dead ? 'lost_death' : 'unexplained', count: dead ? -diff : diff, have: round1(observed + sum(carriedOn)), reason: dead ? 'death' : input.lost ? 'events_lost' : 'unexplained' });
    }
    for (const line of written) added.push({ ...line, promise: promise.id });
    let next = appended(promise, written);
    if (observed !== null) next = { ...next, have: observed };

    // `instead` and `until` are asked again at each observation (not of an older one).
    if (now && relation !== 'older') {
      const instead = promise.instead && validCondition(promise.instead) ? promise.instead as ActCondition : null;
      if (instead) {
        const holds = conditionHolds(instead, now.frame), factKey = `promise_instead_lost:${promise.id}:r${promise.rev}`;
        if (holds === true) {
          withdrawn.push(factKey);
          if (next.state === 'open') { next = { ...next, state: 'kept_by_instead' }; changed = true; }
        } else if (holds === false && next.state === 'kept_by_instead') {
          next = { ...next, state: 'open' };
          changed = true;
          facts.push({ key: factKey, text: `約束 #${promise.id} の代わりの条件が成り立たなくなった（${insteadLack(instead, now.facts) ?? 'もう満たしていない'}）` });
        }
      }
      const why = closedWhy(promise, now, input.nodes);
      if (why) {
        const line: PromiseEvent = { id: `plan:closed:${promise.rev}`, at: input.at, kind: 'closed', count: 0, have: next.have ?? 0, reason: why };
        next = { ...appended(next, [line]), state: 'closed', closedBy: 'until' };
        added.push({ ...line, promise: promise.id });
        changed = true;
      }
    }
    out.push(next);
  }

  const seen: LedgerSeen = { eventIds: fresh.length ? [...ledgerSeen.eventIds, ...fresh.map(event => event.id)] : ledgerSeen.eventIds,
    lastObs: newer && now ? { bodyBoot: now.run.bodyBoot, connectionId: now.run.connectionId, obsSeq: now.obsSeq } : last };
  const counter = newer && now && typeof now.life.deathEpoch === 'string' ? deathBetween(ledgerSeen.death ?? null, now.life).counter : ledgerSeen.death ?? null;
  if (counter) seen.death = counter;
  const connections = newer && now && last && key(last) !== key(now.run) ? [...(ledgerSeen.connections ?? []), key(last)].slice(-CONNECTIONS_LIMIT) : ledgerSeen.connections;
  if (connections?.length) seen.connections = connections;
  if (aheadNext.length) seen.ahead = aheadNext.slice(-AHEAD_LIMIT);
  return { promises: out, ledgerSeen: seen, added, facts, withdrawn, changed: changed || added.length > 0 };
}

/** Why a promise's period is over: its node is done, or its condition holds (the words for the ledger line), or null. */
function closedWhy(promise: PlanPromise, now: Seen, nodes: LedgerInput['nodes']): string | null {
  const until = promise.until;
  if (!until) return null;
  if (until.node && nodes?.find(node => node.id === until.node)?.state === 'done') return `節 ${until.node} が済んだ`;
  if (until.condition && validCondition(until.condition) && conditionHolds(until.condition as ActCondition, now.frame) === true) return '期限の条件を満たした';
  return null;
}

/** What the `instead` lacks, in words (the alternative nearest to holding): the clauses the frame shows unmet. */
function insteadLack(condition: ActCondition, facts: DoneFacts): string | null {
  const rank = (clauses: ActClause[]) => clauses.filter(clause => clauseHolds(clause, facts) === true).length / clauses.length;
  const best = [...condition].sort((left, right) => rank(right) - rank(left))[0];
  const lacking = (best ?? []).filter(clause => clauseHolds(clause, facts) === false)
    .map(clause => clause.k === 'near' ? `${itemWord(clause.block)}が ${clause.r}m 内に無い` : clauseLack(clause, facts));
  return lacking.length ? lacking.join('・') : null;
}

/** The definitions of `ids` as they stand, to send with a command (an unknown or closed one is left out). */
export function snapshotUses(promises: readonly PlanPromise[], usesIds: readonly number[] | undefined): UsesSnapshot[] {
  const out: UsesSnapshot[] = [];
  for (const id of usesIds ?? []) {
    const promise = promises.find(item => item.id === id);
    if (promise && promise.state !== 'closed' && !out.some(item => item.id === id)) out.push({ id, rev: promise.rev, item: promise.item, count: promise.count, use: promise.use });
  }
  return out;
}

/** A `LedgerSeen` read back from a checkpoint (anything that does not read is empty). */
export function readLedgerSeen(value: unknown): LedgerSeen {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw || !Array.isArray(raw.eventIds)) return emptyLedgerSeen();
  const last = raw.lastObs as Record<string, unknown> | null | undefined;
  const lastObs = last && typeof last.bodyBoot === 'string' && typeof last.connectionId === 'string' && Number.isFinite(last.obsSeq)
    ? { bodyBoot: last.bodyBoot, connectionId: last.connectionId, obsSeq: last.obsSeq as number } : null;
  const death = raw.death as Record<string, unknown> | null | undefined;
  const ahead = Array.isArray(raw.ahead) ? raw.ahead.filter((item): item is LedgerAhead => !!item && typeof item === 'object' && Number.isSafeInteger((item as LedgerAhead).promise)
    && Number.isFinite((item as LedgerAhead).delta) && typeof (item as LedgerAhead).connection === 'string') : [];
  return { eventIds: raw.eventIds.filter((id): id is string => typeof id === 'string'), lastObs,
    ...(death && typeof death.deathEpoch === 'string' && Number.isSafeInteger(death.deathSeq) ? { death: { deathEpoch: death.deathEpoch, deathSeq: death.deathSeq as number } } : {}),
    ...(Array.isArray(raw.connections) ? { connections: raw.connections.filter((item): item is string => typeof item === 'string').slice(-CONNECTIONS_LIMIT) } : {}),
    ...(ahead.length ? { ahead: ahead.slice(-AHEAD_LIMIT) } : {}) };
}

// ---- the live state's line --------------------------------------------------------------------------------------------------------------------

/** The names of the few items a promise or a condition says in words; any other is said by its id. */
const WORDS: Readonly<Record<string, string>> = { planks: '板', food: '食料', crafting_table: '作業台', furnace: 'かまど', chest: 'チェスト', bed: 'ベッド', coal: '石炭',
  cobblestone: '丸石', stick: '棒', torch: '松明', water_bucket: '水入りバケツ', bucket: 'バケツ', flint_and_steel: '火打石と打ち金', obsidian: '黒曜石', shield: '盾' };
export const itemWord = (item: string): string => WORDS[item] ?? item;
const REASON_WORDS: Readonly<Record<string, string>> = { smelt_fuel: 'かまどの燃料', craft_ingredient: '作る材料', smelt_ingredient: '焼く材料', eat: '食事', reflex_eat: '反射の食事',
  place: '置いた', thrown: '捨てた', tool_broke: '道具が壊れた', reflex_armor: '反射で防具を着た', death: '死', stored: '箱へ入れた', retrieved: '箱から出した', crafted: '作った',
  picked: '拾った', mined: '掘った', smelted: '焼けた', unexplained: '出来事に無い増減', events_lost: '体の記録が失われた' };
const reasonWords = (reason: string | undefined): string => REASON_WORDS[reason ?? ''] ?? reason ?? '';

export interface PromiseLineContext {
  /** The time of the previous decision (ISO): 「直前に」 is what happened after it. Absent: no line says what happened just now. */
  since?: string;
  /** The observation the line's 「今」 is read from (absent: the count the ledger last took). */
  observation?: BodyObservation | null;
  /** How many lines at most (4). */
  limit?: number;
}
/** The live state's lines for the open promises: by number, four at most. Facts only; a line asks nothing. */
export function promiseLines(promises: readonly PlanPromise[], context: PromiseLineContext = {}): string[] {
  const facts = doneFacts(context.observation ?? null);
  return [...promises].filter(promise => promise.state === 'open' || promise.state === 'kept_by_instead').sort((left, right) => left.id - right.id)
    .slice(0, context.limit ?? 4).map(promise => lineOf(promise, facts, context, promises));
}

/** What the open promises of an item hold back in all (their counts added): what is not free to spend (A-8 1). */
export const heldBack = (promises: readonly PlanPromise[], item: string): number =>
  promises.filter(promise => promise.state === 'open' && promise.item === item).reduce((total, promise) => total + promise.count, 0);
/** What she has beyond the open promises of the item: what she has less what they hold back, never below 0 (A-8 1). */
export const freeOutside = (promises: readonly PlanPromise[], item: string, have: number): number => Math.max(0, round1(have - heldBack(promises, item)));

function lineOf(promise: PlanPromise, facts: DoneFacts | null, context: PromiseLineContext, all: readonly PlanPromise[] = []): string {
  const food = promise.item === 'food', unit = food ? ' 点' : '';
  const link = /[用分]$/u.test(promise.use) ? 'の' : '用の';
  const head = `約束 #${promise.id} ${promise.use}${link}${itemWord(promise.item)} ${promise.count}${unit}`;
  const have = facts ? haveIn(promise.item, facts) : promise.have;
  const outside = have === undefined || promise.state !== 'open' ? '' : `（約束の外で使えるのは ${freeOutside(all.length ? all : [promise], promise.item, have)}${unit}）`;
  const parts = [have === undefined ? '今 不明' : `今 ${round1(have)}${unit}${outside}`];
  if (promise.state === 'kept_by_instead') {
    const words = facts && promise.instead && validCondition(promise.instead) ? holdWords(promise.instead as ActCondition, facts) : null;
    return `${head}: ${[...parts, `代わりの条件を満たす${words ? `（${words}）` : ''}`].join('・')}`;
  }
  const recent = context.since === undefined ? [] : promise.ledger.filter(event => event.at > context.since!);
  const died = recent.filter(event => event.kind === 'lost_death');
  const changes = changesWords(recent.filter(event => event.kind !== 'lost_death'), unit, promise.item);
  if (changes) parts.push(changes);
  if (died.length) parts.push(`死んで ${round1(died.reduce((total, event) => total + event.count, 0))}${unit || ' '}失った`);
  const short = have === undefined ? 0 : round1(promise.count - have);
  return `${head}: ${parts.join('・')}${short > 0 && !died.length ? `（足りない ${short}）` : ''}`;
}

/**
 * 「直前に 2 減った（理由: …）」: what the events after the last decision took from the promise's item and gave to it. An event put to the definition the promise had before it was
 * revised to another item (its `item` is that item's) changed that item's count, not this one's: it is said apart, with its item (「改訂前の品目 板 が 4 減った」).
 */
function changesWords(all: readonly PromiseEvent[], unit: string, itemNow: string): string {
  const events = all.filter(event => !event.item || event.item === itemNow), before = all.filter(event => event.item && event.item !== itemNow);
  const signed = (event: PromiseEvent): number => event.kind === 'consumed' ? -event.count : event.kind === 'gained' ? event.count
    : event.kind === 'moved' ? (event.reason === 'stored' ? -event.count : event.reason === 'retrieved' ? event.count : 0) : event.kind === 'unexplained' ? event.count : 0;
  const part = (list: PromiseEvent[], word: string, unit_ = unit): string | null => {
    if (!list.length) return null;
    const total = round1(list.reduce((sum, event) => sum + (event.reason === 'reflex_armor' && event.kind === 'moved' ? event.count : Math.abs(signed(event))), 0));
    const reasons = [...new Set(list.map(event => reasonWords(event.reason)))].filter(Boolean).join('・');
    const act = list.filter(event => event.kind === 'consumed' && !(event.reason ?? '').startsWith('reflex_'));
    const declaredWords = act.length ? (act.every(event => event.declared) ? '申告の用途' : act.some(event => event.declared) ? '一部は申告の用途' : '申告の用途ではない') : '';
    const placeOnly = list.every(event => event.kind === 'moved') ? (list.every(event => event.reason === 'reflex_armor') ? '持ち物から防具の欄へ移っただけで、持っている数は変わらない' : '置き場所が変わっただけ') : '';
    const note = [declaredWords, placeOnly].filter(Boolean).join('。');
    return `${total}${unit_ || ' '}${word}${reasons ? `（理由: ${reasons}${note ? `。${note}` : ''}）` : ''}`;
  };
  const lessList = events.filter(event => signed(event) < 0), moreList = events.filter(event => signed(event) > 0);
  // Armour put on moves nothing in the count she has (worn is counted): it is said as what it is, beside the less and the more.
  const wornList = events.filter(event => event.kind === 'moved' && event.reason === 'reflex_armor');
  const worn = wornList.length ? part(wornList, '身に着けた') : null;
  const pieces = [part(lessList, '減った'), part(moreList, '増えた'), worn].filter((item): item is string => !!item);
  for (const item of [...new Set(before.map(event => event.item!))]) {
    const mine = before.filter(event => event.item === item);
    const words = [part(mine.filter(event => signed(event) < 0), '減った', ''), part(mine.filter(event => signed(event) > 0), '増えた', ''), part(mine.filter(event => signed(event) === 0), '動いた', '')]
      .filter((entry): entry is string => !!entry);
    if (words.length) pieces.push(`改訂前の品目 ${itemWord(item)} が ${words.join('・')}`);
  }
  return pieces.length ? `直前に ${pieces.join('・')}` : '';
}

/** What makes the first alternative that holds hold, in words (`作業台 1`, `近くに作業台 2m`). */
function holdWords(condition: ActCondition, facts: DoneFacts): string | null {
  const alternative = condition.find(clauses => clauses.every(clause => clauseHolds(clause, facts) === true));
  if (!alternative) return null;
  return alternative.map(clause => {
    if (clause.k === 'have') return `${itemWord(clause.item)} ${carried(facts.counts, clause.item)}`;
    if (clause.k === 'near') {
      const found = facts.utilities?.found.filter(item => item.block === clause.block).sort((left, right) => left.distance - right.distance)[0];
      return `近くに${itemWord(clause.block)}${found ? ` ${round1(found.distance)}m` : ''}`;
    }
    return clauseText(clause);
  }).join('・');
}

/**
 * What an act's hands spend that the head can count from their arguments (A-8 2): a smelt's fuel and what it smelts, what a drop throws and a chest takes in, the blocks of a place
 * (one a cell) and of a pillar (`n`, with its block named). A make's or a craft's materials need a recipe: not counted here.
 */
export function actSpends(hands: readonly { do?: string; item?: string; items?: readonly { item: string; count?: number }[]; fuel?: string; fuelCount?: number;
  block?: string; at?: readonly unknown[]; n?: number; op?: string; count?: number }[]): { item: string; count: number }[] {
  const out: { item: string; count: number }[] = [];
  for (const hand of hands) {
    if (hand.do === 'smelt') {
      if (hand.fuel && hand.fuelCount) out.push({ item: hand.fuel, count: hand.fuelCount });
      for (const entry of hand.items ?? []) if (entry.count) out.push({ item: entry.item, count: entry.count });
    } else if (hand.do === 'drop') for (const entry of hand.items ?? []) { if (entry.count) out.push({ item: entry.item, count: entry.count }); }
    else if (hand.do === 'chest' && (hand.op === 'put')) for (const entry of hand.items ?? []) { if (entry.count) out.push({ item: entry.item, count: entry.count }); }
    else if (hand.do === 'place' && hand.block && hand.at?.length) out.push({ item: hand.block, count: hand.at.length });
    else if (hand.do === 'pillarUp' && hand.block && hand.n) out.push({ item: hand.block, count: hand.n });
  }
  return out;
}
/** Whether a name in the pack is the item of a promise (the same match the conditions use: the name, or a kind ending in it: `spruce_planks` is `planks`). */
const isItemOf = (name: string, item: string): boolean => name === item || name.endsWith(`_${item}`);
/**
 * A-8 2: when the act's spending is more than what the open promises of an item leave free, one line (said once, after the act is sent; nothing is refused):
 * 「この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 6 を使い、残り 1）」. Facts the head counts; the choice stays the model's.
 */
export function breakingWords(promises: readonly PlanPromise[], hands: Parameters<typeof actSpends>[0], observation: BodyObservation | null): string[] {
  const facts = doneFacts(observation), spends = actSpends(hands);
  if (!facts || !spends.length) return [];
  const lines: string[] = [];
  for (const promise of promises.filter(item => item.state === 'open').sort((a, b) => a.id - b.id)) {
    const used = spends.filter(spend => isItemOf(spend.item, promise.item)).reduce((total, spend) => total + spend.count, 0);
    if (!used) continue;
    const have = haveIn(promise.item, facts);
    if (used <= freeOutside(promises, promise.item, have)) continue;
    const unit = promise.item === 'food' ? ' 点' : '';
    const link = /[用分]$/u.test(promise.use) ? 'の' : '用の';
    lines.push(`この act は約束 #${promise.id}（${promise.use}${link}${itemWord(promise.item)} ${promise.count}${unit}）を割る見込み（${itemWord(promise.item)} ${round1(used)}${unit} を使い、残り ${Math.max(0, round1(have - used))}${unit}）`);
  }
  return lines;
}

/**
 * A-9: the pack's lines with the open promises' shares written where the model counts what it can spend: `spruce_planks×7（約束 #1 地下の作業台に 4・外 3）`. A promise of
 * `planks` is beside every kind of planks (their total is said when there are several lines: `板の合計 7`); the lines of an item no open promise names are as they were;
 * a promise held by its `instead` (`kept_by_instead`) and the food points (not a stack) are not written. The ledger's lines stay as they are.
 */
export function shareStacks(lines: readonly string[], promises: readonly PlanPromise[] | undefined): string[] {
  const open = (promises ?? []).filter(promise => promise.state === 'open' && promise.item !== 'food').sort((left, right) => left.id - right.id);
  if (!open.length) return [...lines];
  const items = [...new Set(open.map(promise => promise.item))];
  const plain = (line: string) => /^([a-z_0-9]+)×(\d+)$/u.exec(line);
  const nameOf = (line: string) => /^([a-z_0-9]+)×/u.exec(line)?.[1] ?? null;
  const touched = (line: string) => { const name = nameOf(line); return name !== null && items.some(item => isItemOf(name, item)); };
  // The stacks of one kind that a promise names are added up first (the rewrite adds up only the lines it can read whole).
  const sums = new Map<string, number>();
  const merged: string[] = [];
  for (const line of lines) {
    const match = plain(line);
    if (match && touched(line)) {
      if (!sums.has(match[1]!)) merged.push(match[1]!);
      sums.set(match[1]!, (sums.get(match[1]!) ?? 0) + Number(match[2]));
    } else merged.push(line);
  }
  const rows = merged.map(entry => sums.has(entry) ? `${entry}×${sums.get(entry)}` : entry);
  const first = new Map<string, number>();
  const total = (item: string) => rows.reduce((sum, row) => sum + (touched(row) && isItemOf(nameOf(row)!, item) ? Number(/×(\d+)/u.exec(row)?.[1] ?? 0) : 0), 0);
  return rows.map((row, index) => {
    const name = nameOf(row);
    if (name === null || !touched(row)) return row;
    const notes: string[] = [];
    for (const item of items.filter(candidate => isItemOf(name, candidate))) {
      const matching = rows.filter(other => nameOf(other) !== null && isItemOf(nameOf(other)!, item));
      if (matching.length > 1 && first.get(item) !== undefined && first.get(item) !== index) continue;
      first.set(item, index);
      const held = open.filter(promise => promise.item === item), all = total(item);
      const parts = [...held.map((promise, position) => `${position === 0 ? '約束 ' : ''}#${promise.id} ${promise.use}に ${promise.count}`), `外 ${freeOutside(promises!, item, all)}`];
      notes.push(matching.length > 1 ? `${itemWord(item)}の合計 ${all}: ${parts.join('・')}` : parts.join('・'));
    }
    return notes.length ? `${row}（${notes.join('）（')}）` : row;
  });
}
