#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const iosAssets = resolve(root, 'apps/ios-app/ShannonApp/Assets.xcassets');
const macAssets = resolve(root, 'apps/macos-app/ShannonDesk/Assets.xcassets');
const previews = resolve(root, 'apps/ios/Sources/ShannonAppCore/Resources');
const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function filesBelow(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesBelow(resolve(directory, entry.name), relative)
      : [relative];
  }));
  return files.flat().sort();
}

async function treeDigest(directory) {
  const lines = await Promise.all((await filesBelow(directory)).map(async relative => {
    const digest = sha256(await readFile(resolve(directory, relative)));
    return `${digest}  ./${relative}\n`;
  }));
  return sha256(lines.join(''));
}

function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function pngHasAlpha(buffer) {
  return buffer.length >= 26 && [4, 6].includes(buffer[25]);
}

async function validateCatalog(directory, expectedTree, expectedIdiom) {
  const failures = [];
  const contents = JSON.parse(await readFile(resolve(directory, 'Contents.json'), 'utf8'));
  for (const image of contents.images ?? []) {
    if (!image.filename) continue;
    const buffer = await readFile(resolve(directory, image.filename));
    const size = pngSize(buffer);
    const points = Number(image.size?.split('x')[0]);
    const scale = Number(image.scale?.replace('x', '') ?? 1);
    const expectedPixels = points * scale;
    if (!size || size.width !== expectedPixels || size.height !== expectedPixels) {
      failures.push(`${directory}/${image.filename} must be ${expectedPixels}x${expectedPixels}`);
    }
    if (image.idiom !== expectedIdiom) failures.push(`${directory}/${image.filename} has the wrong idiom`);
    if (expectedIdiom === 'mac' && !pngHasAlpha(buffer)) {
      failures.push(`${directory}/${image.filename} must preserve transparent macOS icon corners`);
    }
  }
  const actualTree = await treeDigest(directory);
  if (actualTree !== expectedTree) failures.push(`${directory} differs from the approved source package`);
  return failures;
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(root, 'config/shannon-app-icons.json'), 'utf8'));
  const failures = [];
  const levels = Object.keys(manifest.variants);
  if (levels.join(',') !== 'L02,L06,L10' || manifest.defaultVariant !== 'L06') {
    failures.push('icon manifest must expose only L02, L06, and L10 with L06 as default');
  }
  if (manifest.macosRendering?.alphaMask !== 'roundedRectangle'
      || manifest.macosRendering?.cornerRadiusRatio !== 0.223
      || manifest.macosRendering?.bodyScale !== 0.84375) {
    failures.push('macOS icons must use the reproducible 84.375% rounded-rectangle layout');
  }

  try {
    await execFileAsync('swift', ['scripts/apply-macos-icon-mask.swift', '--check'], {
      cwd: root,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    failures.push(`macOS icon visual footprint check failed: ${error.stderr || error.message}`);
  }

  for (const [platform, directory] of [['iOS', iosAssets], ['macOS', macAssets]]) {
    const catalogs = (await readdir(directory)).filter(name => name.endsWith('.appiconset')).sort();
    const expected = levels.map(level => `${manifest.variants[level].assetName}.appiconset`).sort();
    if (catalogs.join(',') !== expected.join(',')) {
      failures.push(`${platform} must contain exactly the three approved app icon catalogs`);
    }
  }

  for (const [level, variant] of Object.entries(manifest.variants)) {
    const preview = await readFile(resolve(previews, `${variant.assetName}-1024.png`));
    if (sha256(preview) !== variant.masterSha256) failures.push(`${level} preview does not match its approved master`);
    const size = pngSize(preview);
    if (!size || size.width !== 1024 || size.height !== 1024) failures.push(`${level} master preview must be 1024x1024`);
    failures.push(...await validateCatalog(
      resolve(iosAssets, `${variant.assetName}.appiconset`),
      variant.iosTreeSha256,
      'universal',
    ));
    failures.push(...await validateCatalog(
      resolve(macAssets, `${variant.assetName}.appiconset`),
      variant.macosTreeSha256,
      'mac',
    ));
  }

  const [iosProject, macProject, iosInfo, macInfo, generator] = await Promise.all([
    readFile(resolve(root, 'apps/ios-app/ShannonApp.xcodeproj/project.pbxproj'), 'utf8'),
    readFile(resolve(root, 'apps/macos-app/ShannonDesk.xcodeproj/project.pbxproj'), 'utf8'),
    readFile(resolve(root, 'apps/ios-app/ShannonApp/Info.plist'), 'utf8'),
    readFile(resolve(root, 'apps/macos-app/ShannonDesk/Info.plist'), 'utf8'),
    readFile(resolve(root, 'scripts/generate-macos-project.rb'), 'utf8'),
  ]);
  for (const [source, label, value] of [
    [iosProject, 'iOS primary icon', 'ASSETCATALOG_COMPILER_APPICON_NAME = ShannonL06;'],
    [macProject, 'macOS primary icon', 'ASSETCATALOG_COMPILER_APPICON_NAME = ShannonL06;'],
    [iosProject, 'iOS build', `CURRENT_PROJECT_VERSION = ${manifest.release.iosBuild};`],
    [macProject, 'macOS build', `CURRENT_PROJECT_VERSION = ${manifest.release.macosBuild};`],
    [generator, 'Mac project generator primary icon', "ASSETCATALOG_COMPILER_APPICON_NAME'] = 'ShannonL06'"],
    [generator, 'Mac project generator build', `CURRENT_PROJECT_VERSION'] = '${manifest.release.macosBuild}'`],
  ]) {
    if (!source.includes(value)) failures.push(`${label} is not ${value}`);
  }
  for (const source of [iosInfo, macInfo]) {
    if (!source.includes(`<string>${manifest.displayName}</string>`)) failures.push('Apple app display name must be シャノン');
  }
  if (!macInfo.includes('<key>CFBundleName</key>\n\t<string>シャノン</string>')) {
    failures.push('macOS bundle name must be シャノン');
  }
  for (const assetName of ['ShannonL02', 'ShannonL10']) {
    if (!iosProject.includes(assetName) || !iosInfo.includes(`<key>${assetName}</key>`)) {
      failures.push(`iOS alternate icon ${assetName} must be registered`);
    }
  }

  if (failures.length) {
    console.error('Shannon app icon check failed:');
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exitCode = 1;
    return;
  }
  console.log(`Shannon app icon check passed (${levels.join(', ')}, iOS ${manifest.release.iosBuild}, macOS ${manifest.release.macosBuild}).`);
}

await main();
