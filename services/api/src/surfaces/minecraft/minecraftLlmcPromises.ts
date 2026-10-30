import { gainsOf } from './minecraftPromiseGains.js';
import {
round1,key,sumShown,reasonOf,seenOf,haveIn,deltaFor,relationOf,isWorn,isMoved,byOf,appended,closedWhy,insteadLack,itemWord,
isItemOf,purposeProduct,sameHand
} from './minecraftLedgerEvents.js';
import { AHEAD_LIMIT,CONNECTIONS_LIMIT } from './minecraftLedgerTypes.js';
import type { LedgerAhead,LedgerSeen,LedgerInput,LedgerAdded,LedgerResult,Entry } from './minecraftLedgerTypes.js';
import type { PlanPromise,PromiseEvent } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { ActCondition } from '../../contracts/minecraftActCondition.js';
import { deathBetween,type InventoryEvent } from '../../contracts/continueContract.js';
import { carried,clauseHolds,clauseText,conditionHolds,doneFacts,validCondition,type DoneFacts } from './minecraftConditions.js';
import type { OnceFact } from './minecraftLlmcOnceFacts.js';
import { materialsOf } from './minecraftLlmcRecipes.js';
export { snapshotUses, readLedgerSeen } from './minecraftLedgerState.js';
export { LEDGER_REASONS, itemWord } from './minecraftLedgerEvents.js';
export { emptyLedgerSeen } from './minecraftLedgerTypes.js';
export type { UsesSnapshot, LedgerObs, LedgerAhead, LedgerSeen, LedgerBy, LedgerInput, LedgerAdded, LedgerResult } from './minecraftLedgerTypes.js';

/**
 * The promises with the events and the observation put to their ledgers. Chapter 3's rules, in this order: the
 * events (once each, by id, put to the promise by the
 * definition the command was sent with), `have` from the observation (only a newer one), what the events do not
 * explain (`unexplained`, or `lost_death` when the body
 * died), `instead` and `until` asked again of the observation. Nothing is refused.
 */
