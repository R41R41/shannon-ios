import { createServer, type Server } from 'node:http';
import { configuredOwnerScope } from '../infra/config/ownerScope.js';
import { configuredAuthPepper, SQLiteDeviceAuthStore } from '../infra/auth/deviceAuth.js';
import { visionBridgeSocketPath, visionGameDeviceId, visionSwitches, visionWorkerPort } from '../infra/config/visionConfig.js';
import { sendJson } from '../infra/http/serverHttp.js';
import { MindSocketClient } from '../infra/ipc/mindSocket.js';
import { OpenAIVisionDecisions, type VisionDecisionsClient } from '../infra/models/openAIVisionDecisions.js';
import { openDatabase } from '../infra/sqlite/sqliteOpen.js';
import { localDateParts, ownerTimeZone, pad } from '../infra/time/localDate.js';
import { SQLiteVisionBudgetStore } from '../mind/vision/store/visionBudgetStore.js';
import { SQLiteVisionChoiceStore } from '../mind/vision/store/visionChoiceStore.js';
import {
  VISION_BUDGET_DEFAULTS, VisionBudget, VisionFrameHolder, VisionWatch, createVisionReflexHost, type VisionAudienceNow, type VisionBridge,
} from '../mind/vision/visionPorts.js';
import { serveVisionRoute } from '../surfaces/vision/visionRoutes.js';

/**
 * The vision worker's composition (Syzygy ADR-0011 §9, option C; stage 1): its own process (`visionWorker.ts`,
 * `deploy/azure/shannon-ios-vision.service`), its own database connection for the budget ledger and the device tokens, a loopback
 * HTTP listener for `/v1/vision/*`, and the API's bridge socket as its only way to the conversation side. The reflex loop's home
 * is created here with no source registered (stage 2 registers the Minecraft adapter).
 */
const BRIDGE_DEADLINES = Object.freeze({ audience: 400, percept: 400, notice: 12_000, escalate: 20_000, presence: 400 });

function dayKey(timeZone: string) {
  return (at: string) => {
    const parts = localDateParts(new Date(at), timeZone);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  };
}

/**
 * Two connections: the API serves each connection's requests in order, so a notice that waits for the model (seconds) must not sit
 * in front of an audience check (400 ms). `fast` carries the audience, percepts and presence; `slow` the notice and escalation.
 */
function bridgeOver(fast: MindSocketClient, slow: MindSocketClient): VisionBridge {
  return {
    audience: async scopeKey => (await fast.call<{ audience: VisionAudienceNow }>('vision.audience', { scopeKey }, BRIDGE_DEADLINES.audience)).audience,
    percept: async (scopeKey, percept) => { await fast.call('vision.percept', { scopeKey, ...percept }, BRIDGE_DEADLINES.percept); },
    notice: (scopeKey, notice) => slow.call('vision.notice', { scopeKey, ...notice }, BRIDGE_DEADLINES.notice),
    escalate: (scopeKey, look) => slow.call('vision.escalate', { scopeKey, ...look }, BRIDGE_DEADLINES.escalate),
    presence: async (scopeKey, presence) => { await fast.call('vision.presence', { scopeKey, ...presence }, BRIDGE_DEADLINES.presence); },
  };
}

export interface VisionWorker { port: number; watch: VisionWatch; close(): Promise<void> }

export async function configuredVisionWorker(values: Readonly<Record<string, string | undefined>>, databasePath: string,
  options: { now?: () => number; log?: (line: string) => void; port?: number; decisions?: VisionDecisionsClient | null } = {}): Promise<VisionWorker> {
  if (!visionSwitches(values).worker) throw new Error('VISION_WORKER_DISABLED');
  const now = options.now ?? Date.now;
  const db = openDatabase(databasePath, 'visionWorker');
  const ledger = new SQLiteVisionBudgetStore(db);
  const budget = new VisionBudget({ ledger, dayKey: dayKey(ownerTimeZone(values)), halted: () => visionSwitches(values).halted });
  const fast = new MindSocketClient(visionBridgeSocketPath(values, databasePath));
  const slow = new MindSocketClient(visionBridgeSocketPath(values, databasePath));
  const apiKey = values.OPENAI_API_KEY?.trim();
  const unknownCostUpperBoundUsd = VISION_BUDGET_DEFAULTS.decisionReserveUsd;
  const decisions = options.decisions !== undefined ? options.decisions
    : apiKey ? new OpenAIVisionDecisions({ apiKey, timeoutMilliseconds: 2_500, unknownCostUpperBoundUsd }) : null;
  const frames = new VisionFrameHolder(now);
  const ownerScope = configuredOwnerScope(values);
  const watch = new VisionWatch({ ownerScope, budget, decisions, frames, bridge: bridgeOver(fast, slow), now, choices: new SQLiteVisionChoiceStore(db),
    cameraWatch: () => visionSwitches(values).camera, escalate: () => visionSwitches(values).escalate });
  // Stage 1: the reflex loop lives here with no source registered; nothing of it runs until stage 2 adds the Minecraft adapter.
  const reflex = createVisionReflexHost([], { providers: () => ({ entry: null, image: null, text: null }), event: () => undefined, now });
  const auth = new SQLiteDeviceAuthStore({ path: databasePath, pepper: configuredAuthPepper(values) });
  const gameDeviceId = visionGameDeviceId(values);
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    serveVisionRoute(request, response, pathname, {
      watch, now, authenticate: authorization => auth.authenticate(authorization),
      allowed: principal => principal.scopeKey === ownerScope && principal.deviceId !== gameDeviceId,
    }).then(served => { if (!served) sendJson(response, 404, { error: 'NOT_FOUND' }); })
      .catch(() => { if (!response.headersSent) sendJson(response, 500, { error: 'VISION_FAILED' }); else response.destroy(); });
  });
  const port = options.port ?? visionWorkerPort(values);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const sweep = setInterval(() => frames.sweep(), 1_000);
  sweep.unref();
  options.log?.(`Shannon vision worker ready port=${(server.address() as { port: number }).port} camera=${visionSwitches(values).camera ? 'on' : 'off'}`);
  return {
    port: (server.address() as { port: number }).port, watch,
    close: async () => {
      clearInterval(sweep);
      frames.clear();
      await reflex?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fast.close();
      slow.close();
      auth.close?.();
      if (db.isOpen) db.close();
    },
  };
}
