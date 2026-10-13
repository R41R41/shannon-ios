import { switchOn } from '@shannon/switches';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import { operatorSocketPath, serveOperatorSocket } from '../infra/ops/operatorSocket.js';
import { openDatabase, tableColumns } from '../infra/sqlite/sqliteOpen.js';
import { autonomyDayKey, type AutonomyConfig } from '../mind/inhibition/autonomyBudget.js';
import type { AutonomyActivityRecord } from '../mind/inhibition/store/autonomyActivity.js';
import type { OperatorLifecycle } from './operatorLifecycleWiring.js';
import { createOperatorMinecraft, type OperatorActivity } from './operatorMinecraftWiring.js';
import type { OperatorMinecraftRequests } from './operatorMinecraftRequests.js';

/** The note kind of the operator's lines in the owner's Talk. */
export const OPERATOR_NOTE_KIND = 'operator-note';
const TICK_MS = 15_000;

export interface OperatorServerAudit { store: OperatorAuditStore; enabled: boolean; close(): void }

/**
 * The operator's audit in the API (`SHANNON_OPERATOR_MINECRAFT`, default off). Off on a database that never had it, nothing is
 * opened or created. Off after it was on, the audit stays open: the requests the operator started keep their lower cap and their
 * time limit, and nothing new is accepted (no socket is served).
 */
export function configuredOperatorAudit(values: Readonly<Record<string, string | undefined>>, path: string): OperatorServerAudit | null {
  const enabled = switchOn(values, 'SHANNON_OPERATOR_MINECRAFT');
  const db = openDatabase(path, 'operatorAudit');
  try {
    if (!enabled && tableColumns(db, 'operator_audit').size === 0) {
      db.close();
      return null;
    }
    return { store: new OperatorAuditStore(db), enabled, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface OperatorServerParts {
  audit: OperatorServerAudit | null; path: string; scopeKey: string; now(): string; ownerAlone(): boolean;
  /** The configured lifecycle (`configuredMinecraftLifecycle`) and the common runtime (`configuredServerFca`), when they exist. */
  lifecycle: { operator: OperatorLifecycle; service: { store: { unresolved(): boolean } } } | null;
  fca: { minecraft: { operator: OperatorMinecraftRequests; wake(): void } | null } | null;
  actions: ActionThreads | null;
  activity: Pick<AutonomyActivityRecord, 'append'>; config: Pick<AutonomyConfig, 'timeZone'>;
  conversation: {
    threadId(scopeKey: string): string;
    appendNoteOnce(scopeKey: string, threadId: string, id: string, content: string, at: string, kind: string, ownerAlone?: boolean): unknown;
  };
  log(line: string): void;
}

/** Writes one operator event to the activity record: the owner's side of the record, named as the operator's in the sentence. */
function recorder(parts: OperatorServerParts) {
  return (at: string, entry: OperatorActivity) => {
    parts.activity.append(parts.scopeKey, autonomyDayKey(at, parts.config), at, {
      kind: 'control', actor: 'owner', domain: 'minecraft_lifecycle', approval: 'not_needed', ...entry,
    });
  };
}

/**
 * Starts the operator's Minecraft path: the time-limit tick whenever the audit is open, and the socket only while the switch is
 * on. A socket that cannot be served is logged and leaves the API running without it.
 */
export function startOperatorMinecraft(parts: OperatorServerParts): { close(): Promise<void> } {
  const audit = parts.audit;
  if (!audit) return { close: async () => {} };
  const service = createOperatorMinecraft({
    scopeKey: parts.scopeKey, enabled: () => audit.enabled, ownerAlone: parts.ownerAlone, now: parts.now, audit: audit.store,
    lifecycle: parts.lifecycle?.operator ?? null, actions: parts.actions,
    requests: parts.fca?.minecraft ? { ...parts.fca.minecraft.operator, wake: parts.fca.minecraft.wake } : null,
    lifecycleUnresolved: () => parts.lifecycle?.service.store.unresolved() ?? false,
    activity: recorder(parts),
    note: (id, text, at) => {
      try {
        const thread = parts.conversation.threadId(parts.scopeKey);
        parts.conversation.appendNoteOnce(parts.scopeKey, thread, id, text, at, OPERATOR_NOTE_KIND, parts.ownerAlone());
      } catch { /* The audit and the activity record already hold the event; a Talk note is the owner's convenience. */ }
    },
  });
  const timer = setInterval(() => service.tick(), TICK_MS);
  timer.unref();
  const socket = audit.enabled
    ? serveOperatorSocket(operatorSocketPath(parts.path), body => service.handle(body)).then(served => {
      parts.log(`Shannon operator Minecraft: serving ${operatorSocketPath(parts.path)}`);
      return served;
    }, (error: unknown) => {
      parts.log(`Shannon operator Minecraft: socket unavailable (${error instanceof Error ? error.message : 'unknown'})`);
      return null;
    })
    : Promise.resolve(null);
  return {
    async close() {
      clearInterval(timer);
      await (await socket)?.close();
      audit.close();
    },
  };
}
