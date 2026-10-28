import { createHash } from 'node:crypto';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import type { EventsMore, EventsReply, InventoryEvent } from '../../contracts/continueContract.js';
import { EVENTS_SKILL } from '../../contracts/continueContract.js';
import { readActResult } from '../../contracts/minecraftActContract.js';
import type { MinecraftControlReceipt } from '../../contracts/minecraftControlContract.js';
import type { LedgerBy, LedgerInput, UsesSnapshot } from './minecraftLlmcPromises.js';
import type { MinecraftControlStore } from './store/minecraftControlStore.js';

/**
 * A command's inventory events, from its receipt and from the pages of the internal `events` command (continue contract 3). Nothing here sends: the pure readers
 * are for the live path and for the receipt box's reprocessing, and `fetchEventPages` (`minecraftControlRecovery.ts`) asks the body for what did not fit.
 */
/** The most events one page asks for (the contract's example is 120; the body may give fewer). */
export const EVENTS_PAGE = 120;
/** The id of the `events` command for one page of a command: the same range is the same id, so it is asked once and read again from the store. */
export const eventsCommandId = (command: string, fromSeq: number): string =>
  `events:${createHash('sha256').update(command).digest('hex').slice(0, 24)}:${fromSeq}`;
export { EVENTS_SKILL };

const isEvent = (value: unknown): value is InventoryEvent => !!value && typeof value === 'object' && typeof (value as InventoryEvent).id === 'string'
  && typeof (value as InventoryEvent).item === 'string' && Number.isFinite((value as InventoryEvent).count);
/** An `events` reply as the body wrote it, or null when it is not one. */
export function readEventsReply(text: string | undefined): EventsReply | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<EventsReply>;
    const whole = (number: unknown) => Number.isSafeInteger(number) && Number(number) >= 0;
    if (!value || typeof value.command !== 'string' || !whole(value.from) || !whole(value.to) || !whole(value.total) || !whole(value.nextSeq)
      || typeof value.done !== 'boolean' || typeof value.lost !== 'boolean' || !Array.isArray(value.events)) return null;
    return { ...value, events: value.events.filter(isEvent) } as EventsReply;
  } catch { return null; }
}

/** The events a receipt carries itself (its hands' `delta`s and the older passes' events) in the order the body gave them, once each, and where the rest is. */
export function eventsOfReceipt(receipt: Pick<MinecraftControlReceipt, 'result' | 'eventsMore'>): { events: InventoryEvent[]; more: EventsMore | null } {
  const result = readActResult(receipt.result);
  if (!result) return { events: [], more: receipt.eventsMore ?? null };
  return { events: uniqueEvents([...(result.earlierEvents ?? []), ...result.lines.flatMap(line => line.delta ?? [])]), more: receipt.eventsMore ?? result.eventsMore ?? null };
}
/** Once each by id, in the body's delivery order when it numbered them all. */
export function uniqueEvents(events: readonly InventoryEvent[]): InventoryEvent[] {
  const seen = new Set<string>(), out: InventoryEvent[] = [];
  for (const event of events) if (!seen.has(event.id)) { seen.add(event.id); out.push(event); }
  return out.every(event => event.deliverySeq !== undefined) ? out.sort((a, b) => a.deliverySeq! - b.deliverySeq!) : out;
}

/** The pages of a command already in the store (their `events` commands' receipts), in order from `fromSeq`; `complete` false when the next page is not there. */
export function storedPages(store: MinecraftControlStore, command: string, fromSeq: number, total: number):
  { events: InventoryEvent[]; lost: boolean; nextSeq: number; complete: boolean } {
  const events: InventoryEvent[] = [];
  let next = fromSeq;
  for (let guard = 0; guard < 200 && next < total; guard += 1) {
    const reply = readEventsReply(store.receipt(eventsCommandId(command, next))?.result);
    if (!reply || reply.command !== command) return { events, lost: false, nextSeq: next, complete: false };
    if (reply.lost) return { events, lost: true, nextSeq: reply.nextSeq, complete: true };
    events.push(...reply.events);
    if (reply.done || reply.nextSeq <= next) return { events, lost: false, nextSeq: reply.nextSeq, complete: true };
    next = reply.nextSeq;
  }
  return { events, lost: false, nextSeq: next, complete: next >= total };
}

/**
 * The verb of the hand each event came from (amendment A-6 14): the event's id names its pass and hand (`${command}:${pass}:${hand}:${seq}`), the receipt's line of that pass and hand says
 * what it was, and an older pass folded into a count (no line of its own) is what the act was sent with at that hand. An event that names none (a reflex's) has no entry.
 */
export function handKindsOf(events: readonly InventoryEvent[], result: string | undefined, sent: readonly { do: string }[] | undefined): Record<string, string> {
  const lines = readActResult(result)?.lines ?? [];
  const out: Record<string, string> = {};
  for (const event of events) {
    const match = /^.+:(\d+):(\d+):\d+$/u.exec(event.id);
    if (!match || event.id.startsWith('reflex:')) continue;
    const pass = Number(match[1]), hand = Number(match[2]);
    const line = lines.find(item => item.i === hand && (item.pass ?? 1) === pass);
    const kind = line?.do ?? sent?.[hand - 1]?.do;
    if (kind) out[event.id] = kind;
  }
  return out;
}

/**
 * What the ledger takes of one command (`FcaPlanPort.applyLedger`'s input): the events once each, whose act they were, the definitions it was sent with and where the body was.
 * `result` (the receipt's) and `sent` (the hands the act was sent with) tell each event's hand (`handKindsOf`): a smelt's ingredient is not a craft's.
 */
export function ledgerInputFor(parts: { id: string; item?: string; events: readonly InventoryEvent[]; uses: readonly UsesSnapshot[]; observation: BodyObservation | null;
  connectionId: string; lost?: boolean; result?: string | undefined; sent?: readonly { do: string }[] | undefined }): Omit<LedgerInput, 'nodes' | 'at'> {
  const hands = handKindsOf(parts.events, parts.result, parts.sent);
  const by: LedgerBy = { command: parts.id, ...(parts.item ? { item: parts.item } : {}) };
  const run = (parts.observation?.state as { bodyRun?: { bodyBoot?: unknown; connectionId?: unknown } } | undefined)?.bodyRun;
  const from = typeof run?.bodyBoot === 'string' ? { bodyBoot: run.bodyBoot, connectionId: parts.connectionId } : undefined;
  return { events: parts.events, by, ...(Object.keys(hands).length ? { hands } : {}), ...(parts.uses.length ? { uses: parts.uses } : {}), observation: parts.observation, ...(from ? { from } : {}),
    ...(parts.lost ? { lost: true } : {}) };
}
