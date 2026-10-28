import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { conditionText } from '../../contracts/minecraftActCondition.js';
import type { ActCondition } from '../../contracts/minecraftActCondition.js';
import type { ActInput } from '../../contracts/minecraftActContract.js';
import { MC_ACT_TOOL } from '../../contracts/minecraftActContract.js';
import type { MinecraftControlReceipt, MinecraftQueueProgress } from '../../contracts/minecraftControlContract.js';
import { toolFailure, type ToolResult } from '../../mind/tools/toolRegistryPorts.js';
import { conditionWords } from './minecraftConditions.js';
import { llmcResult } from './minecraftLlmc.js';

/** The words of the head's mirror of the body's queue (`minecraftLlmcQueue.ts`): what an item's end is told as, and the lines of the live state. */
export const QUEUE_MAX = 3;
/** The body's own words of an item it did not run (`failureType`): the item never started and no hand moved. */
export const NEVER_RAN: ReadonlySet<string> = new Set(['queue_dropped', 'queue_expired', 'queue_after_gone', 'queue_busy', 'queue_full']);

/** What the words need of an item. */
export interface QueueWordsItem {
  item: string; node: string | null; why: string; input: ActInput; pre: ActCondition | undefined; done: ActCondition | undefined;
  startedAt: number | null; because: string | null; reason(): string | null;
}
export const shortWhy = (why: string): string => why.replace(/^\s*\[[^\]]*\]\s*/u, '').slice(0, 40);
/** `q15 [p7] 鉄へトンネル`: the item, its node and its why without the tag. */
export const itemLabel = (item: Pick<QueueWordsItem, 'item' | 'node' | 'why'>): string =>
  `${item.item}${item.node ? ` [${item.node}]` : ''} ${shortWhy(item.why)}`.trim();

/** Whether the receipt says the item never ran (the body dropped or refused it, or it was cancelled before it started). */
export const neverRan = (receipt: MinecraftControlReceipt, item: Pick<QueueWordsItem, 'startedAt'>): boolean =>
  NEVER_RAN.has(receipt.failureType ?? '') || (receipt.outcome === 'cancelled' && item.startedAt === null);

/** Why an item behind a bad end is told dropped: the item before it (`q14`), or the words of whoever took it off. */
function behind(because: string | null): string {
  if (!because) return '前の項目が止まった';
  return /^q\d+$/u.test(because) ? `前の項目 ${because} が止まった` : because;
}

/** The result of an item that ended, as the model reads it: the body's act result, or the words of why it did not run or start. */
export function itemResult(item: QueueWordsItem, receipt: MinecraftControlReceipt, fixes: readonly string[]): ToolResult {
  if (neverRan(receipt, item)) {
    const why = receipt.result ?? `捨てた: ${behind(item.because)}。手は動いていない`;
    const told = why.startsWith('捨てた') || why.startsWith('断られた') ? why : `断られた: ${why}（手は動いていない）`;
    return toolFailure('failed', told, { retryable: true });
  }
  if (receipt.failureType === 'precondition' && receipt.result) return toolFailure('failed', receipt.result, { retryable: true });
  const result = llmcResult(MC_ACT_TOOL, receipt, item.reason(), fixes);
  return item.because ? { ...result, text: `${item.because}で止めた（頭が取り除いた）。\n${result.text}` } : result;
}

/** One line of the live state for an item: the running one with its hand and time left, a waiting one with its pre. */
function itemLine(item: QueueWordsItem, index: number, frame: BodyObservation | null,
  running: { progress: MinecraftQueueProgress | null; leftMs: number }): string {
  const mine = index === 0 ? running.progress : null;
  const words = item.done ? conditionWords(item.done, frame) : null;
  const parts = [
    mine ? `手 ${mine.hand}/${mine.of}${mine.repeat > 1 ? `・繰り返し ${mine.iteration}/${mine.repeat} 回目` : ''}` : '',
    item.done ? `済む: ${conditionText(item.done)}${words ? `（今 ${words}）` : ''}` : '',
    index > 0 && item.pre ? `前提 ${conditionText(item.pre)}（前の項目の後で体が確かめる）` : '',
    index === 0 ? `残り約 ${Math.max(1, Math.round(running.leftMs / 1000))} 秒` : '',
  ].filter(Boolean);
  return `${index === 0 ? '▶' : '・'} ${itemLabel(item)} ${index === 0 ? '実行中' : '待ち'}${parts.length ? `: ${parts.join('・')}` : ''}`;
}

/** The lines of the live state: each open item, then how many more may be added; an empty queue says the body stands still. */
export function queueLines(items: readonly QueueWordsItem[], frame: BodyObservation | null,
  running: { progress: MinecraftQueueProgress | null; leftMs: number }): string[] {
  if (!items.length) return ['空（体は止まっている）'];
  const room = QUEUE_MAX - items.length;
  const last = items[items.length - 1]!.item;
  return [...items.map((item, index) => itemLine(item, index, frame, running)),
    room > 0 ? `あと ${room} つ足せる（足した項目は ${last} の後ろに付く）` : `列はいっぱい（${QUEUE_MAX}/${QUEUE_MAX}）`];
}
