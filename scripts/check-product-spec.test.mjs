import assert from 'node:assert/strict';
import test from 'node:test';

import {
  openCells, repository, run, validateBaseline, validateMatrix, validateStrings, validateTokens,
} from './check-product-spec.mjs';
import {
  outputs, readSources, renderStringsSwift, renderStringsTs, renderTokensCss, renderTokensSwift, staleOutputs, stringParams, swiftIdentifier, swiftLiteral,
} from './generate-product-spec.mjs';

/** A repository that holds exactly the given files. */
function fakeRepository(files, directories = {}) {
  return {
    exists: (path) => path in files,
    text: (path) => (path in files ? files[path] : null),
    directories: (path) => directories[path] ?? [],
  };
}

function feature(overrides = {}) {
  return {
    id: 'talk.text-chat',
    area: 'talk',
    title: '文字で話す',
    description: 'メッセージを送り、返事を読む。',
    surfaces: {
      ios: { status: 'yes', evidence: ['apps/ios/Talk.swift'] },
      macos: { status: 'yes', evidence: ['apps/mac/Talk.swift#DesktopComposer'] },
      windows: { status: 'yes', evidence: ['shannon-desktop:src/desk/views/TalkView.tsx'], read: '2026-10-03' },
    },
    ...overrides,
  };
}

function matrix(features) {
  return {
    version: 1,
    baseline: { apple: { commit: 'abc1234', date: '2026-10-03' }, windows: { source: 'somewhere', read: '2026-10-03' } },
    areas: [{ id: 'talk', title: 'トーク' }, { id: 'desktop', title: 'デスクトップ' }],
    features,
  };
}

const files = { 'apps/ios/Talk.swift': 'struct Talk {}', 'apps/mac/Talk.swift': 'struct DesktopComposer {}' };

test('the generated token, string and matrix files are up to date', () => {
  assert.deepEqual(staleOutputs(), []);
});

test('the product spec of this repository passes its own check', () => {
  const result = run();
  assert.deepEqual(result.failures, []);
});

test('every generated file is produced from the three sources', () => {
  assert.deepEqual(Object.keys(outputs(readSources())).sort(), [
    // The same Swift, compiled into the shared Apple package (A3).
    'apps/ios/Sources/ShannonAppCore/DesignSystem/Generated/ShannonDesignTokens.generated.swift',
    'apps/ios/Sources/ShannonAppCore/DesignSystem/Generated/ShannonStrings.generated.swift',
    'design/generated/ShannonDesignTokens.generated.swift',
    'design/generated/ShannonStrings.generated.swift',
    'design/generated/shannon-strings.ja.ts',
    'design/generated/shannon-tokens.css',
    'design/generated/shannon-tokens.ts',
    'docs/product/feature-matrix.md',
  ]);
});

test('a complete feature passes, and has no open cell', () => {
  const value = matrix([feature()]);
  assert.deepEqual(validateMatrix(value, fakeRepository(files)).failures, []);
  assert.deepEqual(openCells(value), []);
});

test('a feature listed as present fails when its code is gone', () => {
  const { failures } = validateMatrix(matrix([feature()]), fakeRepository({ 'apps/mac/Talk.swift': files['apps/mac/Talk.swift'] }));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /talk\.text-chat ios: evidence apps\/ios\/Talk\.swift does not exist/u);
});

test('a named symbol must still be in the file', () => {
  const { failures } = validateMatrix(matrix([feature()]), fakeRepository({ ...files, 'apps/mac/Talk.swift': 'struct Other {}' }));
  assert.match(failures.join('\n'), /no longer contains DesktopComposer/u);
});

test('ids are unique and each status carries what it requires', () => {
  const broken = feature({
    surfaces: {
      ios: { status: 'yes', evidence: [] },
      macos: { status: 'partial', evidence: ['apps/mac/Talk.swift'] },
      windows: { status: 'yes', evidence: ['src/desk/views/TalkView.tsx'] },
    },
  });
  const other = feature({
    surfaces: {
      ios: { status: 'planned' },
      macos: { status: 'not_applicable' },
      windows: { status: 'unknown' },
    },
  });
  const text = validateMatrix(matrix([broken, other]), fakeRepository(files)).failures.join('\n');
  assert.match(text, /the id is used twice/u);
  assert.match(text, /ios: yes needs at least one evidence entry/u);
  assert.match(text, /macos: partial needs a note/u);
  assert.match(text, /Windows evidence must be "shannon-desktop:<path>"/u);
  assert.match(text, /Windows evidence needs the date it was read/u);
  assert.match(text, /planned needs the branch/u);
  assert.match(text, /not_applicable needs a reason/u);
  assert.match(text, /unknown needs a note/u);
});

test('a feature folder that no cell names fails: a feature went in without the spec', () => {
  const repo = fakeRepository(files, { 'apps/ios/Sources/ShannonAppCore/Features': ['apps/ios/Sources/ShannonAppCore/Features/Secret'] });
  assert.match(validateMatrix(matrix([feature()]), repo).failures.join('\n'), /Features\/Secret: no cell of the feature matrix names this feature folder/u);
});

