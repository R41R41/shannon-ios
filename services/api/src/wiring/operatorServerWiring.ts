import { dirname } from 'node:path';
import { switchOn } from '@shannon/switches';
import type { ActionThreads } from '../contracts/actionThreadContract.js';
import { OperatorAuditStore } from '../infra/ops/store/operatorAuditStore.js';
import { ensureOperatorDirectory, operatorSocketPath, serveOperatorSocket } from '../infra/ops/operatorSocket.js';
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

/**
 * Whether the operator handed a task over for him, as the audit says (an accepted `request` row naming it), never as its title
 * reads. Without an audit, or when it cannot be read, no task is: its report is then worded as any other owner request's.
 */
export function operatorHandedOver(audit: OperatorServerAudit | null, scopeKey: string): (taskId: string) => boolean {
  return taskId => {
    try {
      return audit?.store.requestOf(scopeKey, taskId) != null;
    } catch {
      return false;
    }
  };
}

/** What the API's composition hands in (`server.ts`, through `configuredServerFca`). */
export interface OperatorHostParts {
  /** The configured lifecycle (`configuredMinecraftLifecycle`), when there is one. */
  lifecycle: { operator: OperatorLifecycle; service: { store: { unresolved(): boolean } } } | null;
  actions: ActionThreads | null;
  activity: Pick<AutonomyActivityRecord, 'append'>; config: Pick<AutonomyConfig, 'timeZone'>;
  conversation: {
    threadId(scopeKey: string): string;
    appendNoteOnce(scopeKey: string, threadId: string, id: string, content: string, at: string, kind: string, ownerAlone?: boolean): unknown;
  };
}

export interface OperatorServerParts extends OperatorHostParts {
  audit: OperatorServerAudit | null; path: string; scopeKey: string; now(): string; ownerAlone(): boolean;
  /** The common runtime's side of a request (`fcaMinecraftRequests(...).operator` and the runtime's wake), when Minecraft is on. */
  requests: (OperatorMinecraftRequests & { wake(): void }) | null;
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

const failure = (error: unknown) => (error instanceof Error ? error.message : 'unknown');

/**
 * Starts the operator's Minecraft path: the socket's directory always (the other units hide it), the time-limit tick whenever the
 * audit is open, and the socket only while the switch is on. A socket that cannot be served is logged and leaves the API running.
 */
export function startOperatorMinecraft(parts: OperatorServerParts): { close(): Promise<void> } {
  const socketPath = operatorSocketPath(parts.path);
  const directory = ensureOperatorDirectory(dirname(socketPath))
    .catch((error: unknown) => parts.log(`Shannon operator Minecraft: directory unavailable (${failure(error)})`));
  const audit = parts.audit;
  if (!audit) return { close: async () => { await directory; } };
  const service = createOperatorMinecraft({
    scopeKey: parts.scopeKey, enabled: () => audit.enabled, ownerAlone: parts.ownerAlone, now: parts.now, audit: audit.store,
    lifecycle: parts.lifecycle?.operator ?? null, requests: parts.requests, actions: parts.actions,
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
    ? directory.then(() => serveOperatorSocket(socketPath, body => service.handle(body), reason => service.socketRefused(reason))).then(served => {
      parts.log(`Shannon operator Minecraft: serving ${socketPath}`);
      return served;
    }, (error: unknown) => {
      parts.log(`Shannon operator Minecraft: socket unavailable (${failure(error)})`);
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
