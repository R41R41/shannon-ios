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
  /** The pepper being rotated away from: a token or code it keyed still matches, and a token is rekeyed under `pepper` on that use. */
  previousPepper?: string | null;
  now?: () => number;
}

/** How far a pepper rotation has come: active tokens confirmed under the current pepper, and the devices not yet (no secret, no digest). */
export interface PepperMigrationStatus {
  previousPepperConfigured: boolean;
  activeDevices: number;
  onCurrentPepper: number;
  remaining: readonly { deviceId: string; displayName: string; lastUsedAt: string | null }[];
}

export function configuredAuthPepper(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): string {
  const value = environment.SHANNON_AUTH_PEPPER?.trim() ?? '';
  if (value.length < 32) throw new Error('SHANNON_AUTH_PEPPER must contain at least 32 characters');
  return value;
}

/** SHANNON_AUTH_PEPPER_PREVIOUS: absent or empty is no rotation (the store behaves as before); one equal to the current pepper is refused. */
export function configuredPreviousAuthPepper(
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): string | null {
  const value = environment.SHANNON_AUTH_PEPPER_PREVIOUS?.trim() ?? '';
  if (!value) return null;
  if (value.length < 32) throw new Error('SHANNON_AUTH_PEPPER_PREVIOUS must contain at least 32 characters');
  if (value === configuredAuthPepper(environment)) throw new Error('SHANNON_AUTH_PEPPER_PREVIOUS must differ from SHANNON_AUTH_PEPPER');
  return value;
}
