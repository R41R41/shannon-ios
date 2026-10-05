#!/usr/bin/env node
// Guards the one product spec that the iOS, macOS and Windows apps of Shannon follow (Syzygy ADR-0004).
// It fails when
//   - the feature matrix is malformed, an id repeats, or a cell lacks what its status requires;
//   - a feature or a string brings back something the owner decided not to build (notBuilding);
//   - an iOS or macOS cell says `yes` or `partial` but its evidence (a source path, optionally `#Symbol`) is gone;
//   - a feature folder of the Apple apps is not named by any cell (a feature added without the matrix);
//   - the set of cells that are behind (`no`, `partial`, `planned`, `unknown`) differs from the accepted baseline;
//   - the design tokens drift from the values the iOS app uses today, or break the no-brand-colour rule;
//   - a shared string is no longer in the Apple source it names (a Windows-only one needs its Windows place);
//   - a generated file is stale.
// `--accept-gaps` rewrites the baseline after the owner has decided about a new gap or a gap has closed.
// See docs/product/README.md.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSources, sourcePaths, staleOutputs, statuses, stringParams, surfaces, swiftIdentifier } from './generate-product-spec.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const baselinePath = 'docs/product/parity-baseline.json';
export const windowsPrefix = 'shannon-desktop:';
const appleSurfaces = ['ios', 'macos'];
const featureFolders = ['apps/ios/Sources/ShannonAppCore/Features', 'apps/macos-app/ShannonDesk/Features'];
const iosDesignSystem = 'apps/ios/Sources/ShannonAppCore/DesignSystem/ShannonDesignSystem.swift';
const idPattern = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const hexPattern = /^#[0-9A-Fa-f]{6}$/u;
const stringKeyPattern = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u;

function isText(value) { return typeof value === 'string' && value.trim().length > 0; }

/** Text as it is compared with the not-built list: full and half width alike, case and spacing and separators ignored. */
export function normalisedForSearch(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-_.・･]/gu, '');
}

/** Whether any of the texts names an item the owner decided not to build, by its name or one of its aliases. */
export function notBuildingMatch(item, texts) {
  const terms = [item?.name, ...(item?.aliases ?? [])].filter(isText).map(normalisedForSearch);
  const haystack = texts.filter(isText).map(normalisedForSearch);
  return terms.some((term) => haystack.some((text) => text.includes(term)));
}
function repositoryPath(value) { return isText(value) && !value.startsWith('/') && !value.split('/').includes('..'); }

/** A file reader over the repository: `exists(path)` and `text(path)` (null when absent). */
export function repository(root = defaultRoot) {
  return {
    exists: (path) => existsSync(resolve(root, path)),
    text: (path) => (existsSync(resolve(root, path)) ? readFileSync(resolve(root, path), 'utf8') : null),
    directories: (path) => (existsSync(resolve(root, path))
      ? readdirSync(resolve(root, path), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `${path}/${entry.name}`)
      : []),
  };
}

// ---------------------------------------------------------------- feature matrix

