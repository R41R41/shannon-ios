import type { BodyLookOptions } from './bodyLook.js';
import { BODY_LOOK_REQUEST_BYTES, bodyLookResultId, configuredBodyLook } from './bodyLookContract.js';
import { SQLiteBodyLookSpeaker } from './bodyLookDelivery.js';
import { SQLiteBodyLookStore } from './bodyLookStore.js';
import { createConfiguredRoomLookViewer } from './bodyLookVision.js';
import type { LlmUsageEvent } from './llmUsage.js';

/**
 * What the API process gives the kernel for looking at the room: the small table, the
 * switch and limits from the environment, the conversation model as the viewer, and the
 * initiative path as the way her message reaches the apps.
 */
export function configuredBodyLookOptions(
  environment: Readonly<Record<string, string | undefined>>,
  databasePath: string,
  usageStore: { recordLlmUsage(event: LlmUsageEvent): void },
): BodyLookOptions {
  const store = new SQLiteBodyLookStore(databasePath);
  const speaker = new SQLiteBodyLookSpeaker(databasePath);
  opened.push(store, speaker);
  return { store, config: configuredBodyLook(environment), viewer: createConfiguredRoomLookViewer(environment, usageStore), speaker };
}

const opened: Array<{ close(): void }> = [];

/** Closes the look's own database handles at shutdown. */
export function closeBodyLookStores(): void {
  for (const handle of opened.splice(0)) handle.close();
}

/** The JSON body limit of a look answer, the one route that carries a frame; null for every other path. */
export function bodyLookRequestBytes(path: string): number | null {
  return bodyLookResultId(path) ? BODY_LOOK_REQUEST_BYTES : null;
}
