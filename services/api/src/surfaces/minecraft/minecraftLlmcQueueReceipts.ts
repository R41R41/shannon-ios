import type { QueueDeps, QueueItem, QueueRecordRow } from './minecraftLlmcQueueState.js';
import { readActResult, type ActInput } from '../../contracts/minecraftActContract.js';
import type { MinecraftControlReceipt } from '../../contracts/minecraftControlContract.js';
import type { UsesSnapshot } from './minecraftLlmcPromises.js';
import type { ReleasedEvent, SettledEvent } from './minecraftControl.js';
import { eventsOfReceipt, ledgerInputFor } from './minecraftControlEvents.js';
import { offer as offerOnceFact } from './minecraftLlmcOnceFacts.js';
import { itemLabel, itemResult, unitOfReceipt } from './minecraftLlmcQueueWords.js';
import { correctionWords, heldWords, releasedWords } from './minecraftLlmcResultWords.js';
import { eventsRow, receivedRow, releasedRow, correctedRow, type RowContext } from './minecraftOperationRows.js';

export function createQueueReceiptHandlers(
  deps: QueueDeps,
  shared: {
    name: string;
    headBoot: string;
    items: QueueItem[];
    noteLines: string[];
    booked: Set<string>;
    pending: Set<Promise<unknown>>;
    stopCleanup: AbortController;
    iso(): string;
    log(line: string): void;
    rowContext(item: Pick<QueueItem, 'item' | 'id'> | null): RowContext;
    record(row: QueueRecordRow): void;
    settleFlag(): void;
  },
) {
  const { name, headBoot, items, noteLines, booked, pending, stopCleanup, iso, log, rowContext, record, settleFlag } = shared;

  /** What the ledger is given of a command that ended with a real result (chapter 3): its events once each, the rest by pages, the
   * definitions it was sent with. */
  /** The hands an act was sent with (the store keeps the command's arguments): what an event's hand was when the
   * receipt has no line of
   * its own for it (a folded pass). */
  const sentHands = (id: string): { do: string }[] | undefined => {
    const hands = (deps.control.store.command(id)?.arguments as { hands?: unknown } | undefined)?.hands;
    return Array.isArray(hands)
      ? hands.filter((hand): hand is { do: string } => !!hand && typeof (hand as { do?: unknown }).do === 'string')
      : undefined;
  };

  function book(item: Pick<QueueItem, 'id' | 'item' | 'uses'>, receipt: MinecraftControlReceipt): void {
    if (!deps.applyLedger || readActResult(receipt.result) === null) return;
    const { events, more } = eventsOfReceipt(receipt);
    const apply = (input: ReturnType<typeof ledgerInputFor>): boolean => {
      try {
        void deps.applyLedger!(input);
        return true;
      } catch (cause) {
        log(`Shannon Minecraft ledger failed task=${deps.taskId} item=${item.item} ${String(cause).slice(0, 120)}`);
        return false;
      }
    };
    const base = { id: item.id, item: item.item, uses: item.uses, connectionId: receipt.connectionId };
    const sent = sentHands(item.id);
    const first = apply(ledgerInputFor({ ...base, events, observation: deps.observe(), result: receipt.result, sent }));
    if (!more) {
      if (first) booked.add(item.id);
      return;
    }
    const fetch = (async () => {
      const row = deps.control.store.row(item.id);
      const got = await deps.control.fetchEvents({
        command: item.id,
        context: deps.context(),
        lease: deps.lease,
        fromSeq: Math.max(more.nextSeq, row?.fetchSeq ?? 0),
        total: more.total,
        signal: stopCleanup.signal,
      });
      record(eventsRow(rowContext(item), got.lost));
      const rest =
        got.events.length || got.lost
          ? apply(
              ledgerInputFor({ ...base, events: got.events, observation: deps.observe(), lost: got.lost, result: receipt.result, sent }),
            )
          : true;
      if (first && rest && (got.complete || got.lost)) booked.add(item.id);
    })().catch(() => undefined);
    pending.add(fetch);
    void fetch.finally(() => pending.delete(fetch));
  }

  /**
   * A command an EARLIER start of the head sent is not among this queue's items (the memory went with the
   * process), but the store has it and the cleanup of this start is about it:
   * what the listeners need of it (its mark, its words, the definitions it was sent with) is read from there. Only
   * the task's acts; null for anything else.
   */
  const bygone = (id: string) => {
    const command = deps.control.store.command(id);
    if (!command || command.kind !== 'skill' || command.skill !== 'act' || command.context.taskId !== deps.taskId) return null;
    const input = (command.arguments ?? {}) as Partial<ActInput>;
    return {
      id,
      item: command.queue?.item ?? id.slice(0, 18),
      node: command.queue?.node ?? null,
      why: String(input.why ?? ''),
      queueName: command.queue?.queue ?? name,
      input: input as ActInput,
      uses: deps.control.store.row(id)?.uses ?? [],
      startedAt: null,
      because: null,
      resume: undefined,
      pre: undefined,
      done: undefined,
      reason: () => null,
    };
  };

  const bygoneContext = (old: NonNullable<ReturnType<typeof bygone>>): RowContext => ({
    run: deps.taskId,
    queue: old.queueName,
    item: old.item,
    command: old.id,
    headBoot,
    observation: deps.observe(),
    at: iso(),
  });

  /** The control told us a command of this queue was released without a receipt of its own (the cleanup, or the new connection). */
  /**
   * A command the body never answered because the body restarted (the new connection's first poll proved the
   * release): its result stays unknown (`settled_unknown`), and its events
   * are lost - a restarted body keeps no record of them, so none is asked for. The ledger takes the difference as
   * `unexplained` (`lost`), the record says so, and the model is told once.
   */
  const lostWithTheBody = (command: { id: string; item: string; uses?: readonly UsesSnapshot[] }, label: string, at: RowContext): void => {
    record(eventsRow(at, true));
    const connectionId = deps.control.store.command(command.id)?.connectionId ?? '';
    try {
      void deps.applyLedger?.(
        ledgerInputFor({
          id: command.id,
          item: command.item,
          uses: command.uses ?? [],
          connectionId,
          events: [],
          observation: deps.observe(),
          lost: true,
        }),
      );
    } catch (cause) {
      log(`Shannon Minecraft ledger failed task=${deps.taskId} item=${command.item} ${String(cause).slice(0, 120)}`);
    }
    offerOnceFact(
      deps.taskId,
      `body_restart:${command.id}`,
      `${label}: 体が再起動したため、この命令の結果と出来事は分からない。観測で確かめる`,
    );
  };

  const onReleased = ({ row, by }: ReleasedEvent) => {
    const item = items.find((entry) => entry.id === row.id);
    if (!item) {
      const old = bygone(row.id);
      if (old) {
        record(releasedRow(bygoneContext(old), 'cleanup', true));
        if (by === 'reconnect') lostWithTheBody(old, itemLabel(old), bygoneContext(old));
      }
      return;
    }
    item.state = 'released';
    // An item still waiting for its receipt is told when that comes (as a released one); one already told as unknown gets the note.
    if (item.ended) noteLines.push(releasedWords(itemLabel(item)));
    // The new connection's first poll proves the release as the cleanup does (`releasedRow`): both are the head's
    // proof, not the command's own receipt.
    record(releasedRow(rowContext(item), 'cleanup', true));
    if (by === 'reconnect') lostWithTheBody(item, itemLabel(item), rowContext(item));
    settleFlag();
  };

  const onHeld = ({ row, why }: { row: { id: string }; why: string }) => {
    const item = items.find((entry) => entry.id === row.id);
    if (!item) {
      const old = bygone(row.id);
      if (!old) return;
      noteLines.push(heldWords(itemLabel(old)));
      log(`Shannon Minecraft queue held task=${deps.taskId} item=${old.item} why=${why} (an earlier start's)`);
      try {
        deps.onHeld?.({ item: old.item, command: old.id, why });
      } catch {
        /* the operator's hold never fails the queue */
      }
      return;
    }
    noteLines.push(heldWords(itemLabel(item)));
    log(`Shannon Minecraft queue held task=${deps.taskId} item=${item.item} why=${why}`);
    try {
      deps.onHeld?.({ item: item.item, command: item.id, why });
    } catch {
      /* the operator's hold never fails the queue */
    }
  };

  /** A real result after an unknown one the model was told: the correction is said once and the events are booked once. */
  const onSettled = (event: SettledEvent) => {
    const item = items.find((entry) => entry.id === event.id);
    if (!item) {
      // The receipt of a command the earlier start sent: the row of its arrival, and, when the model was told it was
      // unknown, the correction (said once, in the record and to the
      // model) and its events in the ledger once (continue contract 1, the head's restart).
      const old = bygone(event.id);
      if (!old) return;
      record(receivedRow(bygoneContext(old), event.receipt));
      if (event.to === 'corrected') {
        const unit = unitOfReceipt(event.receipt);
        const text =
          itemResult(old, event.receipt, [])
            .text.split('\n')
            .find((line) => line.trim() !== '' && !line.startsWith('（頭が形を直して')) ?? event.receipt.outcome;
        noteLines.push(correctionWords(itemLabel(old), text));
        deps.control.store.markCorrectionSaid(old.id);
        record(correctedRow(bygoneContext(old), unit));
        book(old, event.receipt);
      }
      return;
    }
    if (event.to !== 'corrected') return;
    item.state = 'corrected';
    item.unit = unitOfReceipt(event.receipt);
    const text =
      itemResult(item, event.receipt, [])
        .text.split('\n')
        .find((line) => line.trim() !== '' && !line.startsWith('（頭が形を直して')) ?? event.receipt.outcome;
    noteLines.push(correctionWords(itemLabel(item), text));
    deps.control.store.markCorrectionSaid(item.id);
    record(correctedRow(rowContext(item), item.unit));
    book(item, event.receipt);
    settleFlag();
  };
  return { sentHands, book, bygone, bygoneContext, lostWithTheBody, onReleased, onHeld, onSettled };
}