function validateCell(feature, surface, cell, repo, failures, warnings) {
  const where = `${feature.id} ${surface}`;
  if (!cell || typeof cell !== 'object') { failures.push(`${where}: the cell is missing`); return; }
  if (!statuses.includes(cell.status)) { failures.push(`${where}: unknown status ${JSON.stringify(cell.status)}`); return; }
  const allowed = new Set(['status', 'evidence', 'note', 'reason', 'branch', 'read', 'whenMerged']);
  for (const key of Object.keys(cell)) if (!allowed.has(key)) failures.push(`${where}: unknown field ${key}`);
  if (cell.status === 'yes' || cell.status === 'partial') {
    if (!Array.isArray(cell.evidence) || cell.evidence.length === 0) failures.push(`${where}: ${cell.status} needs at least one evidence entry`);
    for (const entry of cell.evidence ?? []) {
      if (surface === 'windows') {
        if (!isText(entry) || !entry.startsWith(windowsPrefix) || entry.length === windowsPrefix.length) failures.push(`${where}: Windows evidence must be "${windowsPrefix}<path>"`);
        continue;
      }
      const [path, symbol] = String(entry).split('#');
      if (!repositoryPath(path)) failures.push(`${where}: evidence ${JSON.stringify(entry)} must be a repository-relative path`);
      else if (!repo.exists(path)) failures.push(`${where}: evidence ${path} does not exist (the feature is listed as ${cell.status} but its code is gone)`);
      else if (symbol && !repo.text(path).includes(symbol)) failures.push(`${where}: ${path} no longer contains ${symbol}`);
    }
    if (surface === 'windows' && !datePattern.test(cell.read ?? '')) failures.push(`${where}: Windows evidence needs the date it was read (read: YYYY-MM-DD)`);
    if (cell.status === 'partial' && !isText(cell.note)) failures.push(`${where}: partial needs a note saying what is missing`);
  }
  if (cell.status === 'not_applicable' && !isText(cell.reason)) failures.push(`${where}: not_applicable needs a reason`);
  if (cell.status === 'unknown' && !isText(cell.note)) failures.push(`${where}: unknown needs a note saying what was not determined`);
  if (cell.status === 'planned') {
    if (!isText(cell.branch)) failures.push(`${where}: planned needs the branch`);
    for (const path of cell.whenMerged ?? []) {
      if (!repositoryPath(path)) failures.push(`${where}: whenMerged ${JSON.stringify(path)} must be a repository-relative path`);
      else if (repo.exists(path)) warnings.push(`${where}: planned, but ${path} now exists. Set the cell to yes or partial with evidence.`);
    }
  }
}

/** Cells that are behind for a feature every surface should have: the accepted drift, as `id surface status`. */
export function openCells(matrix) {
  const open = [];
  for (const feature of matrix.features ?? []) {
    if ((feature.scope ?? 'all') !== 'all') continue;
    for (const surface of surfaces) {
      const status = feature.surfaces?.[surface]?.status;
      if (status && status !== 'yes' && status !== 'not_applicable') open.push(`${feature.id} ${surface} ${status}`);
    }
  }
  return open.sort();
}

