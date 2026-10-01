import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import {
  handlePlatformBridgePlaces, type PlatformBridgeRouteDependencies,
} from '../src/serverPlatformBridgeRoute.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('platform place search', () => {
  it('requires bridge authentication and sends only the public query to web search', async () => {
    const requests: ShannonChatModelRequest[] = [];
    const model: ShannonChatModel = {
      mode: 'openai', model: 'test',
      async generate(request) {
        requests.push(request);
        return { mode: 'openai', model: 'test', reply: '公園を見つけたよ。', places: [{
          name: '浜松城公園', address: '静岡県浜松市', reason: '散歩向き', mapQuery: '浜松城公園',
          mapUrl: 'https://maps.apple.com/?q=hamamatsu',
        }] };
      },
    };
    const dependencies = {
      configuration: { token: 'a'.repeat(32) }, chatModel: model,
    } as PlatformBridgeRouteDependencies;
    const server = createServer((request, response) => {
      void handlePlatformBridgePlaces(request, response, dependencies);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const url = `http://127.0.0.1:${address.port}/v1/platform/places`;
    const unauthorized = await fetch(url, { method: 'POST', body: JSON.stringify({ query: '浜松の公園' }) });
    expect(unauthorized.status).toBe(401);
    expect(requests).toHaveLength(0);

    const authorized = await fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${'a'.repeat(32)}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ query: '浜松の公園' }) });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ reply: expect.stringContaining('https://maps.apple.com/'),
      places: [{ name: '浜松城公園' }] });
    expect(requests).toEqual([expect.objectContaining({ message: '浜松の公園', history: [], useWebSearch: true,
      placeSearch: {} })]);
  });
});
