import type { RecordEvent } from './decisionRecordRead.js';

/**
 * The stages of time and the prefetch's error (continue contract 8, 「時間の段」), computed from a run's rows.
 * **Pure**: the same function
 * the judge of the end-to-end checks
 * (`tools/continue-verify/judge.ts`) uses, and `scripts/decision-record.ts stages` shows. A row is a line of `events.jsonl`; the
 * body's times come with the `received` rows
 * (`bodyTimes`), or from the receipts the bench collected (`StageOptions.bodyTimesOf`).
 */

/** The seven stages between a command's failure and the first effective operation of the command the head sent next. */
export const STAGE_NAMES = ['1_failed_to_notice', '2_notice_to_decision', '3_decision', '4_reply_to_send', '5_send_to_accept',
   '6_accept_to_lock', '7_lock_to_first_motor'] as const;
export type StageName = (typeof STAGE_NAMES)[number];
export interface StageChain {
  failed: string; decision?: string; next?: string; linked: boolean; why?: string;
  stagesMs?: Record<StageName, number>; totalMs?: number; overlapMs?: number;
}
export interface StageOptions {
  /** The run the rows are of (a row with no `ids.run` is this run's). */
  run?: string;
  /** Only the chain of this failed command. */
  only?: string;
  /** Where else the body's times of a command can be had (the receipts the bench collected); tried before the `received` rows. */
  bodyTimesOf?(command: string): { acceptedAt?: string; startedAt?: string; lockAt?: string; firstMotorAt?: string } | undefined;
}
type Row = RecordEvent;
interface Ids { run?: string; decision?: string; command?: string; life?: number; reads?: string[] }

/** `q12` and `skill:q12` are one command (the bench's marks and the head's ids). */
export const commandKey = (id: string): string => (/^q\d+[a-z]*$/u.test(id) ? `skill:${id}` : id);
const time = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

/** The numbers of a row: the new `ids` over the old fields of the decision record's earlier rows (`id`,
 * `decisionId`, `commandId`, `context.life`). */
export function rowIds(row: Row, run?: string): Ids {
  const legacy: Ids = run ? { run } : {};
  if (['request', 'response', 'applied', 'discarded', 'failed'].includes(row.ev) && typeof row.id === 'string') legacy.decision = row.id;
  if (row.ev === 'sent') {
    if (typeof row.decisionId === 'string') legacy.decision = row.decisionId;
    if (typeof row.commandId === 'string') legacy.command = row.commandId;
    if (typeof row.context?.life === 'number') legacy.life = row.context.life;
  }
  const merged: Ids = { ...legacy, ...(row.ids ?? {}) };
  if (merged.command) merged.command = commandKey(merged.command);
  return merged;
}
/** The commands a request read, in the order its input held them. */
export const readsOf = (row: Row): string[] => ((row.reads ?? row.ids?.reads ?? []) as string[]).map(commandKey);

interface DecisionRows { request?: Row; response?: Row; sent: Row[] }

/**
 * For each command that failed (a `received` row with the body's `failedAt`): the decision that read it (its
 * `reads`, in the same run and life), that decision's answer, the
 * command it sent, and the times of that command; the stages between them. The join is run + life + decision,
 * never `command` alone. A stage that runs backwards (a
 * prefetch sent before the failure ended) is 0 and its overlap is told; the total counts every moment of the wall clock once.
 */