export function validateMatrix(matrix, repo) {
  const failures = [];
  const warnings = [];
  for (const key of ['version', 'baseline', 'areas', 'features']) if (!(key in (matrix ?? {}))) failures.push(`feature matrix: missing ${key}`);
  if (failures.length) return { failures, warnings };
  if (!datePattern.test(matrix.baseline?.windows?.read ?? '')) failures.push('feature matrix: baseline.windows.read must be a date');
  if (!isText(matrix.baseline?.apple?.commit)) failures.push('feature matrix: baseline.apple.commit is missing');
  const areaIds = new Set();
  for (const area of matrix.areas) {
    if (!isText(area.id) || !isText(area.title)) failures.push(`feature matrix: an area needs id and title (${JSON.stringify(area)})`);
    if (areaIds.has(area.id)) failures.push(`feature matrix: area ${area.id} is listed twice`);
    areaIds.add(area.id);
  }
  const ids = new Set();
  const evidence = [];
  for (const feature of matrix.features) {
    const id = feature?.id;
    if (!idPattern.test(id ?? '')) { failures.push(`feature matrix: id ${JSON.stringify(id)} must look like area.name-of-feature`); continue; }
    if (ids.has(id)) failures.push(`${id}: the id is used twice`);
    ids.add(id);
    if (!areaIds.has(feature.area)) failures.push(`${id}: unknown area ${JSON.stringify(feature.area)}`);
    else if (id.split('.')[0] !== feature.area) failures.push(`${id}: the id must start with its area (${feature.area})`);
    if (!isText(feature.title)) failures.push(`${id}: title is missing`);
    if (!isText(feature.description) || feature.description.includes('\n')) failures.push(`${id}: description must be one line`);
    if (!['all', 'desktop', 'phone'].includes(feature.scope ?? 'all')) failures.push(`${id}: unknown scope ${JSON.stringify(feature.scope)}`);
    const names = Object.keys(feature.surfaces ?? {}).sort().join(',');
    if (names !== [...surfaces].sort().join(',')) { failures.push(`${id}: surfaces must be exactly ${surfaces.join(', ')}`); continue; }
    for (const surface of surfaces) {
      validateCell(feature, surface, feature.surfaces[surface], repo, failures, warnings);
      if (appleSurfaces.includes(surface)) evidence.push(...(feature.surfaces[surface].evidence ?? []), ...(feature.surfaces[surface].whenMerged ?? []));
    }
    if (feature.scope === 'desktop' && feature.surfaces.ios.status === 'yes') failures.push(`${id}: a desktop extra that iOS has is not an extra; remove the scope`);
    if (surfaces.every((surface) => ['no', 'not_applicable'].includes(feature.surfaces[surface].status))) failures.push(`${id}: no surface has or plans this feature`);
  }
  // What the owner decided not to build stays out of the matrix.
  for (const item of matrix.notBuilding?.items ?? []) {
    if (!isText(item.name) || !datePattern.test(item.decided ?? '')) { failures.push(`feature matrix: notBuilding needs a name and the date decided (${JSON.stringify(item)})`); continue; }
    if (item.aliases !== undefined && (!Array.isArray(item.aliases) || !item.aliases.every(isText))) failures.push(`feature matrix: notBuilding ${item.name} aliases must be a list of words`);
    for (const feature of matrix.features) {
      const cells = Object.values(feature.surfaces ?? {}).flatMap((cell) => [cell?.note, cell?.reason]);
      if (notBuildingMatch(item, [feature.id, feature.title, feature.description, ...cells])) failures.push(`${feature.id}: the owner decided not to build 「${item.name}」 (${item.decided})`);
    }
  }
  // A feature folder nobody names is a feature that went into one implementation without the spec.
  for (const base of featureFolders) {
    for (const folder of repo.directories(base)) {
      if (!evidence.some((entry) => String(entry).startsWith(`${folder}/`))) failures.push(`${folder}: no cell of the feature matrix names this feature folder. Add its features to ${sourcePaths.matrix} first.`);
    }
  }
  return { failures, warnings };
}

export function validateBaseline(matrix, baseline) {
  const failures = [];
  const accepted = new Set(baseline?.open ?? []);
  const current = new Set(openCells(matrix));
  for (const cell of current) if (!accepted.has(cell)) failures.push(`new gap not yet accepted: ${cell}`);
  for (const cell of accepted) if (!current.has(cell)) failures.push(`gap closed or changed, baseline is stale: ${cell}`);
  if (failures.length) failures.push(`Decide the gap with the owner (docs/product/gaps.md), then run: node scripts/check-product-spec.mjs --accept-gaps`);
  return failures;
}

// ---------------------------------------------------------------- tokens

function swiftBlock(source, name) {
  const start = source.indexOf(`enum ${name} {`);
  if (start < 0) return '';
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end < 0 ? undefined : end);
}

function swiftHexValues(block) {
  const values = {};
  for (const match of block.matchAll(/static let (\w+): UInt = (?:0x([0-9A-Fa-f]{6})|Intelligence\.(\w+))/gu)) values[match[1]] = match[2] ? `#${match[2].toUpperCase()}` : `@${match[3]}`;
  return values;
}

function swiftNumbers(source, name) {
  const values = {};
  const start = source.indexOf(`enum ${name} {`);
  if (start < 0) return values;
  for (const match of source.slice(start, source.indexOf('\n}', start)).matchAll(/static let (\w+): CGFloat = ([0-9.]+)/gu)) values[match[1]] = Number(match[2]);
  return values;
}