test('a planned cell warns once its code has arrived', () => {
  const value = matrix([feature({ surfaces: { ...feature().surfaces, ios: { status: 'planned', branch: 'codex/x', whenMerged: ['apps/ios/Talk.swift'] } } })]);
  const result = validateMatrix(value, fakeRepository(files));
  assert.deepEqual(result.failures, []);
  assert.match(result.warnings[0], /planned, but apps\/ios\/Talk\.swift now exists/u);
});

test('a new gap fails until it is accepted, and a closed gap must leave the baseline', () => {
  const value = matrix([feature({ surfaces: { ...feature().surfaces, windows: { status: 'no' } } })]);
  assert.deepEqual(openCells(value), ['talk.text-chat windows no']);
  assert.match(validateBaseline(value, { open: [] }).join('\n'), /new gap not yet accepted: talk\.text-chat windows no/u);
  assert.deepEqual(validateBaseline(value, { open: ['talk.text-chat windows no'] }), []);
  assert.match(validateBaseline(matrix([feature()]), { open: ['talk.text-chat windows no'] }).join('\n'), /gap closed or changed/u);
});

test('a desktop extra is not counted as a gap of the phone', () => {
  const extra = feature({ id: 'desktop.tray', area: 'desktop', scope: 'desktop', surfaces: { ...feature().surfaces, ios: { status: 'not_applicable', reason: 'no tray on a phone' } } });
  const value = matrix([extra]);
  assert.deepEqual(validateMatrix(value, fakeRepository(files)).failures, []);
  assert.deepEqual(openCells(value), []);
});

const tokens = {
  color: {
    roles: { action: { meaning: '押せるもの', light: '#0088FF', dark: '#0091ff', swift: 'action' } },
    fixed: { intelligenceSky: { meaning: '目', value: '#78D9FF', swift: 'sky' } },
  },
  typography: { fontFamily: { sans: ['system-ui', 'Yu Gothic UI'], mono: ['monospace'] }, scale: { body: { size: 17, lineHeight: 22, weight: 400, swiftTextStyle: 'body' } }, weight: { regular: 400 } },
  spacing: { small: 8 },
  radius: { small: 8 },
  size: { touchTargetMinimum: 48 },
  motion: { duration: { quick: { seconds: 0.15, meaning: '押した手応え' } } },
};
const designSystem = `enum ShannonColorTokens {
    enum Intelligence {
        static let sky: UInt = 0x78D9FF
    }

    enum Light {
        static let action: UInt = 0x0088FF
    }

    enum Dark {
        static let action: UInt = 0x0091FF
    }
}

enum ShannonSpacing {
    static let small: CGFloat = 8
}

enum ShannonShape {
    static let small: CGFloat = 8
}

enum ShannonTouchTarget {
    static let minimum: CGFloat = 48
}
`;
const designPath = 'apps/ios/Sources/ShannonAppCore/DesignSystem/ShannonDesignSystem.swift';

