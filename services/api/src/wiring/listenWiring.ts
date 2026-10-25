import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import { GroqTranscriber } from '../infra/models/groqTranscription.js';
import { configuredListenLimits, ListenUsage } from '../infra/models/listenUsage.js';
import type { AddressedJudge } from '../mind/perception/addressed.js';
import { createListenRoute, LISTEN_PATH } from '../surfaces/voice/listenRoute.js';
import { Listening } from '../surfaces/voice/listening.js';

/**
 * Listening (owner 2026-10-26, docs/listening-contract.md): Groq transcription and the allowance the Windows resident and the Discord
 * voice channel share. Null without `GROQ_API_KEY` (both entries answer 503 `LISTEN_NOT_CONFIGURED`); no switch of its own. The counts
 * live in `listen-usage.json` beside the database.
 */
export function configuredListening(environment: Readonly<Record<string, string | undefined>>, databasePath: string): Listening | null {
  const key = environment.GROQ_API_KEY?.trim();
  if (!key) return null;
  return new Listening(new GroqTranscriber(key), new ListenUsage(configuredListenLimits(environment), join(dirname(databasePath), 'listen-usage.json')));
}

/** `POST /v1/voice/listen` for a paired device (the resident); says whether the request was its own. */
export function configuredListenRoute(listening: Listening | null, judge: AddressedJudge | null, bodyRunning: () => boolean) {
  const route = createListenRoute({ listening, judge, bodyRunning });
  return async (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null, url: URL): Promise<boolean> => {
    if (url.pathname !== LISTEN_PATH) return false;
    await route(request, response, principal);
    return true;
  };
}