export function applyLedger(promises: readonly PlanPromise[], ledgerSeen: LedgerSeen, input: LedgerInput): LedgerResult {
const freshInventoryEvents = () => {
  const seenIds = new Set(ledgerSeen.eventIds);
  const fresh: InventoryEvent[] = [];
  for (const event of input.events) {
    if (!event || typeof event.id !== 'string' || seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    fresh.push(event);
  }
return { fresh };
};
const { fresh } = freshInventoryEvents();
  const now = seenOf(input.observation), last = ledgerSeen.lastObs;
  const relation = now ? relationOf(ledgerSeen, now) : null, newer = relation === 'newer';
const eventOrigin = () => {
  const callConnection = input.from?.connectionId ?? now?.run.connectionId ?? last?.connectionId ?? '', bootOf =
     input.from?.bodyBoot ?? now?.run.bodyBoot ?? last?.bodyBoot ?? '';
return { callConnection, bootOf };
};
const { callConnection, bootOf } = eventOrigin();
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
  const coveredBy = (connection: string, obsSeq: number | null): boolean => !now || connection !== now.run.connectionId ||
     obsSeq === null || obsSeq <= now.obsSeq;
  const deathNow = !!now && newer && typeof now.life.deathEpoch === 'string' && deathBetween(ledgerSeen.death ?? null, now.life).death;

  const added: LedgerAdded[] = [], facts: OnceFact[] = [], withdrawn: string[] = [], out: PlanPromise[] = [], aheadNext: LedgerAhead[] = [];
  const products = [...(ledgerSeen.products ?? []), ...fresh.filter(event => event.reason === 'crafted' && event.count > 0
    && promises.some(promise => promise.state !== 'closed' && purposeProduct(promise.use) === event.item)).map(event => ({ id: event.id,
       item: event.item }))].slice(-AHEAD_LIMIT);
  let changed = fresh.length > 0 || newer;
  const sum = (list: ReadonlyArray<{ delta: number }>) => round1(list.reduce((total, item) => total + item.delta, 0));

  function updatePromise(promise: PlanPromise): void {
    if (promise.state === 'closed') { out.push(promise);
      return; }
    const snapshot = input.uses?.find(item => item.id === promise.id);
    // The events that are this promise's: by the definition the command was sent with when the item is that, else by
// the promise as it is.
const entriesForPromise = () => {
    const entries: Entry[] = [];
    for (const event of fresh) {
      // Amendment A-6 13: the definition the command was sent with says whose the event is (its item and rev); what it
// does to the count the promise keeps is by the item the promise is of now.
      const viaSnapshot = snapshot ? deltaFor(snapshot.item, event) : 0, own = deltaFor(promise.item, event);
      const shown = viaSnapshot !== 0 ? viaSnapshot : own;
      if (shown === 0) continue;
      entries.push({ event, delta: isWorn(event) ? 0 : own, shown, declared: viaSnapshot !== 0, rev: viaSnapshot !== 0 ? snapshot!.rev : promise.rev,
        item: viaSnapshot !== 0 ? snapshot!.item : promise.item, connection: connectionOf(event), old: isOld(event) });
    }
return { entries };
};
const { entries } = entriesForPromise();
const observePromiseEntries = () => {
    const pending = (ledgerSeen.ahead ?? []).filter(item => item.promise === promise.id);
    const live = entries.filter(entry => !entry.old);
    const newAhead = (list: Entry[]): LedgerAhead[] => list.filter(entry => entry.delta !== 0).map(entry => ({ promise: promise.id, delta:
       entry.delta, connection: entry.connection, obsSeq: obsOf(entry.event) }));
    // What the new observation shows of the events not seen before, and what it does not show yet.
    const coveredPending = newer ? pending.filter(item => coveredBy(item.connection, item.obsSeq)) : [];
    const coveredLive = newer ? live.filter(entry => coveredBy(entry.connection, obsOf(entry.event))) : [];
    const observed = newer && now ? haveIn(promise.item, now.facts) : null;
    const expected = observed !== null && promise.have !== undefined ? round1(promise.have + sum(coveredPending) + sum(coveredLive)) : null;
    const diff = observed !== null && expected !== null ? round1(observed - expected) : 0;
    const carriedOn = newer ? [...pending.filter(item => !coveredPending.includes(item)), ...newAhead(live.filter(entry => !coveredLive.includes(entry)))]
      : [...pending, ...newAhead(live)];
    aheadNext.push(...carriedOn);

return { pending, coveredPending, coveredLive, observed, diff, carriedOn };
};
const { pending, coveredPending, coveredLive, observed, diff, carriedOn } = observePromiseEntries();
    // The count each line shows as `have`: the count before, plus the events one by one (with no earlier look, the
// observation put back before them).
    let cur = round1((promise.have ?? (observed !== null ? round1(observed - sum(coveredPending) - sum(coveredLive)) : 0)) + sum(pending));
    // make's middle materials are put together: what was made and used within one hand is the net of it, one line.
const netEntryLines = () => {
    const lines: Array<{ entries: Entry[]; net: boolean }> = [], middles = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (!entry.event.intermediate) { lines.push({ entries: [entry], net: false });
        continue; }
      const name = `${entry.event.item}|${entry.item}`, group = middles.get(name);
      if (group) group.push(entry);
      else { const created = [entry];
        middles.set(name, created);
        lines.push({ entries: created, net: true }); }
    }
return { lines };
};
const { lines } = netEntryLines();
    const written: PromiseEvent[] = [];
    function writeEntryLine(line: { entries: Entry[]; net: boolean }): void {
      const first = line.entries[0]!, net = sumShown(line.entries), worn = !line.net && isWorn(first.event);
      cur = round1(cur + sum(line.entries.filter(entry => !entry.old)));
      if (net === 0 && !worn) return;
      const reason = line.net ? (net > 0 ? 'crafted' : 'craft_ingredient') : reasonOf(first.event, input.by, input.hands);
      const kind: PromiseEvent['kind'] = first.event.reason === 'death' ? 'lost_death' :
         first.event.reason === 'unexplained' ? 'unexplained' : !line.net && isMoved(first.event) ? 'moved' : net < 0 ? 'consumed' : 'gained';
      const source = byOf(input.by, first.event.id);
      written.push({ id: first.event.id, at: input.at, kind, count: kind === 'unexplained' ? net : Math.abs(net), have: Math.max(0, cur),
         declared: first.declared, reason,
        promiseRev: first.rev, item: first.item, ...(source ? { by: source } : {}) });
    }
for (const line of lines) writeEntryLine(line);
const writeUnexplainedEntry = () => {
    if (observed !== null && diff !== 0) {
      // What the events do not explain is said as it is, not shared out. Under a death the loss is the death's; a body
// that lost its record says so.
      const dead = deathNow && diff < 0;
      written.push({ id: dead ? `death:${String(now!.life.deathEpoch)}:${String(now!.life.deathSeq)}` : `unexplained:${key(
        now!.run)}:${now!.obsSeq}`, at: input.at,
        kind: dead ? 'lost_death' : 'unexplained', count: dead ? -diff : diff, have: round1(observed + sum(carriedOn)), reason:
           dead ? 'death' : input.lost ? 'events_lost' : 'unexplained' });
    }
};
writeUnexplainedEntry();
    for (const line of written) added.push({ ...line, promise: promise.id });
    let next = appended(promise, written);
    if (observed !== null) next = { ...next, have: observed };

    // Run 48: actually crafting the named product uses the reservation for its purpose. Require the body's
    // ingredient and crafted events from the SAME command/pass/hand, never an unexplained inventory loss.
const closeUsedReservation = () => {
    const product = !promise.instead && !promise.until ? purposeProduct(promise.use) : null;
    const usedForProduct = product && products.some(gain => gain.item === product
      && next.ledger.filter(line => line.kind === 'consumed' && line.item === promise.item && line.promiseRev === promise.rev &&
         line.reason === 'craft_ingredient'
        && sameHand(line.id, gain.id)).reduce((total, line) => total + line.count, 0) >= promise.count);
    if (usedForProduct) {
      const line: PromiseEvent = { id: `plan:used:${promise.rev}`, at: input.at, kind: 'closed', count: 0, have: next.have ?? 0, reason:
         `用途 ${product} に使った` };
      next = { ...appended(next, [line]), state: 'closed', closedBy: 'used' };
      added.push({ ...line, promise: promise.id });
      changed = true;
    }

};
closeUsedReservation();
    // `instead` and `until` are asked again at each observation (not of an older one).
const refreshPromiseConditions = () => {
    if (next.state !== 'closed' && now && relation !== 'older') {
      const instead = promise.instead && validCondition(promise.instead) ? promise.instead as ActCondition : null;
      if (instead) {
        const holds = conditionHolds(instead, now.frame), factKey = `promise_instead_lost:${promise.id}:r${promise.rev}`;
        if (holds === true) {
          withdrawn.push(factKey);
          if (next.state === 'open') { next = { ...next, state: 'kept_by_instead' };
            changed = true; }
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
};
refreshPromiseConditions();
    out.push(next);
  }
for (const promise of promises) updatePromise(promise);

const nextLedgerObservation = () => {
  const seen: LedgerSeen = { eventIds: fresh.length ? [...ledgerSeen.eventIds, ...fresh.map(event => event.id)] : ledgerSeen.eventIds,
    lastObs: newer && now ? { bodyBoot: now.run.bodyBoot, connectionId: now.run.connectionId, obsSeq: now.obsSeq } : last };
  const observedDeathCounter = () => (newer && now && typeof now.life.deathEpoch === 'string' ? deathBetween(ledgerSeen.death ?? null,
     now.life).counter : ledgerSeen.death ?? null);
  const counter = observedDeathCounter();
  if (counter) seen.death = counter;
  const connections = newer && now && last && key(last) !== key(now.run) ? [...(ledgerSeen.connections ?? []), key(last)].slice(
    -CONNECTIONS_LIMIT) : ledgerSeen.connections;
  if (connections?.length) seen.connections = connections;
  if (aheadNext.length) seen.ahead = aheadNext.slice(-AHEAD_LIMIT);
  if (products.length) seen.products = products;
return { seen };
};
const { seen } = nextLedgerObservation();
  return { promises: out, ledgerSeen: seen, added, facts, withdrawn, changed: changed || added.length > 0 };
}
const REASON_WORDS: Readonly<Record<string, string>> = { smelt_fuel: 'かまどの燃料', craft_ingredient: '作る材料', smelt_ingredient: '焼く材料', eat:
   '食事', reflex_eat: '反射の食事',
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
  const outsidePromiseWords = () => (have === undefined || promise.state !== 'open' ? '' : `（約束の外で使えるのは ${freeOutside(all.length ? all :
     [promise], promise.item, have)}${unit}）`);
  const outside = outsidePromiseWords();
  const parts = [have === undefined ? '今 不明' : `今 ${round1(have)}${unit}${outside}`];
  const keptPromiseLine = () => {

    const words = facts && promise.instead && validCondition(promise.instead) ? holdWords(promise.instead as ActCondition, facts) : null;
    return `${head}: ${[...parts, `代わりの条件を満たす${words ? `（${words}）` : ''}`].join('・')}`;
    };
  if (promise.state === 'kept_by_instead') return keptPromiseLine();
  const recent = context.since === undefined ? [] : promise.ledger.filter(event => event.at > context.since!);
  const died = recent.filter(event => event.kind === 'lost_death');
  const changes = changesWords(recent.filter(event => event.kind !== 'lost_death'), unit, promise.item);
  if (changes) parts.push(changes);
  if (died.length) parts.push(`死んで ${round1(died.reduce((total, event) => total + event.count, 0))}${unit || ' '}失った`);
  const short = have === undefined ? 0 : round1(promise.count - have);
  return `${head}: ${parts.join('・')}${short > 0 && !died.length ? `（足りない ${short}）` : ''}`;
}

/**
 * 「直前に 2 減った（理由: …）」: what the events after the last decision took from the promise's item and gave to it. An event put to the
 * definition the promise had before it was
 * revised to another item (its `item` is that item's) changed that item's count, not this one's: it is said apart, with its item
 * (「改訂前の品目 板 が 4 減った」).
 */
function changesWords(all: readonly PromiseEvent[], unit: string, itemNow: string): string {
  const events = all.filter(event => !event.item || event.item === itemNow), before = all.filter(event => event.item && event.item !== itemNow);
  const signed = (event: PromiseEvent): number => event.kind === 'consumed' ? -event.count : event.kind === 'gained' ? event.count
    : event.kind === 'moved' ? (event.reason === 'stored' ? -event.count : event.reason === 'retrieved' ? event.count : 0) :
       event.kind === 'unexplained' ? event.count : 0;
  const part = (list: PromiseEvent[], word: string, unit_ = unit): string | null => {
    if (!list.length) return null;
    const total = round1(list.reduce((sum, event) => sum + (event.reason === 'reflex_armor' && event.kind === 'moved' ? event.count :
       Math.abs(signed(event))), 0));
    const reasons = [...new Set(list.map(event => reasonWords(event.reason)))].filter(Boolean).join('・');
    const act = list.filter(event => event.kind === 'consumed' && !(event.reason ?? '').startsWith('reflex_'));
    const declaredWords = act.length ? (act.every(event => event.declared) ? '申告の用途' : act.some(event => event.declared) ? '一部は申告の用途' : '申告の用途ではない') : '';
    const placeOnly = list.every(event => event.kind === 'moved') ? (list.every(
      event => event.reason === 'reflex_armor') ? '持ち物から防具の欄へ移っただけで、持っている数は変わらない' : '置き場所が変わっただけ') : '';
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
    const words = [part(mine.filter(event => signed(event) < 0), '減った', ''), part(mine.filter(event => signed(event) > 0), '増えた', ''), part(
      mine.filter(event => signed(event) === 0), '動いた', '')]
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
 * What an act's hands spend that the head can count from their arguments (A-8 2): a smelt's fuel and what it smelts, what a drop
 * throws and a chest takes in, the blocks of a place
 * (one a cell) and of a pillar (`n`, with its block named), and (A-10 2) the materials of a make and a craft, from the table of
 * recipes (`minecraftLlmcRecipes.ts`; a make walks the chain
 * of planks, sticks and the rest, taking what she carries first). `uncounted`: the make or craft whose item the
 * table does not have:
 * nothing is counted for it, and it is said so.
 */
export function spendsOf(hands: readonly { do?: string; item?: string; items?: readonly { item: string; count?: number }[]; fuel?: string; fuelCount?: number;
  block?: string; at?: readonly unknown[]; n?: number; op?: string; count?: number; collect?: boolean; rel?: boolean; target?: string }[],
     pack?: ReadonlyMap<string, number>): { spends: { item: string; count: number }[]; uncounted: string[] } {
  const out: { item: string; count: number }[] = [], uncounted: string[] = [];
  type SpendHand = Parameters<typeof spendsOf>[0][number];
  const keepListed = (items: SpendHand['items']) => {
    for (const entry of items ?? []) if (entry.count) out.push({ item: entry.item, count: entry.count });
  };
  const keepSmelting = (hand: SpendHand) => {
    if (hand.fuel && hand.fuelCount) out.push({ item: hand.fuel, count: hand.fuelCount });
    keepListed(hand.items);
  };
  const keepCraftMaterials = (hand: SpendHand, item: string) => {
      const made = materialsOf(item, hand.count ?? 1, { chain: hand.do === 'make', ...(pack ? { pack } : {}) });
      if (made.uncounted) uncounted.push(`${hand.do} ${item}`); else out.push(...made.spends);
  };
  for (const hand of hands) {
    if (hand.do === 'smelt') {
      keepSmelting(hand);
    } else if (hand.do === 'drop') keepListed(hand.items);
    else if (hand.do === 'chest' && (hand.op === 'put')) keepListed(hand.items);
    else if (hand.do === 'place' && hand.block && hand.at?.length) out.push({ item: hand.block, count: hand.at.length });
    else if (hand.do === 'pillarUp' && hand.block && hand.n) out.push({ item: hand.block, count: hand.n });
    else if ((hand.do === 'make' || hand.do === 'craft') && hand.item) {
      keepCraftMaterials(hand, hand.item);
    }
  }
  return { spends: out, uncounted };
}
export const actSpends = (hands: Parameters<typeof spendsOf>[0], pack?: ReadonlyMap<string, number>): { item: string; count:
   number }[] => spendsOf(hands, pack).spends;
/** A spend counts against a promise when either names the other's kind (a spend of `planks` from a recipe may be
 * any kind of planks, so it counts against `spruce_planks` too). */
const touches = (spend: string, promised: string): boolean => isItemOf(spend, promised) || isItemOf(promised, spend);
/**
 * A-8 2: when the act's spending is more than what the open promises of an item leave free, one line (said once,
 * after the act is sent; nothing is refused):
 * 「この act は約束 #1（地下の作業台用の板 4）を割る見込み（板 6 を使い、残り 1）」. Facts the head counts; the choice stays the model's.
 * `uncounted` (A-10 2): the makes and crafts it
 * could not count, for the decision's record.
 */
export function breakingOf(promises: readonly PlanPromise[], hands: Parameters<typeof actSpends>[0], observation: BodyObservation | null): {
   lines: string[]; keptBy: string[]; uncounted: string[] } {
  const facts = doneFacts(observation);
  if (!facts) return { lines: [], keptBy: [], uncounted: [] };
  const { spends, uncounted } = spendsOf(hands, facts.counts);
  if (!spends.length) return { lines: [], keptBy: [], uncounted };
  const lines: string[] = [], keptBy: string[] = [];
  const forPurpose = new Set(promises.filter(promise => {
    const product = !promise.instead && !promise.until ? purposeProduct(promise.use) : null;
    return product && hands.some(hand => (hand.do === 'make' || hand.do === 'craft') && hand.item?.replace(/^minecraft:/u, '') === product
      && spends.filter(spend => touches(spend.item, promise.item)).reduce((total, spend) => total + spend.count, 0) >= promise.count);
  }).map(promise => promise.id));
  const stillReserved = promises.filter(promise => !forPurpose.has(promise.id));
  for (const promise of promises.filter(item => item.state === 'open').sort((a, b) => a.id - b.id)) {
    const used = spends.filter(spend => touches(spend.item, promise.item)).reduce((total, spend) => total + spend.count, 0);
    if (!used) continue;
    if (forPurpose.has(promise.id)) {
      keptBy.push(`約束 #${promise.id} は申告の用途（${promise.use}）に使う見込み`);
      continue;
    }
    const have = haveIn(promise.item, facts);
    if (used <= freeOutside(stillReserved, promise.item, have)) continue;
    // A-11 1: an act whose hands make the promise's `instead` hold (a work table picked up or made) keeps the
// promise; it is not one that breaks it.
    const instead = promise.instead && validCondition(promise.instead) ? insteadAfter(promise.instead as ActCondition, hands, facts, spends,
       observation) : null;
    if (instead) {
      keptBy.push(`約束 #${promise.id} は代わりの条件（${instead}）で満たす見込み`);
      continue;
    }
    const unit = promise.item === 'food' ? ' 点' : '';
    const link = /[用分]$/u.test(promise.use) ? 'の' : '用の';
    lines.push(`この act は約束 #${promise.id}（${promise.use}${link}${itemWord(promise.item)} ${promise.count}${unit}）を割る見込み（${itemWord(
      promise.item)} ${round1(used)}${unit} を使い、残り ${Math.max(0, round1(have - used))}${unit}）`);
  }
  return { lines, keptBy, uncounted };
}
export const breakingWords = (promises: readonly PlanPromise[], hands: Parameters<typeof actSpends>[0], observation: BodyObservation | null): string[] =>
  breakingOf(promises, hands, observation).lines;

/**
 * Whether the act leaves the promise's `instead` holding, and in what words (A-11 1): one alternative of the
 * condition whose clauses all hold by this rule, written as `holdWords` writes them
 * (「作業台 1」「近くに作業台 2m」). A `have` clause (item n) holds when what she carries, plus what the hands bring in, less
 * what they spend of it, is n or more; a `near` clause (block r)
 * holds when it holds now, or when a hand places that block. Every other kind of clause, and a `have` that asks
 * for fewer, is not something the head can tell, and the alternative then does not hold.
 */
function insteadAfter(condition: ActCondition, hands: Parameters<typeof actSpends>[0], facts: DoneFacts, spends: ReadonlyArray<{ item:
   string; count: number }>,
  observation: BodyObservation | null): string | null {
  const gains = gainsOf(hands, observation);
  for (const alternative of condition) {
    const words: string[] = [];
    for (const clause of alternative) {
      if (clause.k === 'have' && (clause.op ?? '>=') === '>=') {
        const brought = gains.filter(gain => touches(gain.item, clause.item)).reduce((total, gain) => total + gain.count, 0);
        const used = spends.filter(spend => touches(spend.item, clause.item)).reduce((total, spend) => total + spend.count, 0);
        const after = carried(facts.counts, clause.item) + brought - used;
        if (after < clause.n) break;
        words.push(`${itemWord(clause.item)} ${round1(after)}`);
      } else if (clause.k === 'near') {
        if (clauseHolds(clause, facts) === true) {
          const found = facts.utilities?.found.filter(item => item.block === clause.block).sort((left, right) => left.distance - right.distance)[0];
          words.push(`近くに${itemWord(clause.block)}${found ? ` ${round1(found.distance)}m` : ''}`);
        } else if (hands.some(hand => hand.do === 'place' && hand.block !== undefined && hand.at?.length && touches(hand.block,
           clause.block))) words.push(`近くに${itemWord(clause.block)}`);
        else break;
      } else break;
      if (words.length === alternative.length) return words.join('・');
    }
  }
  return null;
}

/**
 * A-9: the pack's lines with the open promises' shares written where the model counts what it can spend:
 * `spruce_planks×7（約束 #1 地下の作業台に 4・外 3）`. A promise of
 * `planks` is beside every kind of planks (their total is said when there are several lines: `板の合計 7`); the
 * lines of an item no open promise names are as they were;
 * a promise held by its `instead` (`kept_by_instead`) and the food points (not a stack) are not written. The
 * ledger's lines stay as they are.
 */
export function shareStacks(lines: readonly string[], promises: readonly PlanPromise[] | undefined): string[] {
  const open = (promises ?? []).filter(promise => promise.state === 'open' && promise.item !== 'food').sort((left, right) => left.id - right.id);
  if (!open.length) return [...lines];
  const items = [...new Set(open.map(promise => promise.item))];
  const plain = (line: string) => /^([a-z_0-9]+)×(\d+)$/u.exec(line);
  const nameOf = (line: string) => /^([a-z_0-9]+)×/u.exec(line)?.[1] ?? null;
  const touched = (line: string) => { const name = nameOf(line);
    return name !== null && items.some(item => isItemOf(name, item)); };
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
  const total = (item: string) => rows.reduce((sum, row) => sum + (touched(row) && isItemOf(nameOf(row)!, item) ? Number(/×(\d+)/u.exec(
    row)?.[1] ?? 0) : 0), 0);
  return rows.map((row, index) => {
    const name = nameOf(row);
    if (name === null || !touched(row)) return row;
    const notes: string[] = [];
    for (const item of items.filter(candidate => isItemOf(name, candidate))) {
      const matching = rows.filter(other => nameOf(other) !== null && isItemOf(nameOf(other)!, item));
      if (matching.length > 1 && first.get(item) !== undefined && first.get(item) !== index) continue;
      first.set(item, index);
      const held = open.filter(promise => promise.item === item), all = total(item);
      const parts = [...held.map((promise, position) => `${position === 0 ? '約束 ' : ''}#${promise.id} ${promise.use}に ${promise.count}`),
         `外 ${freeOutside(promises!, item, all)}`];
      notes.push(matching.length > 1 ? `${itemWord(item)}の合計 ${all}: ${parts.join('・')}` : parts.join('・'));
    }
    return notes.length ? `${row}（${notes.join('）（')}）` : row;
  });
}
