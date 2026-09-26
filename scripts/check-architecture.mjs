import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function filesBelow(directory, extensions) {
  const absolute = resolve(root, directory);
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) return filesBelow(relative(root, path), extensions);
    return extensions.has(extname(entry.name)) ? [path] : [];
  });
}

function source(path) { return readFileSync(path, 'utf8'); }
function projectPath(path) { return relative(root, path); }
function fail(message) { failures.push(message); }

const productionSources = [
  ...filesBelow('apps/ios/Sources', new Set(['.swift'])),
  ...filesBelow('apps/macos-app/ShannonDesk', new Set(['.swift'])),
  ...filesBelow('services/api/src', new Set(['.ts'])),
  ...filesBelow('packages/cognition/src', new Set(['.ts'])),
];

for (const path of productionSources) {
  const lines = source(path).split(/\r?\n/u).length - 1;
  if (lines > 500) fail(`${projectPath(path)} has ${lines} lines (maximum 500)`);
}

const legacyMonoliths = [
  'apps/ios/Sources/ShannonAppCore/Models.swift',
  'apps/ios/Sources/ShannonAppCore/ShannonAPIClient.swift',
  'apps/ios/Sources/ShannonAppCore/ShannonConnection.swift',
  'apps/ios/Sources/ShannonAppCore/ShannonConversationModel.swift',
  'apps/ios/Sources/ShannonAppCore/ShannonConversationView.swift',
  'apps/ios/Sources/ShannonAppCore/ShannonMemoryView.swift',
  'apps/ios/Sources/ShannonAppCore/ShannonRealtimeVoice.swift',
  'apps/macos-app/ShannonDesk/ShannonDesktopView.swift',
  'apps/ios/Sources/ShannonAppCore/Material3Theme.swift',
];
for (const path of legacyMonoliths) if (existsSync(resolve(root, path))) fail(`${path} must remain split by responsibility`);

const swiftFiles = productionSources.filter(path => extname(path) === '.swift');
const webRTCAdapterFiles = new Set([
  'WebRTCVoiceTransport.swift',
  'ShannonPitchShiftRTCAudioDevice.swift',
]);
for (const path of swiftFiles) {
  const imports = source(path);
  for (const legacyToken of ['M3Palette', 'M3Spacing', 'M3Shape', 'M3TouchTarget']) {
    if (imports.includes(legacyToken)) fail(`${projectPath(path)} uses legacy design token ${legacyToken}`);
  }
  if (/\bColor\.(?:red|orange|green)\b/u.test(imports)
      || /\.(?:foregroundStyle|tint|background|fill|stroke)\(\.(?:red|orange|green)\b/u.test(imports)
      || /\breturn \.(?:red|orange|green)\b/u.test(imports)) {
    fail(`${projectPath(path)} bypasses Shannon semantic status colors`);
  }
  if (imports.includes('import WebRTC') && !webRTCAdapterFiles.has(basename(path))) {
    fail(`${projectPath(path)} imports WebRTC outside the transport adapter`);
  }
  if (imports.includes('import Security') && basename(path) !== 'ShannonConnectionKeychainStore.swift') {
    fail(`${projectPath(path)} imports Security outside the Keychain adapter`);
  }
}

const apiDirectory = resolve(root, 'apps/ios/Sources/ShannonAppCore/API');
for (const path of filesBelow(relative(root, apiDirectory), new Set(['.swift']))) {
  const imports = source(path);
  for (const framework of ['SwiftUI', 'UIKit', 'AppKit', 'WebRTC', 'Security']) {
    if (imports.includes(`import ${framework}`)) fail(`${projectPath(path)} couples the API adapter to ${framework}`);
  }
}

const conversationRoot = source(resolve(
  root,
  'apps/ios/Sources/ShannonAppCore/Features/Conversation/ShannonConversationView.swift',
));
const conversationWorkspace = source(resolve(
  root,
  'apps/ios/Sources/ShannonAppCore/Features/Conversation/ShannonConversationView+Workspace.swift',
));
const threadListSheet = source(resolve(
  root,
  'apps/ios/Sources/ShannonAppCore/Features/Conversation/ShannonThreadListSheet.swift',
));

for (const [label, text, requiredTokens] of [
  ['iPhone conversation root', conversationRoot, ['NavigationStack', '.navigationTitle(', '.toolbar { workspaceToolbar }', '.sheet(isPresented: $showsThreadList)']],
  ['iPhone Talk workspace', conversationWorkspace, ['switch selectedPage', '.safeAreaInset(edge: .bottom', '.background(.bar)']],
  ['iPhone thread list', threadListSheet, ['NavigationStack', 'List {', '.searchable(', '.toolbar {']],
]) {
  for (const token of requiredTokens) {
    if (!text.includes(token)) fail(`${label} must keep Apple-native ${token}`);
  }
}

for (const legacyToken of ['drawerProgress', 'ShannonAppHeader', 'ShannonWorkspaceMotion']) {
  if (conversationRoot.includes(legacyToken) || conversationWorkspace.includes(legacyToken) || threadListSheet.includes(legacyToken)) {
    fail(`iPhone conversation navigation reintroduced legacy custom chrome ${legacyToken}`);
  }
}

for (const legacyPath of [
  'apps/ios/Sources/ShannonAppCore/ShannonWorkspaceMotion.swift',
  'apps/ios/Sources/ShannonAppCore/Features/Conversation/ShannonThreadDrawer.swift',
]) {
  if (existsSync(resolve(root, legacyPath))) fail(`${legacyPath} must remain replaced by native navigation`);
}

const macProject = source(resolve(root, 'apps/macos-app/ShannonDesk.xcodeproj/project.pbxproj'));
for (const path of filesBelow('apps/macos-app/ShannonDesk', new Set(['.swift']))) {
  if (!macProject.includes(basename(path))) fail(`${projectPath(path)} is missing from the generated Mac project`);
}

if (failures.length) {
  console.error('Architecture guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture guard passed (${productionSources.length} production source files, 500-line ceiling).`);
}
