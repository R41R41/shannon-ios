import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BODY_MIND_PATH } from '../src/contracts/bodyMindContract.js';
import { gameBodyMayCall } from '../src/wiring/serverMinecraftBodyWiring.js';
import { isPlatformBridgePath } from '../src/surfaces/platform/serverPlatformBridgeRoute.js';
import { readApiSource, repositoryRoot } from './support/sources.js';

/**
 * Why the 2026-11-24 release shipped `GET /v1/body/mind` refused (403 GAME_BODY_DEVICE_DENIED) with every test green:
 * the body's own tests call the head through a stub `fetch`, and the head's tests dispatched the route through `api.dispatch`
 * with a device id, which never passes `gameBodyMayCall` (the gate sits in the server's request handler, before the kernel).
 * Neither side ever sent the body's real call through the body token's gate. This file holds the list of what the body calls and
 * checks it against the gate; and, where the body's repository is beside this one, it reads the body's source and checks that
 * every `/v1/body/*` and `/v1/platform/voice/*` it names is in this list, so a new call that is not here fails.
 */
const BODY_BEARER_CALLS: ReadonlyArray<readonly [method: string, path: string]> = [
  ['POST', '/v1/body/minecraft/turns'], ['POST', '/v1/body/minecraft/claim'], ['POST', '/v1/body/minecraft/stop'],
  ['GET', '/v1/body/minecraft/queue'], ['POST', '/v1/body/minecraft/queue'], ['POST', '/v1/body/minecraft/control'],
  ['POST', '/v1/body/minecraft/lifecycle'], ['POST', '/v1/body/minecraft/lifecycle/permit'], ['POST', '/v1/body/minecraft/lifecycle-request'],
  ['POST', '/v1/body/events'], ['GET', '/v1/body/presence'], ['GET', BODY_MIND_PATH],
];
/** Calls under the platform bridge's own service token: they never reach the device gate (`isPlatformBridgePath`, before pairing). */
const BODY_PLATFORM_VOICE = ['turn', 'transcribe', 'speech', 'cast', 'fillers', 'warm', 'wording', 'said', 'say', 'mouth/poll', 'mouth/result'];

describe('what the Minecraft body calls on the head, against what the head lets it call', () => {
  it('lets the body token make every call on the list (each with its method)', () => {
    for (const [method, path] of BODY_BEARER_CALLS) expect(gameBodyMayCall(method, path), `${method} ${path}`).toBe(true);
  });

  it('keeps the feeling read to GET, and still refuses the neighbours that are not the body\'s', () => {
    expect(gameBodyMayCall('POST', BODY_MIND_PATH)).toBe(false);
    expect(gameBodyMayCall('PUT', BODY_MIND_PATH)).toBe(false);
    expect(gameBodyMayCall('GET', `${BODY_MIND_PATH}/history`)).toBe(false);
    for (const path of ['/v1/body/nudges', '/v1/body/capabilities', '/v1/body/reactions', '/v1/body/touch-reflex']) {
      expect(gameBodyMayCall('GET', path), path).toBe(false);
    }
  });

  it('serves the voice calls (warm, cast, ...) behind the bridge token, outside the device gate', () => {
    for (const name of BODY_PLATFORM_VOICE) expect(isPlatformBridgePath(`/v1/platform/voice/${name}`), name).toBe(true);
    const route = readApiSource('platformVoiceRoute.ts');
    for (const name of ['warm', 'cast', 'wording', 'said']) expect(route, name).toContain(`name === '${name}'`);
  });

  const bodyRoot = [process.env.SHANNON_BODY_REPO, resolve(repositoryRoot, '..', 'release-body-1124')]
    .find((candidate): candidate is string => Boolean(candidate) && existsSync(join(candidate!, 'backend/src')));
  it.skipIf(!bodyRoot)('names no /v1/body/* path in the body\'s source that the list above (and so the gate) does not hold', () => {
    const files = ['backend/src/services/minebot/integration/CompanionBodyClient.ts', 'backend/src/services/minebot/integration/expressionBridge.ts',
      'backend/src/services/minebot/integration/commonFca/uiModMind.ts', 'backend/src/services/integration/minecraftLifecycleContract.ts',
      'backend/src/services/integration/shannonLifecycle.ts', 'backend/src/services/minebot/integration/commonFca/minecraftControlContract.ts'];
    const named = new Set<string>();
    for (const file of files) {
      const source = readFileSync(join(bodyRoot!, file), 'utf8');
      for (const match of source.matchAll(/['"`](\/v1\/body\/[A-Za-z0-9_\/-]+)/gu)) named.add(match[1]!.replace(/\/$/u, ''));
    }
    expect(named.size).toBeGreaterThan(5);
    const known = new Set(BODY_BEARER_CALLS.map(([, path]) => path));
    // `/v1/body/minecraft/requests/<id>` is a prefix the body appends an id to; the prefix rule of the gate covers it.
    for (const path of named) {
      const covered = known.has(path) || path.startsWith('/v1/body/minecraft/');
      expect(covered, `the body calls ${path}, which is not in BODY_BEARER_CALLS`).toBe(true);
      expect(['GET', 'POST'].some(method => gameBodyMayCall(method, path)), path).toBe(true);
    }
  });

  it.skipIf(!bodyRoot)('names no /v1/platform/voice/<name> in the body\'s voice client that the head does not route', () => {
    const source = readFileSync(join(bodyRoot!, 'backend/src/services/integration/shannonCoreVoiceClient.ts'), 'utf8');
    const names = new Set([...source.matchAll(/(?:endpoint|postJson)\('([a-z/]+)'/gu)].map(match => match[1]!));
    expect(names.size).toBeGreaterThan(5);
    for (const name of names) expect(BODY_PLATFORM_VOICE, `the body calls voice/${name}`).toContain(name);
  });

  it('reads the head\'s own list of what the gate lets through, so the mind route cannot be dropped from it again', () => {
    expect(readApiSource('serverMinecraftBodyWiring.ts')).toContain('BODY_MIND_PATH');
    expect(BODY_MIND_PATH).toBe('/v1/body/mind');
  });
});
