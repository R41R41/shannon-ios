import { serverEnvironment } from '../config/serverEnvironment.js';
export { SQLiteDeviceAuthStore, normalizePairingCode } from './store/deviceAuthStore.js';

export interface ShannonDevicePrincipal {
  deviceId: string;
  scopeKey: string;
  displayName: string;
}

export interface ShannonPairingResult extends ShannonDevicePrincipal {
  token: string;
  expiresAt: string;
}

export interface ShannonDeviceRecord extends ShannonDevicePrincipal {
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssuedPairingCode {
  code: string;
  scopeKey: string;
  expiresAt: string;
}

export interface SQLiteDeviceAuthOptions {
  path: string;
  pepper: string;
  now?: () => number;
}

export function configuredAuthPepper(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): string {
  const value = environment.SHANNON_AUTH_PEPPER?.trim() ?? '';
  if (value.length < 32) throw new Error('SHANNON_AUTH_PEPPER must contain at least 32 characters');
  return value;
}
