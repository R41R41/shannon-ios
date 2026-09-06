import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compareBuildVersions,
  parseArguments,
  parseDistributionState,
  repositoryNameFromRemote,
} from './release-runner.mjs';

test('accepts only the Shannon GitHub repository identity', () => {
  assert.equal(repositoryNameFromRemote('git@github.com:R41R41/shannon-ios.git'), 'R41R41/shannon-ios');
  assert.equal(repositoryNameFromRemote('https://github.com/R41R41/shannon-ios.git'), 'R41R41/shannon-ios');
  assert.equal(repositoryNameFromRemote('git@example.com:wrong/repository.git'), null);
});

test('parses an explicit external release lock and expected values', () => {
  assert.deepEqual(parseArguments([
    'run', '--expected-head', 'abc123', '--expected-build', '31', '--confirm-external-release',
  ]), {
    command: 'run',
    options: { expectedHead: 'abc123', expectedBuild: '31', confirmExternalRelease: true },
  });
});

test('compares numeric App Store build versions', () => {
  assert.equal(compareBuildVersions('31', '30'), 1);
  assert.equal(compareBuildVersions('31.0', '31'), 0);
  assert.equal(compareBuildVersions('30', '31'), -1);
});

test('accepts only a complete safe distributor projection', () => {
  assert.deepEqual(parseDistributionState(JSON.stringify({
    lastDistributedBuildId: 'opaque-id', version: '31', distributedAt: '2026-09-06T00:00:00Z',
  })), { version: '31', distributedAt: '2026-09-06T00:00:00Z' });
  assert.throws(() => parseDistributionState('{}'), /incomplete/u);
});

test('declares privacy purpose strings required by realtime voice dependencies', async () => {
  const plist = await readFile(
    new URL('../apps/ios-app/ShannonApp/Info.plist', import.meta.url),
    'utf8',
  );
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/u);
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>/u);
});