test('tokens equal to the iOS values pass; a drifted value and a brand role fail', () => {
  assert.deepEqual(validateTokens(tokens, fakeRepository({ [designPath]: designSystem })), []);
  const drifted = structuredClone(tokens);
  drifted.color.roles.action.light = '#3D8FE0';
  drifted.color.roles.brandPresence = { meaning: 'x', light: '#000000', dark: '#000000', swift: 'action' };
  const text = validateTokens(drifted, fakeRepository({ [designPath]: designSystem })).join('\n');
  assert.match(text, /role action \(light\) is #3D8FE0 but the iOS app uses #0088FF/u);
  assert.match(text, /role brandPresence names a brand/u);
});

test('tokens render to Swift and CSS with light and dark values', () => {
  const swift = renderTokensSwift(tokens);
  assert.match(swift, /public static let action: UInt = 0x0088FF/u);
  assert.match(swift, /public static let action: UInt = 0x0091FF/u);
  assert.match(swift, /public static let small: CGFloat = 8/u);
  assert.match(swift, /public static let quick: Double = 0\.15/u);
  const css = renderTokensCss(tokens);
  assert.match(css, /--shannon-color-action: #0088FF;/u);
  assert.match(css, /prefers-color-scheme: dark/u);
  assert.match(css, /--shannon-font-sans: system-ui, "Yu Gothic UI";/u);
  assert.match(css, /--shannon-duration-quick: 150ms;/u);
  assert.match(css, /--shannon-size-touch-target-minimum: 48px;/u);
});

const strings = {
  windowsRead: '2026-10-03',
  strings: [
    { key: 'ops.status.running', text: '動いている', apple: 'branch:codex/shannon/ios-yousu:Ops.swift', windows: 'shannon-desktop:src/desk/opsText.ts' },
    { key: 'ops.confirm.stop', text: '{name} を停止しますか？\n\n止めている間、この機能は動きません。', apple: 'Ops.swift', windows: 'shannon-desktop:src/desk/opsText.ts', verbatim: true },
  ],
};

test('strings render to Swift and TypeScript, with placeholders as parameters', () => {
  assert.equal(swiftIdentifier('ops.confirm.scheduleRun.question'), 'opsConfirmScheduleRunQuestion');
  assert.deepEqual(stringParams('{hours} 時間ごと（{minute} 分）'), ['hours', 'minute']);
  assert.equal(swiftLiteral('「{name}」\n"x"'), '"「\\(name)」\\n\\"x\\""');
  const swift = renderStringsSwift(strings);
  assert.match(swift, /public static let opsStatusRunning = "動いている"/u);
  assert.match(swift, /public static func opsConfirmStop\(name: String\) -> String \{ "\\\(name\) を停止しますか？\\n\\n止めている間、この機能は動きません。" \}/u);
  const ts = renderStringsTs(strings);
  assert.match(ts, /"ops\.status\.running": "動いている",/u);
  assert.match(ts, /shannonVerbatimKeys: readonly ShannonStringKey\[\] = \[\n {2}"ops\.confirm\.stop"\n\]/u);
});

test('a shared string must still be written in the Apple source it names', () => {
  const present = fakeRepository({ 'Ops.swift': '"\\(name) を停止しますか？\\n\\n止めている間、この機能は動きません。"' });
  assert.deepEqual(validateStrings(strings, present), []);
  const reworded = fakeRepository({ 'Ops.swift': '"\\(name) を止めますか？"' });
  assert.match(validateStrings(strings, reworded).join('\n'), /ops\.confirm\.stop says "を停止しますか？", which Ops\.swift no longer contains/u);
  const duplicate = { ...strings, strings: [...strings.strings, strings.strings[0]] };
  assert.match(validateStrings(duplicate, present).join('\n'), /key ops\.status\.running is used twice/u);
});

test('the desktop type scale is generated and must not exceed the phone scale', () => {
  const desktop = structuredClone(tokens);
  desktop.typography.desktop = { scale: { body: { size: 15, lineHeight: 20, weight: 400 } } };
  assert.deepEqual(validateTokens(desktop, fakeRepository({ [designPath]: designSystem })), []);
  assert.match(renderTokensSwift(desktop), /public enum DesktopTypography \{\n {8}public static let body = TextStyle\(size: 15, lineHeight: 20, weight: 400, swiftTextStyle: "body"\)/u);
  const css = renderTokensCss(desktop);
  assert.match(css, /--shannon-desktop-font-size-body: 15px;/u);
  assert.match(css, /:root\[data-shannon-density="desktop"\] \{\n {2}--shannon-font-size-body: 15px;/u);
  desktop.typography.desktop.scale.body.size = 18;
  assert.match(validateTokens(desktop, fakeRepository({ [designPath]: designSystem })).join('\n'), /typography\.desktop body is larger than the phone size/u);
});

test('decided wording says what Windows shows today, and may be new on the Apple side', () => {
  const decided = {
    windowsRead: '2026-10-03',
    strings: [
      { key: 'task.status.proposed', text: '提案', apple: 'Status.swift', decided: '2026-10-03', windowsNow: '作業候補' },
      { key: 'nav.admin', text: '管理', apple: 'new', decided: '2026-10-03', windowsNow: '（無い）' },
    ],
  };
  const repo = fakeRepository({ 'Status.swift': 'case .proposed: "提案"' });
  assert.deepEqual(validateStrings(decided, repo), []);
  assert.match(renderStringsTs(decided), /"task\.status\.proposed": \{\n {4}"decided": "2026-10-03",\n {4}"windowsBefore": "作業候補"/u);
  const undecided = { ...decided, strings: [{ key: 'nav.admin', text: '管理', apple: 'new', windows: 'shannon-desktop:src/desk/App.tsx' }] };
  assert.match(validateStrings(undecided, repo).join('\n'), /only decided wording may be new/u);
  const missing = { ...decided, strings: [{ key: 'task.status.proposed', text: '提案', apple: 'Status.swift', decided: '2026-10-03' }] };
  assert.match(validateStrings(missing, repo).join('\n'), /is decided and needs windowsNow/u);
});

test('an Apple-only sentence needs no Windows place but must be in its Apple source', () => {
  const repo = fakeRepository({ 'Hub.swift': '.accessibilityHint("ようすを開きます")' });
  const only = (entry) => ({ windowsRead: '2026-10-03', strings: [{ key: 'hub.cardHint', text: 'ようすを開きます', apple: 'Hub.swift', only: 'apple', ...entry }] });
  assert.deepEqual(validateStrings(only({}), repo), []);
  assert.match(validateStrings(only({ apple: 'new' }), repo).join('\n'), /Apple-only and needs the Apple source/u);
  assert.match(validateStrings(only({ windows: 'shannon-desktop:x.ts' }), repo).join('\n'), /Apple-only and names a Windows place/u);
  assert.match(validateStrings(only({ text: 'ほかの文' }), repo).join('\n'), /no longer contains/u);
  assert.match(validateStrings(only({ only: 'windows' }), repo).join('\n'), /only must be "apple"/u);
});

test('the repository reader lists feature folders', () => {
  const folders = repository().directories('apps/ios/Sources/ShannonAppCore/Features');
  assert.ok(folders.includes('apps/ios/Sources/ShannonAppCore/Features/Conversation'));
});
