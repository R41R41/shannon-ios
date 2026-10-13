import type { IncomingMessage, ServerResponse } from 'node:http';
import { deviceActionsEnabled } from '../contracts/deviceActionContract.js';
import { configuredOwnerScope } from '../infra/config/ownerScope.js';
import type { ReportedWork } from '../mind/action/respond/apiTextTurn.js';
import type { ShannonToolRunner } from '../mind/tools/shannonToolRunner.js';
import { DeviceActions } from '../surfaces/device/deviceActions.js';
import { createDeviceActionRoute } from '../surfaces/device/deviceActionRoutes.js';
import { SQLiteDeviceActionStore } from '../surfaces/device/store/deviceActionStore.js';

export interface DeviceActionWiring {
  actions: DeviceActions | null;
  /** The device routes; false for any other path. */
  serve(request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string; deviceId: string } | null, url: URL): Promise<boolean>;
  /** The devices' reports (`devicePromptBlock`), for the text turn. */
  reports(): ReportedWork;
  close(): void;
}

const MAINTAIN_MILLISECONDS = 10 * 60_000;

/**
 * The device-action outbox of the API process (`docs/device-actions-contract.md`). `SHANNON_DEVICE_ACTIONS=off` at start: no
 * table is opened, no device tool exists, and the routes answer 403; a switch turned off later is read at each use.
 */
export function configuredDeviceActions(environment: Readonly<Record<string, string | undefined>>, path: string, now: () => string,
  tools: Pick<ShannonToolRunner, 'useDeviceActions'>): DeviceActionWiring {
  const ownerScopeKey = configuredOwnerScope(environment);
  const store = deviceActionsEnabled(environment) ? new SQLiteDeviceActionStore(path) : null;
  const actions = store ? new DeviceActions({ store, ownerScopeKey, now, enabled: () => deviceActionsEnabled(environment) }) : null;
  if (actions) {
    tools.useDeviceActions({
      available: scopeKey => actions.available(scopeKey),
      request: (scopeKey, kind, payload, dedupeKey) => actions.request(scopeKey, kind, payload, dedupeKey),
      wait: (scopeKey, id, milliseconds, signal) => actions.wait(scopeKey, id, milliseconds, signal),
      told: (scopeKey, id) => actions.told(scopeKey, id),
      now,
    });
  }
  const timer = actions ? setInterval(() => actions.maintain(), MAINTAIN_MILLISECONDS) : null;
  timer?.unref();
  const route = createDeviceActionRoute(actions, ownerScopeKey);
  return {
    actions,
    serve: (request, response, principal, url) => route(request, response, principal, url),
    reports: () => ({ devicePromptBlock: (scopeKey, at) => actions?.promptBlock(scopeKey, at) ?? '' }),
    close: () => {
      if (timer) clearInterval(timer);
      store?.close();
    },
  };
}
