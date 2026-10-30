import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import { MiniPoseChooser } from '../surfaces/mini/miniPoseChooser.js';
import { MINI_LIMITS } from '../surfaces/mini/miniPoseContract.js';
import { MiniPoseGenerator } from '../surfaces/mini/miniPoseGenerator.js';
import { MiniPoseLibrary } from '../surfaces/mini/miniPoseLibrary.js';
import { OpenAIMiniModels } from '../surfaces/mini/miniPoseModels.js';
import { createMiniPoseRoute, MINI_PATH_PREFIX } from '../surfaces/mini/miniPoseRoutes.js';
import { configuredJevChooser } from './skillRoutingWiring.js';

/**
 * The mini poses (owner 2026-10-28) for the server: the library beside the database (`SHANNON_MINI_POSE_DIR`, default
 * `<database folder>/mini-poses`), drawn and read with `OPENAI_API_KEY`, chosen by Jev with `TYPESAFE_API_KEY`
 * (without it the closest
 * picture stands in and nothing is drawn). `SHANNON_MINI_POSE_DAILY_LIMIT` (default 30) caps the drawings a day;
 * `SHANNON_MINI_POSE_TIMEOUT_MS` (default 900) is how long Jev has. Without
 * `OPENAI_API_KEY` there is no route: the residents keep the pictures they have.
 */
export function configuredMiniPoses(
  environment: Readonly<Record<string, string | undefined>>,
  options: { databasePath: string; ownerScope: string; trace: DecisionTraceWriter | null; salt?: string },
) {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return { serve: async () => false };
  const library = new MiniPoseLibrary(environment.SHANNON_MINI_POSE_DIR?.trim() || join(dirname(options.databasePath), 'mini-poses'));
  const models = new OpenAIMiniModels({ apiKey });
  const limit = Number(environment.SHANNON_MINI_POSE_DAILY_LIMIT);
  const generator = new MiniPoseGenerator({ library, models,
    dailyLimit: Number.isInteger(limit) && limit >= 0 && limit <= 500 ? limit : MINI_LIMITS.dailyDrawings });
  const timeout = Number(environment.SHANNON_MINI_POSE_TIMEOUT_MS);
  const chooser = new MiniPoseChooser({ library, models, generator,
    ...(Number.isInteger(timeout) && timeout >= 100 && timeout <= 5_000 ? { timeoutMilliseconds: timeout } : {}),
    chooser: configuredJevChooser(environment, { trace: options.trace, ...(options.salt ? { salt: options.salt } : {}) }) });
  const route = createMiniPoseRoute({ library, chooser, ownerScope: options.ownerScope });
  // Use counts are kept in memory between changes; written once a minute.
  setInterval(() => { try { library.flush(); } catch { /* the next minute tries again */ } }, 60_000).unref();
  return {
    serve: async (request: IncomingMessage, response: ServerResponse, principal: ShannonDevicePrincipal | null, url: URL): Promise<boolean> => {
      if (!url.pathname.startsWith(MINI_PATH_PREFIX)) return false;
      await route(request, response, principal, url);
      return true;
    },
  };
}
