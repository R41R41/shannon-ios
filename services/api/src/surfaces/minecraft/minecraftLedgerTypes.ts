import type { PlanPromise, PromiseEvent } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { type DeathCounter, type InventoryEvent } from '../../contracts/continueContract.js';
import { type DoneFacts } from './minecraftConditions.js';
import type { OnceFact } from './minecraftLlmcOnceFacts.js';

/**
 * The promises' ledger, the head's half (the continue contract, chapter 3; amendment A-1 4). Pure: the plan tool's owner
 * (`fcaPlanTools.ts`) holds the tree and the
 * `LedgerSeen`, calls `applyLedger` and keeps what comes back; `promiseLines` makes the live state's line of each open promise.
 *
 * What the ledger does, and does not:
 * - The model writes the promises (`plan.update`); the ledger is the head's. Nothing here stops a hand or a use
 * because of a promise.
 * - **What she has is what the observation says.** `have` is counted again from the newest observation, never added up from the
 * events. An event is only
 *   the explanation of a change: a difference the events of the command do not explain stays `unexplained` and is
 * not shared out by a guess.
 * - **An event is put to the ledger once**, by its id (`LedgerSeen.eventIds`, kept beyond the 32 lines a promise shows).
 * - **Whose use it was** is told by the definition the command was sent with (`UsesSnapshot`), not by the promise as it is now.
 */

/** A promise's definition as the command was sent with it (kept with the command; a later revision does not
 * change the attribution of its events). */
export interface UsesSnapshot {
  id: number;
  rev: number;
  item: string;
  count: number;
  use: string;
}

/** The newest observation the ledger took: only a newer one (same connection: a larger `obsSeq`; a new
 * connection) rewrites `have`. */
export interface LedgerObs {
  bodyBoot: string;
  connectionId: string;
  obsSeq: number;
}

/** An event applied whose observation the ledger has not taken yet: the next newer observation must find its effect (it is not an
 * unexplained difference). */
export interface LedgerAhead {
  promise: number;
  delta: number;
  connection: string;
  obsSeq: number | null;
}

/**
 * The ledger's memory beside the tree (the checkpoint's `fcaPlanLedgerSeen`; gone when the task ends).
 * `eventIds` and `lastObs` are
 * the contract's; the rest are
 * the same memory kept for the same reason (`death`: the death counter last read, for `deathBetween`;
 * `connections`: the connections
 * replaced, so a late
 * observation of one is not taken for a new one; `ahead`: see `LedgerAhead`).
 */
export interface LedgerSeen {
  eventIds: string[];
  lastObs: LedgerObs | null;
  death?: DeathCounter | null;
  connections?: string[];
  ahead?: LedgerAhead[];
  /** Recipe outputs whose ingredient may arrive on another receipt page, retained across checkpoints. */
  products?: Array<{ id: string; item: string }>;
}

export const emptyLedgerSeen = (): LedgerSeen => ({ eventIds: [], lastObs: null });

/** Where the events came from (the command the act was sent as; `do` is the hand's verb, which tells a smelt's
 * ingredient from a craft's). */
export interface LedgerBy {
  command?: string;
  item?: string;
  pass?: number;
  hand?: number;
  do?: string;
}

export interface LedgerInput {
  /** The body's inventory events (a receipt's `delta`s and pages, or an act-less reflex's WorkingEvent `inventory.changed`). */
  events: readonly InventoryEvent[];
  by?: LedgerBy;
  /**
   * Amendment A-6 14: the verb of the hand each event came from, by the event's id (`${command}:${pass}:${hand}:${seq}` names the
   * hand; the receipt's line or the act as it was
   * sent says what the hand was). One act can hold a craft and a smelt, so `by.do` (one verb for the whole call)
   * is only the fallback
   * of an event this does not name.
   */
  hands?: Readonly<Record<string, string>>;
  /** The definitions the command was sent with (`snapshotUses`). Absent: the act declared no use. */
  uses?: readonly UsesSnapshot[];
  /** The newest observation the caller has (an older one than the ledger took does not rewrite `have`). Call at
   * each new observation
   * too, with no events. */
  observation: BodyObservation | null;
  at: string;
  /** The connection the events were made on, when it is not the observation's (a receipt that came after a reconnect). Absent: the
   * observation's. A reflex event names its own. */
  from?: { bodyBoot: string; connectionId: string };
  /** The body's `events` reply said `lost: true` (it lost its record in a restart): what the events do not explain
   * is that, not a mystery. */
  lost?: boolean;
  /** The plan's nodes (`until.node` closes a promise when the node is done). */
  nodes?: ReadonlyArray<{ id: string; state: string }>;
}

export type LedgerAdded = PromiseEvent & { promise: number };

export interface LedgerResult {
  promises: PlanPromise[];
  ledgerSeen: LedgerSeen;
  /** What was put to the ledgers by this call (a promise's number with each). */
  added: LedgerAdded[];
  /** Facts to say once (an `instead` that stopped holding), and the keys of ones that no longer hold (take them
   * back if they are not delivered). */
  facts: OnceFact[];
  withdrawn: string[];
  /** Whether a promise or the memory changed at all. */
  changed: boolean;
}

export const LEDGER_LINES = 32,
  AHEAD_LIMIT = 128,
  CONNECTIONS_LIMIT = 8;

/** What an observation gives the ledger: the connection it belongs to, its number, the counts, and the death counter it shows. */
export interface Seen {
  run: { bodyBoot: string; connectionId: string };
  obsSeq: number;
  facts: DoneFacts;
  frame: BodyObservation;
  life: {
    deathEpoch?: unknown;
    deathSeq?: unknown;
  };
}

export type Relation = 'newer' | 'same' | 'older';

/**
 * `delta` is what the event does to the count she has **of the item the promise is of now** (0 for armour put
 * on: worn is counted, and 0 for an event of an item the promise was
 * revised away from: it changes another item's count, which this promise does not count); `shown` is what the
 * event says of the item it is put to (a worn piece is 1).
 */
export interface Entry {
  event: InventoryEvent;
  delta: number;
  shown: number;
  declared: boolean;
  rev: number;
  item: string;
  connection: string;
  old: boolean;
}
