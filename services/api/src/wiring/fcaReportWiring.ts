import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { createReportCards } from '../mind/action/fca/fcaReportCards.js';
import { reportGates } from '../mind/action/fca/fcaReportGate.js';
import type { TaskProgress } from '../mind/action/taskRuntime/taskProgressPorts.js';
import type { TaskRuntime } from '../mind/action/taskRuntime/taskRuntimePorts.js';

/**
 * Which report reaches him and where (`fcaReportGate.ts`), as the server composes it: the call's report (the 「いま」 route) is
 * `seen` with the gate's drops; the Talk's report card asks the card's gate first, on the stored progress, and walks the sources
 * (`seen`) only for a report the gate delivers (2026-10-13). `seen` is the owner's view of a task's progress: the visibility guard,
 * asking for the spoken form of a report it shows.
 */
export function fcaReportWiring(parts: {
  runtime: TaskRuntime; ownerScope: string; timeZone: string; conversations?: ConversationStore | undefined;
  seen(taskId: string): TaskProgress | null; ownerAlone(): boolean; now?(): number; log?(line: string): void;
  /** Whether the operator handed a task over for him (`operatorHandedOver`). */
  handedOver?(taskId: string): boolean;
}) {
  const now = parts.now ?? Date.now;
  const gates = reportGates({ runtime: parts.runtime, ownerScope: parts.ownerScope, timeZone: parts.timeZone, now, conversations: parts.conversations },
    parts.seen);
  const conversations = parts.conversations;
  const cards = conversations?.appendReportCardOnce ? createReportCards({ runtime: parts.runtime, ownerScope: parts.ownerScope, conversations,
    shown: parts.seen, gate: gates.cardGate, ownerAlone: parts.ownerAlone, now, ...(parts.handedOver ? { handedOver: parts.handedOver } : {}),
    ...(parts.log ? { log: parts.log } : {}) }) : null;
  return { call: gates.call, cards };
}
