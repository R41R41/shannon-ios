/**
 * Told of every proof of a task's own records read (`fcaSleepTaskEvidence.ts`: its outcome, history and evidence rows, written at every
 * step): a source's answer made from one is not kept for a moment (`fcaReadSourceAnswers.ts`), since its rows are outside the source
 * rows' mark (`provenanceMark.ts`). A module of its own, so that a process reading receipts loads nothing of the proof for it.
 */
export const taskEvidenceReads = new Set<() => void>();
