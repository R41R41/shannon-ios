import type { ApiRequest, ApiResponse } from './contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { HostFolderDesk } from './autonomyHostFolderDesk.js';
import { HOST_FOLDER_LIMITS, isHostStepCode } from './autonomyHostFolderPath.js';

export const HOST_STEP_ROUTE_PREFIX = '/v1/autonomy/host-steps';

/**
 * The device side of her folder on the owner's machines (`docs/host-folder-contract.md`).
 * The paired device bound to a host pulls one step, writes the file, and reports an
 * outcome with a code from a fixed set. The device is taken from its token, never from
 * the body. Nothing here accepts text from the device, so nothing in the folder can
 * come back into the server.
 */
export function dispatchHostStepRequest(request: ApiRequest, folder: HostFolderDesk): ApiResponse {
  if (request.method !== 'POST') return { status: 404, body: { error: 'NOT_FOUND' } };
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');

  if (request.path === `${HOST_STEP_ROUTE_PREFIX}/claim`) {
    const unknown = Object.keys(request.body).find(key => key !== 'scopeKey' && key !== 'host');
    if (unknown) return badRequest(`${unknown.slice(0, 40)} is not allowed`);
    const host = request.body.host;
    if (typeof host !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(host)) return badRequest('host is invalid');
    const claimed = folder.claim(scopeKey, host, request.deviceId);
    return claimed === 'HOST_NOT_BOUND'
      ? { status: 403, body: { error: claimed, message: 'This device is not registered for that host.' } }
      : { status: 200, body: claimed };
  }

  const reportMatch = request.path.match(/^\/v1\/autonomy\/host-steps\/([0-9a-f-]{36})\/report$/u);
  if (reportMatch) {
    const unknown = Object.keys(request.body).find(key => !['scopeKey', 'outcome', 'code', 'bytes'].includes(key));
    if (unknown) return badRequest(`${unknown.slice(0, 40)} is not allowed`);
    const { outcome, code, bytes } = request.body;
    if (outcome !== 'done' && outcome !== 'failed' && outcome !== 'refused') return badRequest('outcome is invalid');
    if (code !== undefined && !isHostStepCode(code)) return badRequest('code is invalid');
    if (bytes !== undefined && (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > HOST_FOLDER_LIMITS.bytes)) return badRequest('bytes is invalid');
    const receipt = folder.report(scopeKey, reportMatch[1]!, request.deviceId, {
      outcome, ...(code !== undefined ? { code } : {}), ...(bytes !== undefined ? { bytes } : {}),
    });
    return receipt === 'HOST_STEP_NOT_FOUND' ? { status: 404, body: { error: receipt } } : { status: 200, body: receipt };
  }
  return { status: 404, body: { error: 'NOT_FOUND' } };
}