export function stageTimes(rows: readonly Row[], options: StageOptions = {}): StageChain[] {
  const received = new Map<string, Row[]>(), decisions = new Map<string, DecisionRows>(), order: string[] = [];
  const indexStageRows = () => {
  for (const row of rows) {
    const ids = rowIds(row, options.run);
    let decision: DecisionRows | undefined;
    if (ids.decision) {
      decision = decisions.get(ids.decision);
      if (!decision) { decision = { sent: [] };
        decisions.set(ids.decision, decision); }
    }
    if (row.ev === 'request' && decision) decision.request = row;
    else if (row.ev === 'response' && decision) decision.response = row;
    else if (row.ev === 'sent' && decision && row.skill !== 'events') decision.sent.push(row);
    else if (row.ev === 'received' && ids.command) {
      if (!received.has(ids.command)) { received.set(ids.command, []);
        order.push(ids.command); }
      received.get(ids.command)!.push(row);
    }
  }
  };
  indexStageRows();
  const timesOf = (command: string) => options.bodyTimesOf?.(command) ?? [...(received.get(command) ?? [])].reverse().map(row => row.bodyTimes).find(Boolean);
  const chains: StageChain[] = [];
  for (const failed of order) {
    if (options.only !== undefined && commandKey(options.only) !== failed) continue;
    const notices = received.get(failed)!;
    if (!notices.some(row => row.bodyTimes?.failedAt)) continue;
    const notice = notices.find(row => row.bodyTimes?.failedAt)!, base: StageChain = { failed, linked: false };
    const failedAt = time(notice.bodyTimes?.failedAt), noticeAt = time(notice.at);
    if (failedAt === undefined || noticeAt === undefined) { chains.push({ ...base, why: 'no received row with failedAt' });
      continue; }
    const life = rowIds(notice, options.run).life;
    const read = [...decisions.entries()].find(([, view]) => view.request && readsOf(view.request).includes(failed) && rowIds(view.request,
       options.run).life === life);
    const request = read?.[1].request;
    if (!read || !request) { chains.push({ ...base, why: 'no decision read it (same run and life)' });
      continue; }
    const [decision, view] = read, sent = view.sent[0], reply = time(view.response?.at);
    if (!sent || reply === undefined) { chains.push({ ...base, decision, why: 'the decision sent no command or has no reply' });
      continue; }
    const next = rowIds(sent, options.run).command, times = next ? timesOf(next) : undefined;
    const nextCommandTimes = () => [failedAt, noticeAt, time(request.at), reply, time(sent.at), time(times?.acceptedAt), time(
      times?.startedAt ?? times?.acceptedAt), time(times?.lockAt), time(times?.firstMotorAt)];
    const points = nextCommandTimes();
    if (!next || points.some(point => point === undefined)) {
      chains.push({ ...base, decision, ...(next ? { next } : {}), why: 'the next command lacks a time (acceptedAt/lockAt/firstMotorAt)' });
      continue;
    }
    const at = points as number[];
    const edges: [number, number][] = [[at[0]!, at[1]!], [at[1]!, at[2]!], [at[2]!, at[3]!], [at[3]!, at[4]!], [at[4]!, at[5]!], [at[6]!,
       at[7]!], [at[7]!, at[8]!]];
    const elapsedStageTimes = () => {
    const stagesMs = {} as Record<StageName, number>;
    let overlapMs = 0;
    edges.forEach(([from, to], index) => { stagesMs[STAGE_NAMES[index]!] = Math.max(0, to - from);
      if (to < from) overlapMs += from - to; });
    // The wall clock once: the union of the intervals.
    const spans = edges.filter(([from, to]) => to > from).sort((left, right) => left[0] - right[0]);
    let totalMs = 0, end = -Infinity;
    for (const [from, to] of spans) { totalMs += to - Math.max(from, end);
      end = Math.max(end, to); }
      return { stagesMs, totalMs, overlapMs };
    };
    const { stagesMs, totalMs, overlapMs } = elapsedStageTimes();
    chains.push({ ...base, decision, next, linked: true, stagesMs, totalMs, overlapMs });
  }
  return chains;
}

/** How wrong the queue's guess of an item's remaining time was when it woke the model for it (`woke`
 * `remaining`): the item's real end minus the end it predicted. */
export interface PrefetchError { command: string; wokeAt: string; predictedRemainingMs: number; endedAt: string; errorMs: number }
export function prefetchErrors(rows: readonly Row[], options: Pick<StageOptions, 'run'> = {}): PrefetchError[] {
  const ended = new Map<string, string>();
  for (const row of rows) {
    const command = row.ev === 'received' ? rowIds(row, options.run).command : undefined, endedAt = row.bodyTimes?.endedAt;
    if (command && typeof endedAt === 'string' && !ended.has(command)) ended.set(command, endedAt);
  }
  const errors: PrefetchError[] = [];
  for (const row of rows) {
    if (row.ev !== 'woke' || row.why !== 'remaining' || typeof row.predictedRemainingMs !== 'number') continue;
    const command = rowIds(row, options.run).command, endedAt = command ? ended.get(command) : undefined, wokeAt = time(row.at), end = time(endedAt);
    if (!command || endedAt === undefined || wokeAt === undefined || end === undefined) continue;
    errors.push({ command, wokeAt: String(row.at), predictedRemainingMs: row.predictedRemainingMs, endedAt, errorMs: end - (wokeAt +
       row.predictedRemainingMs) });
  }
  return errors;
}
