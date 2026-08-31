import { describe, expect, it } from 'vitest';
import { bearerAuthorized, configuredApiToken } from '../src/apiAuth.js';

describe('device API authentication', () => {
  const token = '0123456789abcdef0123456789abcdef';

  it('allows tokenless loopback development but requires a token on LAN', () => {
    expect(configuredApiToken('127.0.0.1', undefined)).toBeNull();
    expect(() => configuredApiToken('192.168.2.129', undefined)).toThrow('required');
    expect(configuredApiToken('192.168.2.129', token)).toBe(token);
  });

  it('rejects missing, malformed, short, and incorrect credentials', () => {
    expect(() => configuredApiToken('127.0.0.1', 'short')).toThrow('at least 32');
    expect(bearerAuthorized(undefined, token)).toBe(false);
    expect(bearerAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(bearerAuthorized('Bearer incorrect', token)).toBe(false);
    expect(bearerAuthorized(`Bearer ${token}`, token)).toBe(true);
  });
});
