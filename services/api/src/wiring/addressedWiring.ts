import type { IncomingMessage, ServerResponse } from 'node:http';
import { switchOn } from '@shannon/switches';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { AddressedJudge, ADDRESSED_TIMEOUT_MILLISECONDS, ADDRESSED_WINDOW_MILLISECONDS } from '../mind/perception/addressed.js';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import { ADDRESSED_PATH, createAddressedRoute } from '../surfaces/voice/serverAddressedRoute.js';
import { configuredJevChooser } from './skillRoutingWiring.js';

/**
 * 「話しかけられたか」 (`SHANNON_ADDRESSED`, owner 2026-10-21): the one judge both voice entries use (the Discord voice channel through
 * `PlatformVoiceService`, the Windows resident through `POST /v1/voice/addressed`). Null while the switch is off. Without `TYPESAFE_API_KEY`
 * the judge still exists and every question is decided by the local rules.
 *
 * `SHANNON_ADDRESSED_TIMEOUT_MS` (default 400) is how long Jev has; `SHANNON_ADDRESSED_WINDOW_SECONDS` (default 20) is the follow-up window.
 */
export function configuredAddressedJudge(
  environment: Readonly<Record<string, string | undefined>>,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string; salt?: string },
): AddressedJudge | null {
  if (!switchOn(environment, 'SHANNON_ADDRESSED')) return null;
  const timeout = Number(environment.SHANNON_ADDRESSED_TIMEOUT_MS);
  const window = Number(environment.SHANNON_ADDRESSED_WINDOW_SECONDS);
  return new AddressedJudge({
    chooser: configuredJevChooser(environment, options),
    timeoutMilliseconds: Number.isFinite(timeout) && timeout >= 100 && timeout <= 5_000 ? Math.round(timeout) : ADDRESSED_TIMEOUT_MILLISECONDS,
    windowMilliseconds: Number.isFinite(window) && window >= 5 && window <= 120 ? Math.round(window * 1_000) : ADDRESSED_WINDOW_MILLISECONDS,
  });
}

/**
 * The judge and its route for the server: `judge` goes to the Discord voice channel (`createConfiguredPlatformBridgeRoute`), `serve` answers
 * `POST /v1/voice/addressed` for a paired device (the resident) and says whether the request was its own.
 */
export function configuredAddressedVoice(
  environment: Readonly<Record<string, string | undefined>>,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string; salt?: string },
) {
  const judge = configuredAddressedJudge(environment, options);
  const route = createAddressedRoute(judge);
  return {
    judge,
    serve: async (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null, url: URL): Promise<boolean> => {
      if (url.pathname !== ADDRESSED_PATH) return false;
      await route(request, response, principal);
      return true;
    },
  };
}