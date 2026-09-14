import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Azure deployment contract', () => {
  it('allows confirmed camera snapshots through nginx to the route-specific API limit', () => {
    const configuration = readFileSync(
      new URL('../../../deploy/azure/nginx-location.conf', import.meta.url),
      'utf8',
    );

    expect(configuration).toContain('client_max_body_size 4m;');
    expect(configuration).toContain('camera snapshots at 3 MiB');
  });
});
