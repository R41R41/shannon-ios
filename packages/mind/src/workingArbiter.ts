import type { WorkingEvent, WorkingNeed, WorkingProgress } from './workingEvents.js';

/**
 * The arbiter's first rules (session mb-arch, stage 1): what to do with what a body told while a command runs. One place decides a cut,
 * so that layers do not stop each other (the old Minebot died of that, handoff 2026-10-05). Rules only, no model:
 *
 * - `stalled`: the running command's own measure (distance to its target, height to go, ground covered, or what it brought in) has not
 *   got better for `stallCutMs`. Run 18: moves that timed out at 110 s and 71 s, digs that failed after 46 s and 32 s, about 460 s in all,
 *   all reported only by their receipt. Cutting at 20 s hands the decision back with the reason.
 * - `need_during_wait`: the body is only waiting (a timer, a furnace) and a thing an unmet need wants is in reach. Run 18 D15: a 53 s
 *   wait at the furnace with the iron ore 16 m away.
 *
 * Anything else is not cut: it is told to the next decision (`workingEventLines`). At most `cutsPerMinute` cuts, never the same command
 * twice, and a wait only by day and with nothing hostile near (`calm`, the surface's judgement).
 */
export const WORKING_ARBITER_V0 = Object.freeze({
  stallCutMs: 20_000,
  /** A wait with less than this left is let run: cutting it saves nothing. */
  waitCutRemainingMs: 15_000,
  needCutDistance: 24,
  cutsPerMinute: 2,
  lines: 6,
});

export interface RunningWork {
  /** The command's id, as the body's events name it. */
  subject: string;
  tool: string;
  /** The command only waits (it would not move the body or the task on by itself). */
  waiting: boolean;
  startedAt: number;
  /** For a wait: how long it still has, when known. */
  remainingMs: number | null;
}

export type ArbiterVerdict =
  | { act: 'cut'; rule: 'stalled'; subject: string; tool: string; sinceProgressMs: number; distance: number | null }
  | { act: 'cut'; rule: 'need_during_wait'; subject: string; tool: string; need: WorkingNeed }
  | { act: 'none' };

export function arbitrate(input: {
  now: number;
  running: RunningWork | null;
  progress: WorkingProgress | null;
  needs: readonly WorkingNeed[];
  calm: boolean;
  recentCuts: readonly { at: number; subject: string }[];
  options?: Partial<typeof WORKING_ARBITER_V0>;
  /** Which needs are worth ending a wait for (the surface's: a log in reach all morning is not); all when absent. */
  cutFor?(need: WorkingNeed): boolean;
}): ArbiterVerdict {
  const o = { ...WORKING_ARBITER_V0, ...input.options };
  const running = input.running;
  if (!running) return { act: 'none' };
  if (input.recentCuts.some(cut => cut.subject === running.subject)) return { act: 'none' };
  if (input.recentCuts.filter(cut => input.now - cut.at < 60_000).length >= o.cutsPerMinute) return { act: 'none' };
  const progress = input.progress?.subject === running.subject ? input.progress : null;
  if (!running.waiting && progress?.measure && progress.sinceProgressMs >= o.stallCutMs) {
    return { act: 'cut', rule: 'stalled', subject: running.subject, tool: running.tool, sinceProgressMs: progress.sinceProgressMs, distance: progress.distance };
  }
  if (running.waiting && input.calm && (running.remainingMs === null || running.remainingMs >= o.waitCutRemainingMs)) {
    const need = input.needs.find(item => item.canReach && item.distance !== null && item.distance <= o.needCutDistance && (input.cutFor?.(item) ?? true));
    if (need) return { act: 'cut', rule: 'need_during_wait', subject: running.subject, tool: running.tool, need };
  }
  return { act: 'none' };
}

const seconds = (ms: number) => Math.round(ms / 1000);
const metres = (value: number | null) => value === null ? '' : `${Math.round(value)}m`;

/** What the task is told when the arbiter cut its command: fixed words with closed facts (no text from the world). */
export function cutNote(verdict: Exclude<ArbiterVerdict, { act: 'none' }>): string {
  if (verdict.rule === 'stalled') {
    return `${verdict.tool} を切った: ${seconds(verdict.sinceProgressMs)}秒進んでいない${verdict.distance !== null ? `（残り${metres(verdict.distance)}）` : ''}。同じ手をそのまま繰り返さず、道か目標を変える`;
  }
  return `${verdict.tool} の待ちを切った: ${verdict.need.name}（${verdict.need.need}）が${metres(verdict.need.distance)}にある。取ってから、待っていた作業に戻る`;
}

/**
 * The events worth a line in the next decision, newest last, at most `limit`: every stall, and for each kind of need only its latest
 * coming or going (the nearest logs change as she walks; they would push the stalls out). Progress is not listed.
 */
export function workingEventLines(events: readonly WorkingEvent[], limit: number = WORKING_ARBITER_V0.lines): string[] {
  const latestNeed = new Map<string, number>();
  events.forEach((event, index) => { if (event.kind.startsWith('need.')) latestNeed.set(String(event.data.need), index); });
  const kept = events.filter((event, index) => event.kind === 'action.stalled' || (event.kind.startsWith('need.') && latestNeed.get(String(event.data.need)) === index));
  const stalls = kept.filter(event => event.kind === 'action.stalled').slice(-limit);
  const room = limit - stalls.length;
  const needs = room > 0 ? kept.filter(event => event.kind !== 'action.stalled').slice(-room) : [];
  const chosen = kept.filter(event => stalls.includes(event) || needs.includes(event));
  const lines = chosen.flatMap(event => {
    const d = event.data;
    const distance = typeof d.distance === 'number' ? d.distance : null;
    if (event.kind === 'need.appeared') return [`見えた: ${String(d.name)}（${String(d.need)}）${metres(distance)}${d.canReach === false ? '・届かない' : ''}`];
    if (event.kind === 'need.gone') return [`見えなくなった: ${String(d.name)}（${String(d.need)}）`];
    if (event.kind === 'action.stalled') return [`進んでいない: ${String(d.skill)} ${seconds(Number(d.sinceProgressMs) || 0)}秒${distance !== null ? `・残り${metres(distance)}` : ''}`];
    return [];
  });
  return lines.slice(-limit);
}

/** The command running now and how it goes, for the next decision; null when nothing runs. */
export function runningLine(running: RunningWork | null, progress: WorkingProgress | null, now: number): string | null {
  if (!running) return null;
  const p = progress?.subject === running.subject ? progress : null;
  return `今の道具: ${running.tool}・経過${seconds(now - running.startedAt)}秒${p?.measure ? `・最後に進んだのは${seconds(p.sinceProgressMs)}秒前` : ''}${p?.distance != null ? `・残り${metres(p.distance)}` : ''}`;
}
