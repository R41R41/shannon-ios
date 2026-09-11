import { describe, expect, it } from 'vitest';
import { isPrivateOrReservedAddress } from '../src/ipSafety.js';

describe('IP safety boundary', () => {
  it('rejects private, carrier-grade, documentation, and mapped-private addresses', () => {
    for (const address of [
      '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '172.31.0.1', '192.168.1.1',
      '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
      '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1',
      '::ffff:7f00:1', '::ffff:127.0.0.1',
    ]) expect(isPrivateOrReservedAddress(address), address).toBe(true);
  });

  it('allows ordinary public IPv4, IPv6, and mapped-public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:0808:0808']) {
      expect(isPrivateOrReservedAddress(address), address).toBe(false);
    }
  });
});
