/** Canonical schedule metadata, supplied only by wiring's existing background-job reader. */
export interface TaskSleepTicket { jobId: string; dayKey: string; startAt: string; endAt: string }