export function validateTokens(tokens, repo) {
  const failures = [];
  const roles = tokens?.color?.roles ?? {};
  if (Object.keys(roles).length === 0) failures.push('tokens: color.roles is empty');
  for (const [name, role] of Object.entries(roles)) {
    if (/brand/iu.test(name)) failures.push(`tokens: role ${name} names a brand. Shannon has no brand colour (Syzygy ADR-0001); name the meaning.`);
    if (!isText(role.meaning)) failures.push(`tokens: role ${name} needs its meaning`);
    for (const mode of ['light', 'dark']) if (!hexPattern.test(role[mode] ?? '')) failures.push(`tokens: role ${name} needs a ${mode} value like #RRGGBB`);
  }
  for (const [name, entry] of Object.entries(tokens?.color?.fixed ?? {})) {
    if (/brand/iu.test(name)) failures.push(`tokens: fixed colour ${name} names a brand`);
    if (!hexPattern.test(entry.value ?? '')) failures.push(`tokens: fixed colour ${name} needs a value like #RRGGBB`);
  }
  for (const [name, style] of Object.entries(tokens?.typography?.scale ?? {})) {
    for (const key of ['size', 'lineHeight', 'weight']) if (!(Number(style[key]) > 0)) failures.push(`tokens: typography ${name}.${key} must be a positive number`);
  }
  const reading = tokens?.typography?.reading;
  if (reading !== undefined && !(Number(reading.lineHeightRatio) >= 1)) failures.push('tokens: typography.reading.lineHeightRatio must be a ratio of at least 1');
  const desktop = tokens?.typography?.desktop?.scale;
  if (desktop) {
    const names = Object.keys(tokens.typography.scale ?? {}).sort().join(',');
    if (Object.keys(desktop).sort().join(',') !== names) failures.push('tokens: typography.desktop.scale must have the same styles as typography.scale');
    for (const [name, style] of Object.entries(desktop)) {
      for (const key of ['size', 'lineHeight', 'weight']) if (!(Number(style[key]) > 0)) failures.push(`tokens: typography.desktop ${name}.${key} must be a positive number`);
      if (Number(style.size) > Number(tokens.typography.scale?.[name]?.size)) failures.push(`tokens: typography.desktop ${name} is larger than the phone size`);
    }
  }
  for (const group of ['spacing', 'radius', 'size']) {
    if (Object.keys(tokens?.[group] ?? {}).length === 0) failures.push(`tokens: ${group} is empty`);
    for (const [name, value] of Object.entries(tokens?.[group] ?? {})) if (!(Number(value) >= 0)) failures.push(`tokens: ${group}.${name} must be a number`);
  }
  for (const [name, entry] of Object.entries(tokens?.motion?.duration ?? {})) if (!(Number(entry.seconds) > 0)) failures.push(`tokens: motion ${name} needs seconds`);

  // Until the app reads the generated file, the tokens must stay equal to what the iOS app draws with.
  const swift = repo.text(iosDesignSystem);
  if (swift === null) return [...failures, `tokens: ${iosDesignSystem} is missing`];
  if (swift.includes('ShannonGeneratedTokens')) return failures; // adopted: the app reads the generated values
  const intelligence = swiftHexValues(swiftBlock(swift, 'Intelligence'));
  const modes = { light: swiftHexValues(swiftBlock(swift, 'Light')), dark: swiftHexValues(swiftBlock(swift, 'Dark')) };
  const resolveSwift = (value) => (value?.startsWith('@') ? intelligence[value.slice(1)] : value);
  for (const [name, role] of Object.entries(roles)) {
    for (const mode of ['light', 'dark']) {
      const current = resolveSwift(modes[mode][role.swift]);
      if (!current) failures.push(`tokens: role ${name} names ShannonColorTokens.${role.swift}, which the iOS app does not define for ${mode}`);
      else if (current !== role[mode].toUpperCase()) failures.push(`tokens: role ${name} (${mode}) is ${role[mode]} but the iOS app uses ${current}`);
    }
  }
  for (const [name, entry] of Object.entries(tokens?.color?.fixed ?? {})) {
    if (intelligence[entry.swift] !== entry.value.toUpperCase()) failures.push(`tokens: fixed colour ${name} is ${entry.value} but the iOS app uses ${intelligence[entry.swift]}`);
  }
  for (const [group, swiftName] of [['spacing', 'ShannonSpacing'], ['radius', 'ShannonShape']]) {
    const current = swiftNumbers(swift, swiftName);
    for (const [name, value] of Object.entries(tokens[group] ?? {})) {
      if (current[name] !== value) failures.push(`tokens: ${group}.${name} is ${value} but the iOS app uses ${current[name]}`);
    }
    for (const name of Object.keys(current)) if (!(name in (tokens[group] ?? {}))) failures.push(`tokens: the iOS app defines ${swiftName}.${name}, which ${sourcePaths.tokens} lacks`);
  }
  const touch = swiftNumbers(swift, 'ShannonTouchTarget').minimum;
  if (touch !== tokens?.size?.touchTargetMinimum) failures.push(`tokens: size.touchTargetMinimum is ${tokens?.size?.touchTargetMinimum} but the iOS app uses ${touch}`);
  return failures;
}

