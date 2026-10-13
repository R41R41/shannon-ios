import { visibleMemoryText, type CompanionStateSnapshot } from '@shannon/cognition';
import type { MindInboxDraft } from '../../contracts/mindInboxContract.js';

/**
 * What produces the notices of a promise's time and of a task's end (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`):
 * `【知らせ:約束の時刻】` from the promises she keeps with a due time, and `【知らせ:作業終了】` from the owner's agent tasks that ended
 * and from her own time's folder operations whose report arrived after her step stopped waiting. Pure: the wiring hands the state,
 * the rows and the time, and writes the drafts into `mind_inbox` once each (by kind and source id).
 *
 * A draft holds closed values only: the kind, a code, a closed id, a closed tool symbol, a number of minutes. Never a promise's
 * words or a task's title. Every one is the owner's (`audience: 'owner'`), so the workspace renders it only while the owner alone
 * can see or hear the reply (the audience rules apply at render).
 */
export const NOTICE_PRODUCER_LIMITS = Object.freeze({
  /** A promise is perceived from 30 minutes before its time until 30 minutes after it (the notice lasts 60 minutes). */
  promiseBeforeMinutes: 30,
  promiseAfterMinutes: 30,
  /** A task's end is perceived within an hour of it. */
  outcomeWithinMinutes: 60,
});

export interface ProducedNotice {
  draft: MindInboxDraft;
  /** The instant the row is written at: a promise's due time, a task's end. */
  at: string;
}

const MINUTE = 60_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$/u;
const SYMBOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;
const iso = (time: number) => new Date(time).toISOString();

/** A closed source id from an id and an instant (`<id>@<minutes>`), or null when the id is not one. */
function sourceId(prefix: string, id: string, time: number): string | null {
  const value = `${prefix}${id}@${Math.floor(time / MINUTE)}`;
  return ID.test(value) ? value : null;
}

/**
 * The promises whose time is near: pending, with a due time, visible (not forgotten, not from a forgotten turn), not put off past
 * now by 「あとで」 (`remindAfter`), within 30 minutes before or after `at`. The source id names the promise and its time, so a moved time is a new notice.
 */
export function promiseDueNotices(state: CompanionStateSnapshot, at: string): readonly ProducedNotice[] {
  const now = Date.parse(at);
  return state.prospectiveMemories.flatMap(memory => {
    if (memory.status !== 'pending' || !memory.dueAt) return [];
    const due = Date.parse(memory.dueAt);
    if (!Number.isFinite(due) || now < due - NOTICE_PRODUCER_LIMITS.promiseBeforeMinutes * MINUTE || now > due + NOTICE_PRODUCER_LIMITS.promiseAfterMinutes * MINUTE) return [];
    // 「あとで」: no reminder before that instant.
    if (memory.remindAfter && Date.parse(memory.remindAfter) > now) return [];
    if (!visibleMemoryText(state, memory.id, memory.summary)) return [];
    if (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary)) return [];
    const id = sourceId('promise-', memory.id, due);
    if (!id) return [];
    return [{ at: iso(due), draft: { kind: 'promise_due', code: 'due', audience: 'owner', source: 'api', sourceId: id, deltaMinutes: Math.round((now - due) / MINUTE) } }];
  });
}

export interface EndedTask { id: string; status: string; updatedAt: string }

const TASK_CODE: Readonly<Record<string, 'done' | 'failed' | 'cancelled'>> = Object.freeze({ completed: 'done', failed: 'failed', cancelled: 'cancelled' });

/** The owner's agent tasks that ended within the last hour (`agent.task`, done, failed or cancelled). */
export function agentTaskOutcomeNotices(tasks: readonly EndedTask[], at: string): readonly ProducedNotice[] {
  const now = Date.parse(at);
  return tasks.flatMap(task => {
    const code = TASK_CODE[task.status];
    const ended = Date.parse(task.updatedAt);
    if (!code || !Number.isFinite(ended) || ended > now || now - ended > NOTICE_PRODUCER_LIMITS.outcomeWithinMinutes * MINUTE) return [];
    const id = sourceId('task-', task.id, ended);
    return id ? [{ at: iso(ended), draft: { kind: 'task_outcome', code, audience: 'owner', source: 'api', sourceId: id, tool: 'agent.task' } }] : [];
  });
}

export interface LateFolderReport { id: string; tool: string; status: string; finishedAt: string }

/**
 * Her own time's folder operations whose report arrived after her step stopped waiting (or that ran out), within the last hour:
 * the step's tool (`folder.write`, …) and done or failed. A report in time is her step's own result and is told by the step.
 */
export function lateFolderOutcomeNotices(reports: readonly LateFolderReport[], at: string): readonly ProducedNotice[] {
  const now = Date.parse(at);
  return reports.flatMap(report => {
    const ended = Date.parse(report.finishedAt);
    if (!Number.isFinite(ended) || ended > now || now - ended > NOTICE_PRODUCER_LIMITS.outcomeWithinMinutes * MINUTE) return [];
    if (!['done', 'failed', 'refused', 'expired'].includes(report.status)) return [];
    const id = sourceId('folder-', report.id, ended);
    const tool = SYMBOL.test(report.tool) ? report.tool : 'folder';
    return id ? [{ at: iso(ended), draft: { kind: 'task_outcome', code: report.status === 'done' ? 'done' : 'failed', audience: 'owner', source: 'api', sourceId: id, tool } }] : [];
  });
}

export interface LifecycleReport {
  id: string; action: string; outcome: string; observedAt: string;
  /** Set when the accepted operation never started: busy, unavailable, not_allowed or error. */
  notStarted?: string;
}

/**
 * The Minecraft lifecycle operations the owner asked for in a conversation and she answered with 「受け付けた」 (2026-10-13
 * TI-REQ): their native receipt within the last hour, as `minecraft.<action>` done, failed or cancelled.
 */
export function lifecycleOutcomeNotices(reports: readonly LifecycleReport[], at: string): readonly ProducedNotice[] {
  const now = Date.parse(at);
  return reports.flatMap(report => {
    const ended = Date.parse(report.observedAt);
    if (!Number.isFinite(ended) || ended > now || now - ended > NOTICE_PRODUCER_LIMITS.outcomeWithinMinutes * MINUTE) return [];
    if (!['start', 'stop', 'login', 'logout'].includes(report.action)) return [];
    const code = report.outcome === 'completed' ? 'done' : report.outcome === 'cancelled' ? 'cancelled' : 'failed';
    const id = sourceId('minecraft-', report.id, ended);
    if (!id) return [];
    const reason = report.notStarted ? { reason: `lifecycle_not_started.${report.notStarted}` } : {};
    const tool = `minecraft.${report.action}`;
    const draft = { kind: 'task_outcome' as const, code, audience: 'owner' as const, source: 'api' as const, sourceId: id, tool, ...reason };
    return [{ at: iso(ended), draft }];
  });
}
