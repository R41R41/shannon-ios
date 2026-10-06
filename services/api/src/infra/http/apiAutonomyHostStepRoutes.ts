import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { HostFolderDesk } from '../../mind/action/ownTime/autonomyHostFolderDesk.js';
import { HOST_FOLDER_LIMITS, hostFolderLabel, isHostStepCode } from '../../mind/action/ownTime/autonomyHostFolderPath.js';
import { HOST_RESULT_LIMITS, validHostOperationResult } from '../../mind/action/ownTime/hostFolderOperationResults.js';
import { HOST_CLAIM_MAXIMUM_WAIT_SECONDS, type HostFolderOperations } from '../../mind/action/ownTime/hostFolderOperations.js';
import { HOST_OPERATIONS } from '../../mind/action/ownTime/store/hostFolderOperationsStore.js';

export const HOST_STEP_ROUTE_PREFIX = '/v1/autonomy/host-steps';
export const HOST_STEP_CLAIM_PATH = `${HOST_STEP_ROUTE_PREFIX}/claim`;
/** `GET`: the host bound to the calling device, so that an app does not have to know its host's name (A18). */
export const HOST_STEP_BINDING_PATH = `${HOST_STEP_ROUTE_PREFIX}/binding`;
export const HOST_STEP_REPORT_PATH = /^\/v1\/autonomy\/host-steps\/([0-9a-f-]{36})\/report$/u;
/** A v2 report may carry a read of 256 KiB of text (escaped); every other body keeps the server's 64 KiB. */
export function hostStepRequestBytes(path: string): number | undefined {
  return HOST_STEP_REPORT_PATH.test(path) ? HOST_RESULT_LIMITS.reportBodyBytes : undefined;
}
const DEVICE_OPERATIONS: readonly string[] = Object.freeze(['write', ...HOST_OPERATIONS]);

/**
 * The device side of her folder on the owner's machines (`docs/host-folder-contract.md`).
 * The paired device bound to a host pulls one step, carries it out, and reports an outcome with a code from a
 * fixed set. The device is taken from its token, never from the body.
 *
 * v1 (no `protocol`): one claim answered at once, `write` steps only, no text back. v2 (`protocol: 2`): a long-poll
 * claim, the operations the device lists, and for reading operations a `result` whose every field is checked
 * against its shape and bounds (`hostFolderOperationResults.ts`). That result goes only to the tool call waiting
 * for it; nothing a device sends reaches the activity record, her memory, or her study.
 */
export function dispatchHostStepRequest(request: ApiRequest, folder: HostFolderDesk, operations: HostFolderOperations): ApiResponse | Promise<ApiResponse> {
  if (request.path === HOST_STEP_BINDING_PATH && request.method === 'GET') {
    if (!validScopeKey(request.query?.get('scopeKey'))) return badRequest('scopeKey is required');
    // Only a paired device has a binding; a fixed-token or local caller is refused as on the other routes.
    if (!request.deviceId) return notBound();
    const host = operations.boundHostOf(request.deviceId);
    return { status: 200, body: host ? { host, label: hostFolderLabel(host) } : { host: null } };
  }
  if (request.method !== 'POST') return { status: 404, body: { error: 'NOT_FOUND' } };
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');

  if (request.path === HOST_STEP_CLAIM_PATH) {
    const v2 = request.body.protocol !== undefined;
    const fields = v2 ? ['scopeKey', 'host', 'protocol', 'operations', 'waitSeconds', 'localStop'] : ['scopeKey', 'host'];
    const unknown = Object.keys(request.body).find(key => !fields.includes(key));
    if (unknown) return badRequest(`${unknown.slice(0, 40)} is not allowed`);
    const host = request.body.host;
    if (typeof host !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(host)) return badRequest('host is invalid');
    if (!v2) {
      const claimed = folder.claim(scopeKey, host, request.deviceId);
      return claimed === 'HOST_NOT_BOUND' ? notBound() : { status: 200, body: claimed };
    }
    const { protocol, operations: listed, waitSeconds, localStop } = request.body;
    if (protocol !== 2) return badRequest('protocol is invalid');
    if (!Array.isArray(listed) || listed.length > DEVICE_OPERATIONS.length || listed.some(item => typeof item !== 'string' || !DEVICE_OPERATIONS.includes(item))) return badRequest('operations is invalid');
    if (waitSeconds !== undefined && (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > HOST_CLAIM_MAXIMUM_WAIT_SECONDS)) return badRequest('waitSeconds is invalid');
    if (localStop !== undefined && typeof localStop !== 'boolean') return badRequest('localStop is invalid');
    return operations.claim(scopeKey, host, request.deviceId, { operations: listed as string[], waitSeconds: waitSeconds ?? 0, localStop: localStop === true }, request.signal)
      .then(claimed => (claimed === 'HOST_NOT_BOUND' ? notBound() : { status: 200, body: claimed }));
  }

  const reportMatch = request.path.match(HOST_STEP_REPORT_PATH);
  if (reportMatch) {
    const unknown = Object.keys(request.body).find(key => !['scopeKey', 'outcome', 'code', 'bytes', 'result'].includes(key));
    if (unknown) return badRequest(`${unknown.slice(0, 40)} is not allowed`);
    const { outcome, code, bytes, result } = request.body;
    if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'refused') return badRequest('outcome is invalid');
    if (code !== undefined && !isHostStepCode(code)) return badRequest('code is invalid');
    if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > HOST_FOLDER_LIMITS.bytes)) return badRequest('bytes is invalid');
    const id = reportMatch[1]!;
    const kind = operations.operationKind(scopeKey, id);
    if (kind) {
      if (result !== undefined && outcome !== 'done') return badRequest('result is allowed only with done');
      let checked;
      if (result !== undefined) {
        const valid = validHostOperationResult(kind, result);
        if ('problem' in valid) return badRequest(`result is invalid: ${valid.problem}`);
        checked = valid.result;
      }
      const receipt = operations.report(scopeKey, id, request.deviceId, { outcome, ...(code !== undefined ? { code } : {}), ...(checked ? { result: checked } : {}) });
      return receipt === 'HOST_STEP_NOT_FOUND' || receipt === null ? { status: 404, body: { error: 'HOST_STEP_NOT_FOUND' } } : { status: 200, body: receipt };
    }
    if (result !== undefined) return badRequest('result is not allowed for this step');
    const receipt = folder.report(scopeKey, id, request.deviceId, {
      outcome, ...(code !== undefined ? { code } : {}), ...(bytes !== undefined ? { bytes } : {}),
    });
    return receipt === 'HOST_STEP_NOT_FOUND' ? { status: 404, body: { error: receipt } } : { status: 200, body: receipt };
  }
  return { status: 404, body: { error: 'NOT_FOUND' } };
}

/** A signal aborted when the response closes before it was sent: the device went away. */
export function closedSignal(response: { once(event: 'close', listener: () => void): unknown; writableFinished?: boolean }): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => { if (!response.writableFinished) controller.abort(); });
  return controller.signal;
}

function notBound(): ApiResponse {
  return { status: 403, body: { error: 'HOST_NOT_BOUND', message: 'This device is not registered for that host.' } };
}
