import { timingSafeEqual } from 'node:crypto';

const minimumTokenLength = 32;

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
