import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, type MemoryAudience } from '@shannon/cognition';
import type { MindEvent, MindEventKind, MindSurface, SalienceInputs } from '@shannon/mind';
import { checkedMindInboxDraft, type MindInboxAudience, type MindInboxDraft } from '../../contracts/mindInboxContract.js';
import { closedId, perceived, perceivedId } from './perceptionCommon.js';

/**
 * The normalizer of the background inbox (`mind_inbox`, `contracts/mindInboxContract.ts`): a row another process wrote (her own
 * time's step, a withheld action, a task's end, a promise's due time), or the same draft handed in the API process. The process
 * that wrote it decided who could see or hear her (`audience`: `owner` or `others`), and the one fixed mapping below turns that
 * into the `MemoryAudience` the conversation uses for the same words (`chatAudienceTurn`: `others` is an unknown guest). Nothing
 * here has text: a row is closed symbols, ids and instants.
 */
export const INBOX_PRESENT: Readonly<Record<MindInboxAudience, MemoryAudience>> = Object.freeze({ owner: OWNER_AUDIENCE, others: UNKNOWN_GUEST_PRESENCE });

const KIND: Readonly<Record<MindInboxDraft['kind'], MindEventKind>> = Object.freeze({
  own_time_step: 'own_time_step', task_outcome: 'task_outcome', promise_due: 'promise_due', notice: 'notice',
});

const SURFACE: Readonly<Record<MindInboxDraft['source'], MindSurface>> = Object.freeze({ own_time: 'own_time', worker: 'own_time', api: 'outreach' });

function salienceOf(draft: Required<MindInboxDraft>): SalienceInputs {
  if (draft.kind === 'promise_due') return { promiseDeltaMinutes: draft.deltaMinutes ?? 0 };
  // Her own step's end, a task's end and a rule that stopped her are all outcomes of her own doing.
  return { ownTaskOutcome: true };
}

/** The closed codes of a row that the event has no field for (what a notice is about), kept beside the event by the mind. */
export function inboxDetail(draft: MindInboxDraft): { code: string; tool: string | null; reason: string | null } | null {
  try {
    const checked = checkedMindInboxDraft(draft);
    return { code: checked.code, tool: checked.tool, reason: checked.reason };
  } catch { return null; }
}

export function inboxPerception(input: { draft: MindInboxDraft; at: string; seq?: number }): MindEvent | null {
  let draft: Required<MindInboxDraft>;
  try { draft = checkedMindInboxDraft(input.draft); } catch { return null; }
  const alone = draft.audience === 'owner';
  return perceived({
    id: input.seq === undefined ? perceivedId('inbox') : `inbox:${input.seq}`, kind: KIND[draft.kind], surface: SURFACE[draft.source], time: input.at,
    audience: INBOX_PRESENT[draft.audience], presence: { ownerOnlyHears: alone, othersMayHear: !alone },
    speaker: { kind: draft.source === 'own_time' ? 'shannon' : 'system' },
    salienceInputs: salienceOf(draft),
    provenance: { source: draft.kind, sourceId: closedId(draft.sourceId), trust: 'system' },
    content: draft.ref ? { ref: draft.ref } : null,
  });
}
