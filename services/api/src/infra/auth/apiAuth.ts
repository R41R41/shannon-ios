import { timingSafeEqual } from 'node:crypto';
import { serverEnvironment } from '../config/serverEnvironment.js';

const minimumTokenLength = 32;

export type ShannonApiAuthMode = 'none' | 'fixed' | 'paired';

export function configuredAuthMode(
  host: string,
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): ShannonApiAuthMode {
  const explicit = environment.SHANNON_AUTH_MODE?.trim().toLowerCase();
  if (explicit) {
    if (explicit === 'none') {
      if (host !== '127.0.0.1') throw new Error('SHANNON_AUTH_MODE=none is only allowed on loopback');
      return 'none';
    }
    if (explicit === 'fixed' || explicit === 'paired') return explicit;
    throw new Error('SHANNON_AUTH_MODE must be none, fixed, or paired');
  }
  if (environment.SHANNON_API_TOKEN?.trim()) return 'fixed';
  return host === '127.0.0.1' ? 'none' : 'fixed';
}

export function configuredApiToken(host: string, value: string | undefined): string | null {
  const token = value?.trim() ?? '';
  if (!token) {
    if (host !== '127.0.0.1') {
      throw new Error('SHANNON_API_TOKEN is required when the API is available on the LAN');
    }
    return null;
  }
  if (token.length < minimumTokenLength) {
    throw new Error(`SHANNON_API_TOKEN must contain at least ${minimumTokenLength} characters`);
  }
  return token;
}

export function bearerAuthorized(header: string | undefined, token: string | null): boolean {
  if (!token) return true;
  if (!header?.startsWith('Bearer ')) return false;

  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
