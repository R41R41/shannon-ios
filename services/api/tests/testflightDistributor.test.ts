import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  configuredTestFlightDistribution,
  createIndividualAppStoreConnectToken,
  distributeLatestInternalBuild,
} from '../src/testflightDistributor.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('TestFlight distributor', () => {
  it('accepts current 12-character individual key IDs', () => {
    expect(configuredTestFlightDistribution({
      SHANNON_ASC_KEY_ID: 'UWR83E6MW5QE',
      SHANNON_ASC_PRIVATE_KEY_PATH: '/private/key.p8',
      SHANNON_ASC_APP_ID: '6808634666',
      SHANNON_ASC_BETA_GROUP_ID: 'group-1',
    }).keyId).toBe('UWR83E6MW5QE');
  });

  it('keeps platform selection explicit and rejects unknown platforms', () => {
    const environment = {
      SHANNON_ASC_KEY_ID: 'UWR83E6MW5QE', SHANNON_ASC_PRIVATE_KEY_PATH: '/private/key.p8',
      SHANNON_ASC_APP_ID: '6808634666', SHANNON_ASC_BETA_GROUP_ID: 'group-1',
    };
    expect(configuredTestFlightDistribution(environment).platform).toBe('IOS');
    expect(configuredTestFlightDistribution({ ...environment, SHANNON_ASC_PLATFORM: 'MAC_OS' }).platform).toBe('MAC_OS');
    expect(() => configuredTestFlightDistribution({ ...environment, SHANNON_ASC_PLATFORM: 'android' })).toThrow('SHANNON_ASC_PLATFORM is invalid');
  });

  it.each([['IOS', 'build-166', '166'], ['MAC_OS', 'build-167', '167']] as const)(
    'assigns the latest %s build when the other platform has a higher build number', async (platform, id, version) => {
      const posted: string[] = [];
      const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/builds') {
          // Model Apple's platform filter; without it the older bug selects Mac 167.
          const requested = url.searchParams.get('filter[preReleaseVersion.platform]');
          const candidates = [
            { platform: 'IOS', id: 'build-166', version: '166' },
            { platform: 'MAC_OS', id: 'build-167', version: '167' },
          ].filter(build => !requested || build.platform === requested);
          return jsonResponse({ data: candidates.map(build => ({ type: 'builds', id: build.id, attributes: {
            version: build.version, processingState: 'VALID', expired: false, buildAudienceType: 'INTERNAL_ONLY',
          } })) });
        }
        if (init?.method === 'POST') {
          posted.push(init.body as string);
          return new Response(null, { status: 204 });
        }
        return jsonResponse({ data: [{ type: 'builds', id: 'older-build' }] });
      };
      const result = await distributeLatestInternalBuild({
        config: { keyId: 'GTU22DPJD5', privateKeyPath: '/private/key.p8', appId: '6808634666', betaGroupId: 'group-1',
          ...(platform === 'MAC_OS' ? { platform } : {}) },
        fetchImpl: fetchImpl as typeof fetch, readPrivateKey: async () => privateKeyPem,
      });
      expect(result).toEqual({ status: 'distributed', buildId: id, version });
      expect(posted).toEqual([JSON.stringify({ data: [{ type: 'builds', id }] })]);
    },
  );

  it('creates a valid short-lived individual App Store Connect token', () => {
    const token = createIndividualAppStoreConnectToken('GTU22DPJD5', privateKeyPem, 1_780_000_000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'ES256', kid: 'GTU22DPJD5', typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      sub: 'user', iat: 1_780_000_000, exp: 1_780_000_600, aud: 'appstoreconnect-v1',
    });
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('adds only the latest valid internal build to the configured group', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url.includes('/v1/builds?')) return jsonResponse({ data: [
        { type: 'builds', id: 'build-14', attributes: {
          version: '14', uploadedDate: '2026-09-05T03:41:00Z', processingState: 'VALID',
          expired: false, buildAudienceType: 'INTERNAL_ONLY',
        } },
        { type: 'builds', id: 'build-15', attributes: {
          version: '15', uploadedDate: '2026-09-05T03:40:00Z', processingState: 'VALID',
          expired: false, buildAudienceType: 'INTERNAL_ONLY',
        } },
      ] });
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      return jsonResponse({ data: [{ type: 'builds', id: 'build-11' }] });
    };

    const result = await distributeLatestInternalBuild({
      config: {
        keyId: 'GTU22DPJD5', privateKeyPath: '/private/key.p8', appId: '6808634666',
        betaGroupId: 'group-1',
      },
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-09-05T03:50:00Z'),
      readPrivateKey: async () => privateKeyPem,
    });

    expect(result).toEqual({ status: 'distributed', buildId: 'build-15', version: '15' });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      method: 'POST', body: JSON.stringify({ data: [{ type: 'builds', id: 'build-15' }] }),
    });
  });

  it('does not post when the latest build is already linked', async () => {
    const methods: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return String(input).includes('/v1/builds?')
        ? jsonResponse({ data: [{ type: 'builds', id: 'build-15', attributes: {
          version: '15', processingState: 'VALID', expired: false, buildAudienceType: 'INTERNAL_ONLY',
        } }] })
        : jsonResponse({ data: [{ type: 'builds', id: 'build-15' }] });
    };
    const result = await distributeLatestInternalBuild({
      config: {
        keyId: 'GTU22DPJD5', privateKeyPath: '/private/key.p8', appId: '6808634666',
        betaGroupId: 'group-1',
      },
      fetchImpl: fetchImpl as typeof fetch,
      readPrivateKey: async () => privateKeyPem,
    });
    expect(result.status).toBe('already-current');
    expect(methods).toEqual(['GET', 'GET']);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
