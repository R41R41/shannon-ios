import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SQLiteDeviceAuthStore, ShannonDevicePrincipal } from './deviceAuth.js';
import type { SQLitePushNotificationStore } from '../../surfaces/outreach/pushNotifications.js';
import type { APNsEnvironment } from '../../surfaces/outreach/pushNotifications.js';
import { sendJson } from '../http/serverHttp.js';

export interface ServerDeviceRouteDependencies {
  deviceAuth: SQLiteDeviceAuthStore | null;
  pushStore: SQLitePushNotificationStore;
  /** Told about a device that was just unpaired, so that whatever else is kept for it (its call token) goes too. */
  revoked?: (deviceId: string) => void;
}

export function handleDeviceManagement(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  principal: ShannonDevicePrincipal | null,
  dependencies: ServerDeviceRouteDependencies,
): void {
  if (!dependencies.deviceAuth || !principal) {
    sendJson(response, 404, { error: 'NOT_FOUND' });
    return;
  }
  if (request.method === 'GET') {
    const devices = dependencies.deviceAuth.listActiveDevicesForScope(principal.scopeKey).map(device => ({
      deviceId: device.deviceId,
      displayName: device.displayName,
      expiresAt: device.expiresAt,
      lastUsedAt: device.lastUsedAt,
      isCurrent: device.deviceId === principal.deviceId,
    }));
    sendJson(response, 200, { devices });
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'INVALID_REQUEST' });
    return;
  }
  const deviceId = (body as Record<string, unknown>).deviceId;
  const revokeCurrent = (body as Record<string, unknown>).revokeCurrent === true;
  if (typeof deviceId !== 'string' || !/^[a-f0-9]{16}$/.test(deviceId)) {
    sendJson(response, 400, { error: 'INVALID_DEVICE_ID' });
    return;
  }
  const isCurrent = deviceId === principal.deviceId;
  if (isCurrent !== revokeCurrent) {
    sendJson(response, 409, { error: 'DEVICE_INTENT_MISMATCH' });
    return;
  }
  if (!dependencies.deviceAuth.revokeForScope(deviceId, principal.scopeKey)) {
    sendJson(response, 404, { error: 'DEVICE_NOT_FOUND' });
    return;
  }
  dependencies.pushStore.invalidateDevice(deviceId);
  try { dependencies.revoked?.(deviceId); } catch { /* the device is unpaired either way */ }
  sendJson(response, 200, { revokedDeviceId: deviceId });
}

export function handlePushRegistration(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  principal: ShannonDevicePrincipal | null,
  dependencies: ServerDeviceRouteDependencies,
): void {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!principal) {
    sendJson(response, 403, { error: 'PAIRED_DEVICE_REQUIRED' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'INVALID_REQUEST' });
    return;
  }
  const value = body as Record<string, unknown>;
  const deviceToken = typeof value.deviceToken === 'string' ? value.deviceToken : '';
  const environment = value.environment;
  if (environment !== 'sandbox' && environment !== 'production') {
    sendJson(response, 400, { error: 'PUSH_ENVIRONMENT_INVALID' });
    return;
  }
  try {
    dependencies.pushStore.register(principal, deviceToken, environment as APNsEnvironment);
    sendJson(response, 200, { registered: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'PUSH_DEVICE_TOKEN_INVALID') {
      sendJson(response, 400, { error: error.message });
      return;
    }
    throw error;
  }
}
