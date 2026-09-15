#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function workspaceProjectLocations(source) {
  return [...source.matchAll(/<FileRef\b[\s\S]*?\blocation\s*=\s*"([^"]+)"[\s\S]*?<\/FileRef>/gu)]
    .map(match => match[1]);
}

export function exactWebRTCVersion(manifest) {
  return manifest.match(/WebRTC\.git",\s*exact:\s*"([^"]+)"/u)?.[1] ?? null;
}

export function validateXcodeWorkspace(sources) {
  const failures = [];
  const expectedProjects = [
    'group:apps/ios-app/ShannonApp.xcodeproj',
    'group:apps/macos-app/ShannonDesk.xcodeproj',
  ];
  const locations = workspaceProjectLocations(sources.workspace);
  for (const project of expectedProjects) {
    if (!locations.includes(project)) failures.push(`canonical workspace is missing ${project}`);
  }

  for (const [name, project] of Object.entries(sources.projects)) {
    if (!/isa = XCLocalSwiftPackageReference;[\s\S]*?relativePath = \.\.\/ios;/u.test(project)) {
      failures.push(`${name} must reference the shared ../ios local package`);
    }
    if (!/productName = ShannonAppCore;/u.test(project)) {
      failures.push(`${name} must link the ShannonAppCore package product`);
    }
  }

  const expectedWebRTCVersion = exactWebRTCVersion(sources.manifest);
  if (!expectedWebRTCVersion) failures.push('Package.swift must pin WebRTC with an exact version');
  try {
    const resolution = JSON.parse(sources.resolution);
    const webRTC = resolution.pins?.find(pin => pin.identity === 'webrtc');
    if (expectedWebRTCVersion && webRTC?.state?.version !== expectedWebRTCVersion) {
      failures.push(`workspace resolves WebRTC ${webRTC?.state?.version ?? '(missing)'} instead of ${expectedWebRTCVersion}`);
    }
  } catch {
    failures.push('workspace Package.resolved must contain valid JSON');
  }

  if (!/workspace="Shannon\.xcworkspace"/u.test(sources.xcodeEntrypoint)) {
    failures.push('Xcode entry point must own Shannon.xcworkspace');
  }
  if (/(?:^|\s)-project(?:\s|$)/mu.test(sources.xcodeEntrypoint)) {
    failures.push('Xcode entry point must not create a separate project package graph');
  }

  for (const profile of ['ios-debug', 'ios-release', 'mac-debug', 'mac-release']) {
    if (!sources.verifier.includes(`scripts/xcode.sh ${profile}`)) {
      failures.push(`repository verifier must route ${profile} through scripts/xcode.sh`);
    }
  }
  if (/\bxcodebuild\b/u.test(sources.verifier)) {
    failures.push('repository verifier must delegate Xcode details to scripts/xcode.sh');
  }

  if (!sources.readme.includes('Shannon.xcworkspace')) {
    failures.push('README must identify Shannon.xcworkspace as the canonical Xcode entry point');
  }
  if (!sources.agentInstructions.includes('Open only `Shannon.xcworkspace` in Xcode')) {
    failures.push('agent instructions must require the canonical Xcode workspace');
  }
  return failures;
}

async function loadSources(root) {
  const paths = {
    workspace: 'Shannon.xcworkspace/contents.xcworkspacedata',
    resolution: 'Shannon.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    manifest: 'apps/ios/Package.swift',
    xcodeEntrypoint: 'scripts/xcode.sh',
    verifier: 'scripts/verify.sh',
    readme: 'README.md',
    agentInstructions: 'AGENTS.md',
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => [
    key,
    await readFile(resolve(root, path), 'utf8'),
  ]));
  return {
    ...Object.fromEntries(entries),
    projects: {
      ShannonApp: await readFile(resolve(root, 'apps/ios-app/ShannonApp.xcodeproj/project.pbxproj'), 'utf8'),
      ShannonDesk: await readFile(resolve(root, 'apps/macos-app/ShannonDesk.xcodeproj/project.pbxproj'), 'utf8'),
    },
  };
}

async function main() {
  let failures;
  try {
    failures = validateXcodeWorkspace(await loadSources(repositoryRoot));
  } catch (error) {
    failures = [`unable to load canonical Xcode configuration: ${error.message}`];
  }
  if (failures.length > 0) {
    console.error('Xcode workspace guard failed:');
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log('Xcode workspace guard passed (2 projects, 1 shared package graph, 4 build profiles).');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
