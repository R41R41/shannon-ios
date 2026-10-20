/**
 * The work agenda of a task (session mb-arch, owner 2026-10-20): what a body did between the planner's decisions that the planner did
 * not ask for one by one. The planner (the FCA model) asks for work; an executor beside it adds the small things the moment wants:
 * work while a furnace or a timer runs (`filler`), a detour for a thing that just came into reach (`interrupt`), the asked work taken
 * up again after it (`resume`), and the cuts of the arbiter (`cut`). Every decision is told what of it happened since the one before
 * (`agendaLines`), in fixed words: the planner follows what it is shown, so it is shown what was done, never a suggestion to repeat.
 *
 * Like the rest of this package it holds no timer and no store: the service keeps one per task and hands the time in.
 */
export const WORK_AGENDA_V1 = 'work.agenda.v1';
export const WORK_AGENDA_SOURCES = Object.freeze(['planner', 'filler', 'interrupt', 'resume', 'cut'] as const);
export type WorkAgendaSource = typeof WORK_AGENDA_SOURCES[number];
export const WORK_AGENDA_LIMITS = Object.freeze({ kept: 64, lines: 6, note: 160 });

export interface WorkAgendaEntry {
  /** Counts from 1 for the task: a reader keeps the last one it read. */
  seq: number;
  source: WorkAgendaSource;
  tool: string;
  /** Why the executor did it, in the surface's fixed words (never text from the world). */
  why: string;
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
  /** The outcome in a few words, cut to `note` characters. */
  note: string | null;
}

const cut = (text: string) => text.length > WORK_AGENDA_LIMITS.note ? `${text.slice(0, WORK_AGENDA_LIMITS.note - 1)}…` : text;

export class WorkAgenda {
  private entries: WorkAgendaEntry[] = [];
  private seq = 0;

  /** An item begins; its number, for `end`. */
  begin(source: WorkAgendaSource, tool: string, why: string, now: number): number {
    this.seq += 1;
    this.entries.push({ seq: this.seq, source, tool, why: cut(why), startedAt: now, endedAt: null, ok: null, note: null });
    if (this.entries.length > WORK_AGENDA_LIMITS.kept) this.entries.shift();
    return this.seq;
  }

  end(seq: number, ok: boolean, note: string, now: number): void {
    const entry = this.entries.find(item => item.seq === seq);
    if (!entry || entry.endedAt !== null) return;
    entry.endedAt = now;
    entry.ok = ok;
    entry.note = cut(note);
  }

  /** The entries after `cursor`, oldest first, and the new cursor. */
  since(cursor: number): { entries: readonly WorkAgendaEntry[]; cursor: number } {
    return { entries: this.entries.filter(entry => entry.seq > cursor).map(entry => ({ ...entry })), cursor: this.seq };
  }

  cursor(): number { return this.seq; }

  /** The item running now, if any. */
  running(): WorkAgendaEntry | null {
    const open = [...this.entries].reverse().find(entry => entry.endedAt === null);
    return open ? { ...open } : null;
  }
}

const LABEL: Readonly<Record<WorkAgendaSource, string>> = {
  planner: '頼まれた手', filler: '待つ間に', interrupt: '割り込み', resume: '再開', cut: '切った',
};

/** What happened since the last decision, a line each, newest last, at most `limit`: what, why, and how it ended. */
export function agendaLines(entries: readonly WorkAgendaEntry[], limit: number = WORK_AGENDA_LIMITS.lines): string[] {
  return entries.filter(entry => entry.source !== 'planner').slice(-limit).map(entry => {
    const end = entry.endedAt === null ? '（実行中）' : entry.ok ? `→ ${entry.note ?? '済'}` : `→ できなかった: ${entry.note ?? ''}`;
    return `${LABEL[entry.source]}: ${entry.tool}（${entry.why}）${end}`;
  });
}