// ---------------------------------------------------------------- strings

export function validateStrings(strings, repo) {
  const failures = [];
  if (!Array.isArray(strings?.strings) || strings.strings.length === 0) return ['strings: the list is empty'];
  if (!datePattern.test(strings.windowsRead ?? '')) failures.push('strings: windowsRead must be a date');
  const keys = new Set();
  const identifiers = new Map();
  for (const entry of strings.strings) {
    const key = entry?.key;
    if (!stringKeyPattern.test(key ?? '')) { failures.push(`strings: key ${JSON.stringify(key)} must look like area.name`); continue; }
    if (keys.has(key)) failures.push(`strings: key ${key} is used twice`);
    keys.add(key);
    const identifier = swiftIdentifier(key);
    if (identifiers.has(identifier)) failures.push(`strings: ${key} and ${identifiers.get(identifier)} produce the same Swift name ${identifier}`);
    identifiers.set(identifier, key);
    if (!isText(entry.text)) { failures.push(`strings: ${key} has no text`); continue; }
    if (/\{[^A-Za-z}]|\{[A-Za-z][A-Za-z0-9]*[^A-Za-z0-9}]/u.test(entry.text)) failures.push(`strings: ${key} has a malformed {placeholder}`);
    if (entry.only !== undefined && entry.only !== 'apple' && entry.only !== 'windows') failures.push(`strings: ${key} only must be "apple" or "windows"`);
    if (entry.only === 'windows') {
      // A sentence of the Windows app that the Apple apps have no place for (often the pointer variant of an iPhone sentence).
      if (entry.apple !== undefined) failures.push(`strings: ${key} is Windows-only and names an Apple place`);
      if (!isText(entry.windows) || !entry.windows.startsWith(windowsPrefix)) failures.push(`strings: ${key} is Windows-only and needs windows: "${windowsPrefix}<path>"`);
      if (entry.decided !== undefined && !datePattern.test(entry.decided)) failures.push(`strings: ${key} decided must be a date`);
      continue;
    }
    if (entry.decided !== undefined) {
      // Wording the owner decided: an implementation may not show it yet, so say what it shows today.
      if (!datePattern.test(entry.decided)) failures.push(`strings: ${key} decided must be a date`);
      if (!isText(entry.windowsNow)) failures.push(`strings: ${key} is decided and needs windowsNow (what Windows shows today, or the same text)`);
      if (entry.windows !== undefined && (!isText(entry.windows) || !entry.windows.startsWith(windowsPrefix))) failures.push(`strings: ${key} windows must be "${windowsPrefix}<path>"`);
    } else if (entry.only === 'apple') {
      // A sentence of the Apple apps that Windows has no place for yet: written down first, checked in its source.
      if (entry.windows !== undefined) failures.push(`strings: ${key} is Apple-only and names a Windows place`);
      if (!isText(entry.apple) || entry.apple === 'new' || entry.apple.startsWith('branch:')) failures.push(`strings: ${key} is Apple-only and needs the Apple source it is written in`);
    } else if (!isText(entry.windows) || !entry.windows.startsWith(windowsPrefix)) {
      failures.push(`strings: ${key} needs windows: "${windowsPrefix}<path>"`);
    }
    if (!isText(entry.apple)) { failures.push(`strings: ${key} needs apple (a source path, branch:<branch>:<path>, or new)`); continue; }
    if (entry.apple === 'new') {
      if (entry.decided === undefined) failures.push(`strings: ${key} has no Apple source; only decided wording may be new`);
      continue;
    }
    if (entry.apple.startsWith('branch:')) {
      if (entry.apple.split(':').length < 3) failures.push(`strings: ${key} apple must be branch:<branch>:<path>`);
      continue; // in flight: cannot be read from this checkout
    }
    const source = repo.text(entry.apple);
    if (source === null) { failures.push(`strings: ${key} names ${entry.apple}, which does not exist`); continue; }
    // Adopted: this very key is read from the generated strings in that file (not merely some other key).
    if (new RegExp(`\\bShannonGeneratedStrings\\.${identifier}\\b`, 'u').test(source)) continue;
    // Every literal piece of the sentence must still be written in the Apple source it was taken from.
    const params = stringParams(entry.text);
    const pieces = entry.text.split(/\{[A-Za-z][A-Za-z0-9]*\}|\n/u).map((piece) => piece.trim()).filter((piece) => piece.length > 0);
    for (const piece of pieces) {
      if (!source.includes(piece)) failures.push(`strings: ${key} says ${JSON.stringify(piece)}, which ${entry.apple} no longer contains${params.length ? '' : ' (the apps and the definition have drifted)'}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------- run

export function run(root = defaultRoot, { acceptGaps = false } = {}) {
  const repo = repository(root);
  const failures = [];
  let sources;
  try { sources = readSources(root); } catch (error) { return { failures: [`cannot read the product spec: ${error.message}`], warnings: [], summary: '' }; }
  const matrix = validateMatrix(sources.matrix, repo);
  failures.push(...matrix.failures);
  if (matrix.failures.length === 0) {
    if (acceptGaps) {
      writeFileSync(resolve(root, baselinePath), `${JSON.stringify({
        about: 'The cells of docs/product/feature-matrix.json that are behind today (features every surface should have). scripts/check-product-spec.mjs fails when this set changes; rewrite it with --accept-gaps after the owner has decided.',
        open: openCells(sources.matrix),
      }, null, 2)}\n`);
    }
    const baseline = repo.text(baselinePath);
    if (baseline === null) failures.push(`${baselinePath} is missing (run: node scripts/check-product-spec.mjs --accept-gaps)`);
    else failures.push(...validateBaseline(sources.matrix, JSON.parse(baseline)));
  }
  failures.push(...validateTokens(sources.tokens, repo));
  failures.push(...validateStrings(sources.strings, repo));
  for (const item of sources.matrix.notBuilding?.items ?? []) {
    for (const entry of sources.strings.strings ?? []) {
      if (notBuildingMatch(item, [entry.key, entry.text, entry.note])) failures.push(`strings: ${entry.key} brings back 「${item.name}」, which the owner decided not to build (${item.decided})`);
    }
  }
  for (const path of staleOutputs(root)) failures.push(`${path} is stale (run: node scripts/generate-product-spec.mjs)`);
  const summary = `${sources.matrix.features?.length ?? 0} features, ${openCells(sources.matrix).length} accepted gaps, ${Object.keys(sources.tokens.color?.roles ?? {}).length} colour roles, ${sources.strings.strings?.length ?? 0} shared strings`;
  return { failures, warnings: matrix.warnings, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run(defaultRoot, { acceptGaps: process.argv.includes('--accept-gaps') });
  for (const warning of result.warnings) console.warn(`Product spec warning: ${warning}`);
  if (result.failures.length) {
    console.error('Product spec check failed:');
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Product spec check passed (${result.summary}).`);
  }
}
