import type { AppLookAnswer, AppLooks } from './appLook.js';
import { appLookAnswerId, validatedAppLookResult } from './appLookContract.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import { BODY_SCHEMA_VERSION } from './bodyContract.js';
import type { ApiRequest, ApiResponse } from './contracts.js';

/** A fixed-token (local) caller has no paired device. */
const LOCAL_DEVICE = 'local';

const REFUSALS = {
  disabled: [403, 'APP_LOOK_DISABLED', 'Looking through the app is switched off on the server.'],
  not_found: [404, 'LOOK_NOT_FOUND', 'No such look.'],
  wrong_device: [403, 'LOOK_NOT_YOURS', 'This look was asked of another device.'],
  answered: [409, 'LOOK_ALREADY_ANSWERED', 'This look was already answered.'],
  expired: [410, 'LOOK_EXPIRED', 'This look expired before it was answered.'],
} as const;

function answered(answer: AppLookAnswer): ApiResponse {
  if (answer.kind !== 'done') {
    const [status, error, message] = REFUSALS[answer.kind];
    return { status, body: { error, message } };
  }
  return { status: 200, body: { schemaVersion: BODY_SCHEMA_VERSION, id: answer.id, status: answer.status, message: answer.message } };
}

/**
 * `POST /v1/app/looks/{id}`: the app's answer to the ask a turn's response carried (`appLook`). It carries one JPEG
 * frame or a closed refusal code, and no text. The answer is her message about what she saw, already stored in the
 * Talk; the frame is shown to the model once and written nowhere.
 */
export function dispatchAppLookRequest(request: ApiRequest, looks: AppLooks): ApiResponse | Promise<ApiResponse> {
  const id = appLookAnswerId(request.path);
  if (request.method !== 'POST' || !id) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  const result = validatedAppLookResult(request.body);
  if (typeof result === 'string') return badRequest(result);
  return looks.answer(scopeKey, request.deviceId ?? LOCAL_DEVICE, id, result).then(answered);
}
