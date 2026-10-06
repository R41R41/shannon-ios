import type { IncomingMessage, ServerResponse } from 'node:http';
import { SHANNON_AUTONOMY_SYSTEM_DOMAIN } from '@shannon/cognition';
import type { CalibrationReport } from '@shannon/learning';
import type { AutonomyActivityRecord } from '../../autonomyActivity.js';
import { autonomyDayKey, type AutonomyConfig } from '../../autonomyBudget.js';
import type { ValueVersions, ValuesOwnerError } from '../../mind/learning/valueTable.js';
import { readJson, sendJson } from '../../serverHttp.js';

/**
 * The owner's view and controls of her value table (Syzygy ADR-0008 stage 1 §7; `docs/cognition-ledger-contract.md`).
 * Core: approval and budget (the owner's controls), response path.
 *
 * - `GET /v1/autonomy/values`: the versions, the active version's cells, whether it is frozen, the calibration of her
 *   predictions, and her choices by status. Numbers and closed symbols only.
 * - `POST /v1/autonomy/values/rollback` (`{ "versionId"?: string }`): back to an earlier version, frozen until resumed.
 * - `POST /v1/autonomy/values/resume`: a version from all the evidence again.
 *
 * Only a paired device of the owner's scope. Each control is written to the activity record as an owner action. The app's
 * button comes in stage 5; the same controls are on the server's command line (`scripts/shannon-values.sh`).
 */
export const VALUES_PATH = '/v1/autonomy/values';

export function isValuesPath(path: string): boolean {
  return path === VALUES_PATH || path.startsWith(`${VALUES_PATH}/`);
}

export interface ValuesRouteDependencies {
  /** Null while the choice ledger is switched off. */
  values: Pick<ValueVersions, 'overview' | 'rollback' | 'resume'> | null;
  calibration: (scopeKey: string) => CalibrationReport | null;
  choices: (scopeKey: string) => Record<string, number>;
  record: OwnerValueRecorder;
  ownerScopeKey: string;
  now: () => string;
}

export type OwnerValueRecorder = (scopeKey: string, action: 'rollback' | 'resume', versionId: string, at: string) => void;

/** Writes an owner's control of the value table to the activity record (no content: what was done, and the version's id). */
export function ownerValueRecorder(activity: Pick<AutonomyActivityRecord, 'append'>, config: Pick<AutonomyConfig, 'timeZone'>): OwnerValueRecorder {
  return (scopeKey, action, versionId, at) => {
    activity.append(scopeKey, autonomyDayKey(at, config), at, {
      kind: 'control', actor: 'owner', domain: SHANNON_AUTONOMY_SYSTEM_DOMAIN.id, outcome: 'recorded', approval: 'not_needed',
      tool: `values.${action}`, reasonCode: `values_${action}`, detail: versionId,
      summary: action === 'rollback'
        ? '所有者が価値表を前の版に戻しました。再開するまで、それ以降の結果は価値表に使いません。'
        : '所有者が価値表の更新を再開しました。',
    });
  };
}

/** The view the route and the command line give. */
export function valuesView(dependencies: Pick<ValuesRouteDependencies, 'values' | 'calibration' | 'choices'>, scopeKey: string): Record<string, unknown> {
  const overview = dependencies.values?.overview(scopeKey) ?? { active: null, frozen: false, versions: [], cells: [] };
  return {
    active: overview.active, frozen: overview.frozen, versions: overview.versions,
    cells: overview.cells.map(cell => ({ ...cell, lastAt: cell.lastAt === null ? null : new Date(cell.lastAt).toISOString(), sd: Math.sqrt(cell.uncertainty) })),
    calibration: dependencies.calibration(scopeKey), choices: dependencies.choices(scopeKey),
  };
}

const STATUS: Readonly<Record<ValuesOwnerError, number>> = Object.freeze({
  VALUES_NO_ACTIVE_VERSION: 409, VALUES_VERSION_NOT_FOUND: 404, VALUES_NO_EARLIER_VERSION: 409, VALUES_NOT_FROZEN: 409, VALUES_NO_EVIDENCE: 409, VALUES_UNAVAILABLE: 503,
});

export function createValuesRoute(dependencies: ValuesRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, principal: { scopeKey: string } | null, path: string): Promise<void> => {
    if (!principal) return sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    if (principal.scopeKey !== dependencies.ownerScopeKey) return sendJson(response, 403, { error: 'VALUES_OWNER_ONLY' });
    if (!dependencies.values) return sendJson(response, 403, { error: 'VALUES_DISABLED', message: 'The choice ledger is switched off on the server.' });
    const scopeKey = principal.scopeKey;
    if (path === VALUES_PATH) {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return sendJson(response, 200, valuesView(dependencies, scopeKey));
    }
    const action = path === `${VALUES_PATH}/rollback` ? 'rollback' : path === `${VALUES_PATH}/resume` ? 'resume' : null;
    if (!action) return sendJson(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await readJson(request, 4 * 1024);
    const requested = body && typeof body === 'object' && !Array.isArray(body) ? (body as { versionId?: unknown }).versionId : undefined;
    if (requested !== undefined && (typeof requested !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u.test(requested))) {
      return sendJson(response, 400, { error: 'VALUES_VERSION_INVALID' });
    }
    const at = dependencies.now();
    const result = action === 'rollback' ? dependencies.values.rollback(scopeKey, at, requested) : dependencies.values.resume(scopeKey, at);
    if (typeof result === 'string') return sendJson(response, STATUS[result], { error: result });
    try { dependencies.record(scopeKey, action, result.versionId, at); } catch (error) { console.error('Shannon value control record failed', error instanceof Error ? error.name : 'unknown'); }
    return sendJson(response, 200, valuesView(dependencies, scopeKey));
  };
}
