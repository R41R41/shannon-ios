import { sameWork } from './minecraftLlmcQueueState.js';
import type { QueueItem, QueueAdd, QueueDeps } from './minecraftLlmcQueueState.js';
import { createHash } from 'node:crypto';
import { feetOf } from './minecraftLlmc.js';
import { QUEUE_MAX, SAME_IN_QUEUE_WORDS } from './minecraftLlmcQueueWords.js';

export function createQueueAdmission(deps: QueueDeps, shared: { items: QueueItem[]; open(): QueueItem[]; now(): number }) {
  const { items, open, now } = shared;

  /** Why a new item is not put in the queue, or null. */
  function refusal(spec: QueueAdd): string | null {
    if (deps.holdPending?.()) return '送らなかった: 保留の作成・確定中。現場を保全して再開を待つ';
    const blocked = deps.control.motorBlocked(deps.taskId);
    if (blocked) {
      const mine = items.find((entry) => entry.id === blocked.id);
      return (
        `送らなかった: ${mine ? mine.item : 'さっきの項目'} の結果が不明で、体を止めたことをまだ確かめていない` +
        `（${blocked.hold === 'held' ? '保留中' : '片付け中'}）。体を動かす項目は、解放を確かめるまで送れない。見るだけの操作は送れる`
      );
    }
    const waiting = open();
    if (waiting.length >= QUEUE_MAX) {
      return `送らなかった: 列がいっぱい（実行中を含めて ${QUEUE_MAX} つ）。差し替えるなら replace に ${waiting.at(-1)!.item} などを書く`;
    }
    const same = waiting.find((item) => sameWork(item.input, spec.input));
    if (same) return `送らなかった: ${same.item} ${SAME_IN_QUEUE_WORDS}（${waiting[0] === same ? '実行中' : '待ち'}）。列は live の queue`;
    // Continue contract 2: a mark of another step's queue cannot be relied on (the marks belong to one queue); said
    // now, not as a drop when it should start.
    const unknown = (spec.input.dependsOn ?? []).filter((ref) => !items.some((entry) => entry.item === ref));
    if (unknown.length) {
      const usable = (waiting.length ? waiting : items.slice(-3)).map((entry) => entry.item);
      return `送らなかった: dependsOn の ${unknown.join('・')} は前の段の列（今の列で頼れるのは ${usable.length ? usable.join('・') : 'まだ無い'}）`;
    }
    return null;
  }

  function makeItem(spec: QueueAdd, label: string, maxMs: number, startInMs: number): QueueItem {
    const at = now();
    const item: QueueItem = {
      item: label,
      id: `skill:${createHash('sha256').update(spec.operationId).digest('hex')}`,
      operationId: spec.operationId,
      call: spec.call,
      node: spec.node,
      current: spec.current ?? null,
      why: spec.why,
      input: spec.input,
      pre: spec.pre,
      done: spec.input.done,
      maxMs,
      startBy: at + startInMs,
      from: feetOf(deps.observe()),
      enqueuedAt: at,
      startedAt: null,
      ended: false,
      abort: new AbortController(),
      watch: null,
      fixes: spec.fixes,
      because: null,
      handKey: null,
      handSince: at,
      reason: () => item.watch?.reason() ?? null,
      state: 'sent',
      unit: null,
      dependsOn: spec.input.dependsOn ? [...spec.input.dependsOn] : undefined,
      uses: [],
      resume: spec.resumeOf,
    };
    return item;
  }
  return { refusal, makeItem };
}
