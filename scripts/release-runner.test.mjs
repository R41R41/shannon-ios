import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  compareBuildVersions,
  distributionBelongsToRelease,
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

test('accepts a distribution only when it belongs to the current publish', () => {
  assert.equal(distributionBelongsToRelease({
    version: '31', distributedAt: '2026-09-06T00:05:00Z',
  }, '31', '2026-09-06T00:00:00Z'), true);
  assert.equal(distributionBelongsToRelease({
    version: '31', distributedAt: '2026-09-05T23:55:00Z',
  }, '31', '2026-09-06T00:00:00Z'), false);
  assert.equal(distributionBelongsToRelease({
    version: '30', distributedAt: '2026-09-06T00:05:00Z',
  }, '31', '2026-09-06T00:00:00Z'), false);
  assert.throws(() => distributionBelongsToRelease({
    version: '31', distributedAt: 'not-a-date',
  }, '31', '2026-09-06T00:00:00Z'), /timestamps/u);
});

test('declares privacy purpose strings required by realtime voice dependencies', async () => {
  const plist = await readFile(
    new URL('../apps/ios-app/ShannonApp/Info.plist', import.meta.url),
    'utf8',
  );
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>/u);
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>/u);
});

test('pins the first WebRTC release with official dSYMs and includes them in archives', async () => {
  const manifest = await readFile(new URL('../apps/ios/Package.swift', import.meta.url), 'utf8');
  const project = await readFile(
    new URL('../apps/ios-app/ShannonApp.xcodeproj/project.pbxproj', import.meta.url),
    'utf8',
  );
  const symbolScript = await readFile(new URL('./copy-webrtc-dsym.sh', import.meta.url), 'utf8');

  assert.match(manifest, /WebRTC\.git", exact: "152\.0\.0"/u);
  assert.match(project, /Include WebRTC dSYM/u);
  assert.match(project, /copy-webrtc-dsym\.sh/u);
  assert.match(project, /Shannon-WebRTC-M152-dSYM\.zip/u);
  assert.match(symbolScript, /WebRTC-M152-dSYM\.zip/u);
  assert.match(symbolScript, /7c99e7cc12b59e4db357581271b412e9ce031ce21a23590a909f7ae1f0b20f87/u);
  assert.match(symbolScript, /dwarfdump --uuid/u);
  assert.match(symbolScript, /cp "\$source_dwarf" "\$destination_dwarf"/u);
  assert.match(symbolScript, /cp "\$source_info" "\$destination_info"/u);
  assert.match(symbolScript, /cp "\$source_relocations" "\$destination_relocations"/u);
  assert.doesNotMatch(symbolScript, /ditto "\$source_dsym" "\$destination_dsym"/u);
  assert.doesNotMatch(symbolScript, /mv "\$staged_dsym" "\$destination_dsym"/u);
});
