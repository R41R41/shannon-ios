import { describe, expect, it } from 'vitest';
import { bearerAuthorized, configuredApiToken, configuredAuthMode } from '../src/infra/auth/apiAuth.js';

describe('device API authentication', () => {
  const token = '0123456789abcdef0123456789abcdef';

  it('allows tokenless loopback development but requires a token on LAN', () => {
    expect(configuredApiToken('127.0.0.1', undefined)).toBeNull();
    expect(() => configuredApiToken('192.168.2.129', undefined)).toThrow('required');
    expect(configuredApiToken('192.168.2.129', token)).toBe(token);
  });

  it('selects an explicit production pairing boundary', () => {
    expect(configuredAuthMode('127.0.0.1', {})).toBe('none');
    expect(configuredAuthMode('192.168.2.129', { SHANNON_API_TOKEN: token })).toBe('fixed');
    expect(configuredAuthMode('127.0.0.1', { SHANNON_AUTH_MODE: 'paired' })).toBe('paired');
    expect(() => configuredAuthMode('192.168.2.129', { SHANNON_AUTH_MODE: 'none' })).toThrow('loopback');
  });

  it('rejects missing, malformed, short, and incorrect credentials', () => {
    expect(() => configuredApiToken('127.0.0.1', 'short')).toThrow('at least 32');
    expect(bearerAuthorized(undefined, token)).toBe(false);
    expect(bearerAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(bearerAuthorized('Bearer incorrect', token)).toBe(false);
    expect(bearerAuthorized(`Bearer ${token}`, token)).toBe(true);
  });
});
