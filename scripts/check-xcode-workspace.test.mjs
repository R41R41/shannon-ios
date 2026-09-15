import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateXcodeWorkspace, workspaceProjectLocations } from './check-xcode-workspace.mjs';

const xcodeEntrypoint = fileURLToPath(new URL('./xcode.sh', import.meta.url));

function validSources() {
  return {
    workspace: `
      <Workspace version="1.0">
        <FileRef location="group:apps/ios-app/ShannonApp.xcodeproj"></FileRef>
        <FileRef location="group:apps/macos-app/ShannonDesk.xcodeproj"></FileRef>
      </Workspace>
    `,
    resolution: JSON.stringify({
      pins: [{ identity: 'webrtc', state: { version: '152.0.0' } }],
    }),
    manifest: '.package(url: "https://github.com/stasel/WebRTC.git", exact: "152.0.0")',
    projects: {
      ShannonApp: 'isa = XCLocalSwiftPackageReference; relativePath = ../ios; productName = ShannonAppCore;',
      ShannonDesk: 'isa = XCLocalSwiftPackageReference; relativePath = ../ios; productName = ShannonAppCore;',
    },
    xcodeEntrypoint: 'workspace="Shannon.xcworkspace"',
    verifier: [
      'scripts/xcode.sh ios-debug',
      'scripts/xcode.sh ios-release',
      'scripts/xcode.sh mac-debug',
      'scripts/xcode.sh mac-release',
    ].join('\n'),
    readme: 'Open Shannon.xcworkspace.',
    agentInstructions: 'Open only `Shannon.xcworkspace` in Xcode.',
  };
}

test('extracts project locations without depending on XML whitespace', () => {
  assert.deepEqual(workspaceProjectLocations(validSources().workspace), [
    'group:apps/ios-app/ShannonApp.xcodeproj',
    'group:apps/macos-app/ShannonDesk.xcodeproj',
  ]);
});

test('accepts the canonical shared package graph', () => {
  assert.deepEqual(validateXcodeWorkspace(validSources()), []);
});

test('reports structural drift in one pass', () => {
  const sources = validSources();
  sources.workspace = '<Workspace><FileRef location="group:apps/ios-app/ShannonApp.xcodeproj"></FileRef></Workspace>';
  sources.resolution = JSON.stringify({ pins: [{ identity: 'webrtc', state: { version: '151.0.0' } }] });
  sources.projects.ShannonDesk = 'productName = OtherCore;';
  sources.xcodeEntrypoint += '\nxcodebuild -project apps/ios-app/ShannonApp.xcodeproj';
  sources.verifier += '\nxcodebuild -project apps/macos-app/ShannonDesk.xcodeproj';

  assert.deepEqual(validateXcodeWorkspace(sources), [
    'canonical workspace is missing group:apps/macos-app/ShannonDesk.xcodeproj',
    'ShannonDesk must reference the shared ../ios local package',
    'ShannonDesk must link the ShannonAppCore package product',
    'workspace resolves WebRTC 151.0.0 instead of 152.0.0',
    'Xcode entry point must not create a separate project package graph',
    'repository verifier must delegate Xcode details to scripts/xcode.sh',
  ]);
});

test('all build profiles use the canonical workspace with isolated DerivedData', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'shannon-xcode-entrypoint-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stub = join(temporaryDirectory, 'xcodebuild-stub.sh');
  await writeFile(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SHANNON_XCODE_CAPTURE"\n');
  await chmod(stub, 0o755);

  const profiles = {
    'ios-debug': ['ShannonApp', 'Debug', 'generic/platform=iOS', '.build/SelfImprovementDerivedData', 'build'],
    'ios-release': ['ShannonApp', 'Release', 'generic/platform=iOS', '.build/ReleaseRunnerDerivedData', 'build'],
    'mac-debug': ['ShannonDesk', 'Debug', 'platform=macOS', '.build/ShannonDeskDerivedData', 'test'],
    'mac-release': ['ShannonDesk', 'Release', 'generic/platform=macOS', '.build/ShannonDeskReleaseDerivedData', 'build'],
  };

  for (const [profile, [scheme, configuration, destination, derivedData, action]] of Object.entries(profiles)) {
    const capture = join(temporaryDirectory, `${profile}.txt`);
    const result = spawnSync(xcodeEntrypoint, [profile], {
      encoding: 'utf8',
      env: { ...process.env, SHANNON_XCODEBUILD_BIN: stub, SHANNON_XCODE_CAPTURE: capture },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'), [
      '-workspace', 'Shannon.xcworkspace',
      '-scheme', scheme,
      '-configuration', configuration,
      '-destination', destination,
      '-derivedDataPath', derivedData,
      'CODE_SIGNING_ALLOWED=NO', action,
    ]);
  }
});

test('inspection and package resolution profiles stay in the canonical workspace', async t => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'shannon-xcode-resolution-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const stub = join(temporaryDirectory, 'xcodebuild-stub.sh');
  await writeFile(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SHANNON_XCODE_CAPTURE"\n');
  await chmod(stub, 0o755);

  const profiles = {
    list: ['-workspace', 'Shannon.xcworkspace', '-list'],
    'resolve-ios': ['-workspace', 'Shannon.xcworkspace', '-scheme', 'ShannonApp', '-resolvePackageDependencies'],
    'resolve-mac': ['-workspace', 'Shannon.xcworkspace', '-scheme', 'ShannonDesk', '-resolvePackageDependencies'],
  };
  for (const [profile, expectedArguments] of Object.entries(profiles)) {
    const capture = join(temporaryDirectory, `${profile}.txt`);
    const result = spawnSync(xcodeEntrypoint, [profile], {
      encoding: 'utf8',
      env: { ...process.env, SHANNON_XCODEBUILD_BIN: stub, SHANNON_XCODE_CAPTURE: capture },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'), expectedArguments);
  }
});

test('unknown build profiles fail before invoking Xcode', () => {
  const result = spawnSync(xcodeEntrypoint, ['unknown-profile'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: scripts\/xcode\.sh/u);
});
