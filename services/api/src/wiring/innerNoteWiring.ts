import type { IncomingMessage, ServerResponse } from 'node:http';
import { OWNER_AUDIENCE, type CompanionStateSnapshot } from '@shannon/cognition';
import { INNER_NOTE_PATH, INNER_NOTE_SERVICE_LIMITS } from '../contracts/innerNoteContract.js';
import { createInnerNoteRoute } from '../infra/http/serverInnerNoteRoute.js';
import type { LlmUsageEvent } from '../infra/models/llmUsage.js';
import { innerNoteEnabled, type InnerNotePort } from '../mind/emotion/innerNotePorts.js';
import { configuredInnerNoteReflector } from '../mind/emotion/innerNoteReflection.js';
import { InnerNoteService } from '../mind/emotion/innerNoteService.js';
import { SQLiteInnerNoteStore } from '../mind/emotion/store/innerNoteStore.js';
import type { ConversationStore } from '../mind/memory/memoryPorts.js';
import { visibleReplayMessages } from '../mind/memory/memoryVisibility.js';
import { configuredDatabasePath } from '../infra/sqlite/sqliteStore.js';
import { configuredOwnerScope } from '../infra/config/ownerScope.js';

export interface ConfiguredInnerNote {
  port: InnerNotePort;
  service: InnerNoteService;
  /** The HTTP server's one dispatch for `/v1/shannon/inner-notes`; false for any other path. */
  serve(request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string; deviceId: string } | null, url: URL): boolean;
  close(): Promise<void>;
}

/**
 * Her inner note (Syzygy ADR-0012 stage 1), composed for the API process: its table (schema step `emotion/001_inner_notes`), the
 * reflection on the conversation's small model (Haiku; without a key nothing is written), the service's sweep, and the owner's read.
 * `SHANNON_INNER_NOTE` off (the default): null, nothing is opened, no table is created, and every path is what it was.
 */
export function configuredInnerNote(environment: Readonly<Record<string, string | undefined>>, store: InnerNoteHost, timeZone: string,
  now: () => string, options: { databasePath?: string; ownerScope?: string; log?(line: string): void } = {}): ConfiguredInnerNote | null {
  return innerNoteEnabled(environment) ? composedInnerNote(environment, {
    databasePath: options.databasePath ?? configuredDatabasePath(environment), ownerScope: options.ownerScope ?? configuredOwnerScope(environment),
    timeZone, now, usageStore: store, state: store, conversation: store, log: options.log ?? (line => console.log(line)),
  }) : null;
}

/** The server's one store is all three: usage, state and conversation. */
type InnerNoteHost = { recordLlmUsage(event: LlmUsageEvent): void } & { snapshot(scopeKey: string): CompanionStateSnapshot }
  & Pick<ConversationStore, 'listThreads' | 'conversationHistory' | 'recentMessages' | 'experiencesById' | 'experienceCandidates' | 'history'>;

interface InnerNoteParts {
  databasePath: string; ownerScope: string; timeZone: string; now(): string;
  usageStore?: { recordLlmUsage(event: LlmUsageEvent): void };
  state: { snapshot(scopeKey: string): CompanionStateSnapshot };
  conversation: Pick<ConversationStore, 'listThreads' | 'conversationHistory' | 'recentMessages' | 'experiencesById' | 'experienceCandidates' | 'history'>;
  log?(line: string): void;
}

/** The composition itself (tests hand their own parts). */
export function composedInnerNote(environment: Readonly<Record<string, string | undefined>>, parts: InnerNoteParts): ConfiguredInnerNote {
  const store = new SQLiteInnerNoteStore(parts.databasePath);
  const service = new InnerNoteService({
    store, reflector: configuredInnerNoteReflector(environment, parts.usageStore), state: parts.state, ownerScope: parts.ownerScope,
    timeZone: parts.timeZone, now: parts.now, ...(parts.log ? { log: parts.log } : {}),
    recent: (scopeKey, at) => recentLines(parts, scopeKey, at),
    sleptAfter: (scopeKey, since, dayKey) => store.sleepCompletedAfter(scopeKey, since, dayKey),
  });
  const stop = service.start();
  const route = createInnerNoteRoute({ store, ownerScopeKey: parts.ownerScope, now: parts.now });
  return {
    port: service, service,
    serve(request, response, principal, url) {
      if (url.pathname !== INNER_NOTE_PATH) return false;
      route(request, response, principal);
      return true;
    },
    async close() {
      stop();
      await service.idle();
      store.close();
    },
  };
}

/** The last lines of the conversation in progress with the owner alone, through the replay's own forgetting filter. */
function recentLines(parts: InnerNoteParts, scopeKey: string, at: string) {
  const thread = parts.conversation.listThreads(scopeKey)[0];
  if (!thread || Date.parse(at) - Date.parse(thread.updatedAt) > INNER_NOTE_SERVICE_LIMITS.recentFreshMilliseconds) return [];
  return visibleReplayMessages(parts.state.snapshot(scopeKey), parts.conversation as ConversationStore, scopeKey, thread.threadId, OWNER_AUDIENCE,
    INNER_NOTE_SERVICE_LIMITS.recentLines).messages.map(entry => entry.item);
}
