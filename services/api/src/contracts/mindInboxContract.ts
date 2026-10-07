/**
 * The mind's inbox (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`): what another process (her own time, a worker)
 * hands the mind, as one row of closed fields in `mind_inbox`, which the API process tails every 2 seconds and at the start of a
 * turn. Her own time is handed one function, `EmitMindEvent`, and nothing else of the mind; it never sees the workspace.
 *
 * Closed symbols, ids and instants only: never a word of the owner's or of hers. What a row is about is named by its kind and
 * code (and, for a withheld action, the closed tool and reason of `withheldActionContract.ts`).
 */
export const MIND_INBOX_KINDS = ['own_time_step', 'task_outcome', 'promise_due', 'notice'] as const;
export type MindInboxKind = typeof MIND_INBOX_KINDS[number];

/** Who could see or hear her when it happened, as the process that writes the row knew it. */
export const MIND_INBOX_AUDIENCES = ['owner', 'others'] as const;
export type MindInboxAudience = typeof MIND_INBOX_AUDIENCES[number];

/** Which process wrote it. */
export const MIND_INBOX_SOURCES = ['own_time', 'worker', 'api'] as const;
export type MindInboxSource = typeof MIND_INBOX_SOURCES[number];

/** The codes of each kind: a step of her own time and how it ended; a task's end; a promise's due time; a notice. */
export const MIND_INBOX_CODES: Readonly<Record<MindInboxKind, readonly string[]>> = Object.freeze({
  own_time_step: Object.freeze(['done', 'failed']),
  task_outcome: Object.freeze(['done', 'failed', 'cancelled']),
  promise_due: Object.freeze(['due']),
  notice: Object.freeze(['withheld']),
});

export interface MindInboxDraft {
  kind: MindInboxKind;
  code: string;
  audience: MindInboxAudience;
  source: MindInboxSource;
  /** The id of what it is about (a step, a task, a promise, a withheld action). */
  sourceId: string;
  /** A closed symbol: the step kind or the registry tool (`owner.reach_out`), when there is one. */
  tool?: string | null;
  /** A closed reason code (a withheld reason of `withheldActionContract.ts`), when there is one. */
  reason?: string | null;
  /** Minutes from a promise's due time (negative before it), for `promise_due`. */
  deltaMinutes?: number | null;
  /** A reference the workspace may re-read through the withholding and the disclosure gate (`experience:<id>`), never text. */
  ref?: string | null;
}

export interface StoredMindInboxRow extends Required<Omit<MindInboxDraft, 'tool' | 'reason' | 'deltaMinutes' | 'ref'>> {
  seq: number;
  scopeKey: string;
  at: string;
  tool: string | null;
  reason: string | null;
  deltaMinutes: number | null;
  ref: string | null;
}

/** What her own time (and any other process) is handed: one row of closed fields. Never throws, never delays her step. */
export type EmitMindEvent = (scopeKey: string, draft: MindInboxDraft, at: string) => void;

const SYMBOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u;

/** The draft as stored, or an error when anything in it is not a closed value. */
export function checkedMindInboxDraft(draft: MindInboxDraft): Required<MindInboxDraft> {
  if (!(MIND_INBOX_KINDS as readonly string[]).includes(draft.kind)) throw new Error('MIND_INBOX_KIND');
  if (!MIND_INBOX_CODES[draft.kind].includes(draft.code)) throw new Error('MIND_INBOX_CODE');
  if (!(MIND_INBOX_AUDIENCES as readonly string[]).includes(draft.audience)) throw new Error('MIND_INBOX_AUDIENCE');
  if (!(MIND_INBOX_SOURCES as readonly string[]).includes(draft.source)) throw new Error('MIND_INBOX_SOURCE');
  if (!IDENTIFIER.test(draft.sourceId)) throw new Error('MIND_INBOX_ID');
  const symbol = (value: string | null | undefined) => {
    if (value === undefined || value === null) return null;
    if (!SYMBOL.test(value)) throw new Error('MIND_INBOX_SYMBOL');
    return value;
  };
  const ref = draft.ref ?? null;
  if (ref !== null && !IDENTIFIER.test(ref)) throw new Error('MIND_INBOX_REF');
  const delta = draft.deltaMinutes ?? null;
  if (delta !== null && !Number.isFinite(delta)) throw new Error('MIND_INBOX_DELTA');
  return {
    kind: draft.kind, code: draft.code, audience: draft.audience, source: draft.source, sourceId: draft.sourceId,
    tool: symbol(draft.tool), reason: symbol(draft.reason), deltaMinutes: delta === null ? null : Math.round(delta), ref,
  };
}
