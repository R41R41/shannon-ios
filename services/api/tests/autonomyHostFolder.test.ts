import { createHash } from 'node:crypto';
import { normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import type { ClaimedHostStep, HostStepReceipt } from '../src/autonomyHostFolderDesk.js';
import {
  HOST_FOLDER_LIMITS, HOST_STEP_CODES, copyableStudyPiece, hostFolderRelativePath, studyCopyContent, studyCopyPath,
} from '../src/autonomyHostFolderPath.js';
import { planFromThought } from '../src/autonomyLoopPlan.js';
import { thinkingPrompt, type ThinkingMaterials } from '../src/autonomyLoopPrompts.js';
import { prepareStep } from '../src/autonomyLoopSteps.js';
import { autonomyModel } from '../src/autonomyModels.js';
import { resolvePhysicalPath } from '../src/mind/inhibition/autonomyPaths.js';
import { authorizeAutonomousAction, type AutonomousActionRequest, type AutonomyPolicyContext } from '../src/mind/inhibition/autonomyPolicy.js';
import type { StudyPiece } from '../src/studyStore.js';
import { STORY_BODY, loopHarness, runUntilIdle, scope } from './autonomyLoopHarness.js';

const WINDOWS = 'owner-windows';
const DEVICE = '0123456789abcdef';
const OTHER_DEVICE = 'fedcba9876543210';
const HOSTS_JSON = JSON.stringify({ [WINDOWS]: { deviceId: DEVICE }, 'owner-mac': '/Users/owner/Shannon' });

// MARK: The gate

const places = {
  hostFolders: { 'owner-mac': '/Users/owner/Shannon' },
  hostDevices: { [WINDOWS]: DEVICE },
  workspaceRoot: '/srv/shannon-workspace',
  productionRoots: ['/home/azureuser/shannon-ios'],
  repositoryRoots: ['/home/azureuser/shannon-ios'],
  protectedPaths: ['/home/azureuser/shannon-ios-data'],
};

function context(overrides: Partial<AutonomyPolicyContext> = {}): AutonomyPolicyContext {
  return {
    enabled: true, paused: false, budget: { capYen: 1_000, spentYen: 0 }, isKnownModel: model => autonomyModel(model) !== null,
    places, resolvePath: path => (path.startsWith('/') ? normalize(path) : null),
    publicReadsToday: 0, maximumPublicReadsPerDay: 200, ...overrides,
  };
}

const decide = (request: Partial<AutonomousActionRequest>, overrides?: Partial<AutonomyPolicyContext>) =>
  authorizeAutonomousAction({ summary: '写しを置きます。', domain: 'host_folder', host: WINDOWS, ...request }, context(overrides));

describe('the gate: her folder on a machine the server cannot see', () => {
  it('confirms the fault: a Windows folder never resolves on the server, so the absolute form is always refused', () => {
    if (process.platform === 'win32') return;
    const windowsFolder = { ...places, hostFolders: { [WINDOWS]: 'C:\\Users\\owner\\Shannon' }, hostDevices: {} };
    expect(resolvePhysicalPath('C:\\Users\\owner\\Shannon')).toBeNull();
    expect(decide({ paths: ['C:\\Users\\owner\\Shannon\\notes\\a.md'] }, { places: windowsFolder, resolvePath: resolvePhysicalPath }))
      .toMatchObject({ decision: 'forbidden', reason: 'unknown_host' });
  });

  it('allows a relative text file for a host with a bound device, and hands out no server path', () => {
    for (const relativePath of ['notes/note-2026-10-02-1a2b3c4d-v1.md', 'a.txt', 'data\\table.csv', 'deep/er/and/deeper/x.yaml', 'x.YML', 'メモ/夕方の駅.md', 'console.md', 'a.b.json']) {
      const decision = decide({ relativePath });
      expect(decision, relativePath).toMatchObject({ decision: 'allow', reason: 'free_domain', domain: 'host_folder' });
      expect(decision.allowedRoots).toBeUndefined();
    }
    expect(hostFolderRelativePath('data\\table.csv')).toEqual({ path: 'data/table.csv' });
  });

  const refused: Array<[string, unknown]> = [
    ['a parent step', '../outside.md'],
    ['a parent step in the middle', 'notes/../../outside.md'],
    ['a parent step with backslashes', 'notes\\..\\..\\outside.md'],
    ['a current-folder step', './a.md'],
    ['a POSIX absolute path', '/etc/passwd.txt'],
    ['a rooted backslash path', '\\Windows\\win.txt'],
    ['a drive path', 'C:\\Users\\owner\\a.md'],
    ['a drive path with forward slashes', 'C:/Users/owner/a.md'],
    ['a drive-relative path', 'C:a.md'],
    ['a UNC share', '\\\\server\\share\\a.md'],
    ['a UNC share with forward slashes', '//server/share/a.md'],
    ['a device namespace path', '\\\\?\\C:\\a.md'],
    ['a colon anywhere (an alternate stream)', 'notes/a.md:hidden.txt'],
    ['a home path', '~/a.md'],
    ['a reserved name', 'CON.md'],
    ['a reserved name in lower case', 'notes/nul.txt'],
    ['a reserved name as a folder', 'aux/a.md'],
    ['a reserved serial port', 'COM1.txt'],
    ['a reserved printer port', 'lpt9.md'],
    ['a reserved name before a second dot', 'prn.backup.md'],
    ['an extension that is not text', 'tool.exe'],
    ['a script', 'run.ps1'],
    ['source code', 'copy-of-me.ts'],
    ['a database', 'memory.sqlite'],
    ['no extension', 'notes/readme'],
    ['only an extension', '.md'],
    ['a text extension hidden before another', 'a.md.exe'],
    ['a trailing dot', 'a.md.'],
    ['a trailing space', 'a.md '],
    ['a folder ending in a space', 'notes /a.md'],
    ['an empty segment', 'notes//a.md'],
    ['a trailing separator', 'notes/a.md/'],
    ['a NUL character', 'a\u0000.md'],
    ['a line break', 'a\n.md'],
    ['a wildcard', 'a*.md'],
    ['a pipe', 'a|b.md'],
    ['too many folders', 'a/b/c/d/e/f/g/h/i.md'],
    ['a path that is too long', `${'a'.repeat(HOST_FOLDER_LIMITS.pathCharacters)}.md`],
    ['a name that is too long', `${'a'.repeat(HOST_FOLDER_LIMITS.segmentCharacters)}.md`],
    ['an empty path', ''],
  ];
  it.each(refused)('refuses %s', (_label, relativePath) => {
    expect('problem' in hostFolderRelativePath(relativePath)).toBe(true);
    const decision = decide({ relativePath: relativePath as string });
    expect(decision).toMatchObject({ decision: 'forbidden', reason: 'malformed_request' });
    expect(decision.allowedRoots).toBeUndefined();
  });

  it('refuses a host that is not registered, or has no bound device', () => {
    for (const host of ['friends-pc', 'owner-mac', 'constructor', '__proto__', 'toString']) {
      expect(decide({ host, relativePath: 'notes/a.md' }), host).toMatchObject({ decision: 'forbidden', reason: 'unknown_host' });
    }
    expect(authorizeAutonomousAction({ summary: '写しを置きます。', domain: 'host_folder', relativePath: 'notes/a.md' }, context()))
      .toMatchObject({ decision: 'forbidden', reason: 'unknown_host' });
    // Configuration from before device binding has no devices at all.
    const { hostDevices: _none, ...legacy } = places;
    expect(decide({ relativePath: 'notes/a.md' }, { places: legacy })).toMatchObject({ decision: 'forbidden', reason: 'unknown_host' });
  });

  it('refuses a relative path that is not a string, is mixed with absolute paths, or belongs to another domain', () => {
    expect(decide({ relativePath: 7 as unknown as string })).toMatchObject({ decision: 'forbidden', reason: 'malformed_request', domain: 'unknown' });
    expect(decide({ relativePath: 'notes/a.md', paths: ['/Users/owner/Shannon/a.md'] })).toMatchObject({ decision: 'forbidden', reason: 'malformed_request' });
    expect(decide({ relativePath: 'notes/a.md', paths: [] })).toMatchObject({ decision: 'forbidden', reason: 'malformed_request' });
    for (const domain of ['vm_workspace', 'thinking', 'aether_study', 'core']) {
      expect(decide({ domain, relativePath: 'notes/a.md' }), domain).toMatchObject({ decision: 'forbidden', reason: 'malformed_request' });
    }
  });

  it('keeps every earlier refusal in front of the new form', () => {
    expect(decide({ relativePath: 'notes/a.md' }, { paused: true })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    expect(decide({ relativePath: 'notes/a.md' }, { enabled: false })).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    expect(decide({ relativePath: 'notes/a.md', replicatesSelf: true })).toMatchObject({ decision: 'forbidden', reason: 'self_replication' });
    expect(decide({ relativePath: 'notes/a.md', usesPrivateConversationContent: true })).toMatchObject({ decision: 'forbidden', reason: 'private_content' });
    expect(decide({ relativePath: 'notes/a.md', impersonates: true })).toMatchObject({ decision: 'forbidden', reason: 'impersonation' });
    expect(decide({ relativePath: 'notes/a.md', spendsMoney: true })).toMatchObject({ decision: 'forbidden', reason: 'spending' });
    expect(decide({ relativePath: 'notes/a.md', reachesOthers: true })).toMatchObject({ decision: 'needs_approval', reason: 'reaches_others' });
    // The absolute form is judged exactly as before.
    expect(decide({ host: 'owner-mac', paths: ['/Users/owner/Shannon/a.md'] })).toMatchObject({ decision: 'allow', allowedRoots: ['/Users/owner/Shannon'] });
    expect(decide({ host: 'owner-mac', paths: ['/Users/owner/Documents/a.md'] })).toMatchObject({ decision: 'needs_approval', reason: 'outside_own_area' });
    expect(decide({ host: WINDOWS, paths: ['/Users/owner/Shannon/a.md'] })).toMatchObject({ decision: 'forbidden', reason: 'unknown_host' });
    expect(decide({ host: 'owner-mac' })).toMatchObject({ decision: 'forbidden', reason: 'malformed_request' });
  });
});

// MARK: Registration

describe('host registration', () => {
  it('reads the folder form, the device form, and both', () => {
    const config = configuredAutonomy({ SHANNON_AUTONOMY_HOST_FOLDERS_JSON: JSON.stringify({
      'owner-mac': '/Users/owner/Shannon', [WINDOWS]: { deviceId: DEVICE }, 'owner-mini': { folder: '/Users/owner/Mini', deviceId: OTHER_DEVICE },
      'Bad Host': { deviceId: DEVICE }, 'short-id': { deviceId: 'abc' }, 'upper-id': { deviceId: 'ABCDEF0123456789' }, listed: [DEVICE],
    }) });
    expect(config.places.hostFolders).toEqual({ 'owner-mac': '/Users/owner/Shannon', 'owner-mini': '/Users/owner/Mini' });
    expect(config.places.hostDevices).toEqual({ [WINDOWS]: DEVICE, 'owner-mini': OTHER_DEVICE });
  });

  it('registers nothing by default or from an unreadable value, with small bounds', () => {
    for (const value of [undefined, '', 'not json', '[]', '"text"']) {
      const config = configuredAutonomy(value === undefined ? {} : { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: value });
      expect(config.places.hostFolders).toEqual({});
      expect(config.places.hostDevices).toEqual({});
    }
    expect(configuredAutonomy({})).toMatchObject({ maximumHostFolderWritesPerDay: 10, hostStepLeaseMilliseconds: 300_000 });
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES: '3', SHANNON_AUTONOMY_HOST_STEP_LEASE_SECONDS: '60' }))
      .toMatchObject({ maximumHostFolderWritesPerDay: 3, hostStepLeaseMilliseconds: 60_000 });
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES: '99999', SHANNON_AUTONOMY_HOST_STEP_LEASE_SECONDS: '1' }))
      .toMatchObject({ maximumHostFolderWritesPerDay: 10, hostStepLeaseMilliseconds: 300_000 });
  });
});

// MARK: What may be copied

function folderHarness(options: Parameters<typeof loopHarness>[0] = {}) {
  const harness = loopHarness({ ...options, environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: HOSTS_JSON, ...options.environment } });
  const note = (title = '夕方の駅が懐かしい理由') => harness.store.study.create(scope, {
    kind: 'note', title, body: '光の色と人の少なさが、懐かしさを作っているのだと思いました。', sources: [{ title: '随筆', url: 'https://example.org/station' }],
  }, harness.clock.at) as StudyPiece;
  const story = (title = '傘のある駅') => harness.store.study.create(scope, { kind: 'story', title, body: STORY_BODY }, harness.clock.at) as StudyPiece;
  const queue = (piece: StudyPiece) => harness.service.folder.enqueue(scope, { host: WINDOWS, pieceId: piece.id, pieceVersion: piece.version }, harness.clock.at);
  const api = createLocalApiKernel(() => harness.clock.at, { autonomy: harness.service });
  const post = (path: string, body: Record<string, unknown>, deviceId: string | null = DEVICE) =>
    api.dispatch({ method: 'POST', path, body: { scopeKey: scope, ...body }, ...(deviceId ? { deviceId } : {}) });
  const claim = async (deviceId: string | null = DEVICE, host = WINDOWS) => post('/v1/autonomy/host-steps/claim', { host }, deviceId);
  const claimed = async () => ((await claim()).body as { step: ClaimedHostStep | null }).step;
  const report = (id: string, body: Record<string, unknown>, deviceId: string | null = DEVICE) => post(`/v1/autonomy/host-steps/${id}/report`, body, deviceId);
  return { ...harness, note, story, queue, post, claim, claimed, report };
}

describe('what may be copied to her folder', () => {
  it('derives the path from kind, day, id and version, never from a title', () => {
    const { note, story, store, clock } = folderHarness();
    const written = note('../../Windows/system32/evil');
    expect(studyCopyPath(written, '2026-10-02')).toBe(`notes/note-2026-10-02-${written.id.replace(/-/gu, '').slice(0, 8)}-v1.md`);
    const draft = story('CON');
    expect(studyCopyPath(draft, '2026-10-02')).toBe(`stories/story-2026-10-02-${draft.id.replace(/-/gu, '').slice(0, 8)}-v1.md`);
    expect(studyCopyPath(draft, 'yesterday')).toBeNull();
    expect(studyCopyPath({ ...draft, id: '../..' }, '2026-10-02')).toBeNull();
    expect(studyCopyContent(written)).toBe(`# ${written.title}\n\n${written.body}\n\n出典:\n- 随筆 https://example.org/station\n`);

    // A draft is not copyable; the version she called 「見せてもいい」 is; a revision or putting away closes it again.
    expect(copyableStudyPiece(written)).toBe(true);
    expect(copyableStudyPiece(draft)).toBe(false);
    const ready = store.study.markReady(scope, draft.id, clock.at) as StudyPiece;
    expect(copyableStudyPiece(ready)).toBe(true);
    expect(copyableStudyPiece(store.study.markShown(scope, draft.id, clock.at) as StudyPiece)).toBe(true);
    expect(copyableStudyPiece(store.study.revise(scope, draft.id, { body: `${STORY_BODY}続き。`, changeNote: '足しました。' }, clock.at) as StudyPiece)).toBe(false);
    expect(copyableStudyPiece(store.study.putAway(scope, written.id, 'shannon', clock.at) as StudyPiece)).toBe(false);
  });

  it('never queues a story she has not shown, by any entrance', async () => {
    const harness = folderHarness();
    const { story, service, store, model, loop, entries, clock, config, loopConfig, reader, showing } = harness;
    const draft = story('まだ見せない話');
    expect(service.folder.nextCopy(scope, clock.at, draft.id)).toBeNull();
    expect(service.folder.nextCopy(scope, clock.at)).toBeNull();
    expect(() => service.folder.enqueue(scope, { host: WINDOWS, pieceId: draft.id, pieceVersion: 1 }, clock.at)).toThrow('HOST_STEP_PIECE_NOT_COPYABLE');
    // The plan drops it, and a step that slipped into a plan anyway cannot be prepared.
    const known = { pursuits: [], pieces: store.study.list(scope), unnotedReadingIds: [] };
    expect(planFromThought({ steps: [{ action: 'copy', pieceId: draft.id }] }, known, { maximumSteps: 5, maximumReads: 0, notionAvailable: false, folderAvailable: true }).steps).toEqual([]);
    const cycle = store.loop.startCycle(scope, '2026-10-02', 'activity', [], clock.at);
    expect(prepareStep({ store, service, config, loop: loopConfig, model, reader, showing }, cycle, { kind: 'copy', pieceId: draft.id }, clock.at)).toBeNull();
    store.loop.endCycle(cycle.id, 'test', clock.at);

    model.plans = [{ thought: '写しを置いてみます。', pursuits: [], steps: [{ action: 'copy', pieceId: draft.id }, { action: 'copy' }] }];
    await runUntilIdle(loop);
    expect(store.hostSteps.queuedOn(scope, '2026-10-02')).toBe(0);
    expect(entries().some(entry => entry.domain === 'host_folder')).toBe(false);
    expect(JSON.stringify(entries())).not.toContain('まだ見せない話');
    expect((await harness.claimed())).toBeNull();
  });
});

// MARK: The loop step

const emptyMaterials: ThinkingMaterials = {
  localTime: 'x', remainingYen: 0, remainingReads: 0, maximumSteps: 1, pursuits: [], stories: [], notes: [], unnotedReadings: [], feedback: [], places: [], notionAvailable: false,
};

describe('the loop step 「自分のフォルダに写しを置く」', () => {
  it('is offered to the planner only while a host has a bound device, and leaves the prompt as it was otherwise', async () => {
    const without = thinkingPrompt(emptyMaterials).system;
    expect(without).not.toContain('copy');
    expect(thinkingPrompt({ ...emptyMaterials, folderAvailable: false }).system).toBe(without);
    const offered = thinkingPrompt({ ...emptyMaterials, folderAvailable: true }).system;
    expect(offered).toContain('copy（書いたメモか「見せてもいい」にした物語の写しを1つ、持ち主のPC・Macにある自分のフォルダに置く。');
    expect(offered).toContain('{"action":"copy","pieceId":"…"}');
    expect(offered.replace(/copy（[^）]*）、/u, '').replace('{"action":"copy","pieceId":"…"},', '')).toBe(without);

    // No registered device: the planner is not told, and a copy it asks for anyway is dropped.
    const plain = loopHarness();
    plain.model.plans = [{ thought: '写しを置きます。', pursuits: [], steps: [{ action: 'copy' }] }];
    plain.store.study.create(scope, { kind: 'note', title: 'メモ', body: '本文です。' }, plain.clock.at);
    await runUntilIdle(plain.loop);
    expect(plain.model.prompts('think')[0]).not.toContain('copy');
    expect(plain.entries().some(entry => entry.domain === 'host_folder')).toBe(false);
    expect(plain.store.hostSteps.queuedOn(scope, '2026-10-02')).toBe(0);
    // A legacy folder entry without a device does not make the step available either.
    expect(loopHarness({ environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"owner-mac":"/Users/owner/Shannon"}' } }).service.folder.available(scope, plain.clock.at)).toBe(false);
  });

  it('queues a copy of the note she just wrote, through the gate, and the device writes it', async () => {
    const { loop, model, store, entries, claimed, report, claim } = folderHarness();
    model.plans = [{ thought: '読んで、メモを書いて、写しを置きます。', pursuits: [], steps: [{ action: 'read', url: 'https://example.org/station' }, { action: 'note' }, { action: 'copy' }] }];
    expect(await runUntilIdle(loop)).toEqual(['stepped', 'stepped', 'stepped', 'stepped', 'cycle-ended']);
    expect(model.prompts('think')[0]).toContain('copy（');
    const note = store.study.list(scope).find(piece => piece.kind === 'note')!;
    const path = `notes/note-2026-10-02-${note.id.replace(/-/gu, '').slice(0, 8)}-v1.md`;

    const queued = entries().find(entry => entry.kind === 'action' && entry.tool === 'folder.copy')!;
    expect(queued).toMatchObject({ domain: 'host_folder', outcome: 'done', costYen: 0, link: `shannon-study://${note.id}` });
    expect(queued.summary).toContain(`自分のフォルダ（${WINDOWS}）`);
    expect(entries().find(entry => entry.id === queued.relatedId)).toMatchObject({ kind: 'decision', outcome: 'allowed', domain: 'host_folder', reasonCode: 'free_domain' });

    const step = (await claimed())!;
    expect(step).toMatchObject({ operation: 'write', relativePath: path, expiresAt: '2026-10-02T01:05:00.000Z' });
    expect(Object.keys(step).sort()).toEqual(['bytes', 'content', 'contentSha256', 'expiresAt', 'id', 'operation', 'relativePath']);
    expect(step.content).toBe(studyCopyContent(note));
    expect(step.bytes).toBe(Buffer.byteLength(step.content, 'utf8'));
    expect(step.contentSha256).toBe(createHash('sha256').update(step.content, 'utf8').digest('hex'));
    // One step at a time: nothing else is handed out while this one is held.
    expect((await claim()).body).toEqual({ step: null });

    expect((await report(step.id, { outcome: 'done', bytes: step.bytes })).body).toEqual({ id: step.id, status: 'done', recorded: true });
    const written = entries().find(entry => entry.kind === 'action' && entry.tool === 'folder.write')!;
    expect(written).toMatchObject({ domain: 'host_folder', outcome: 'done', summary: `自分のフォルダ（${WINDOWS}）に「${path}」を置きました。` });
    expect(entries().find(entry => entry.id === written.relatedId)).toMatchObject({ kind: 'decision', outcome: 'allowed', tool: 'folder.write' });
    // The text is not kept in the queue once the step is closed, and the same version is not copied twice.
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'done', content: '' });
    expect(await claimed()).toBeNull();
    model.plans = [{ thought: 'もう一度。', pursuits: [], steps: [{ action: 'copy', pieceId: note.id }] }];
    store.loop.setNextCycleAt(scope, '2026-10-02T01:00:00.000Z');
    await runUntilIdle(loop);
    expect(store.hostSteps.queuedOn(scope, '2026-10-02')).toBe(1);
  });

  it('copies a story only once she has called it 「見せてもいい」', async () => {
    const { story, store, service, clock, queue, claimed } = folderHarness();
    const piece = story();
    expect(service.folder.nextCopy(scope, clock.at, piece.id)).toBeNull();
    const ready = store.study.markReady(scope, piece.id, clock.at) as StudyPiece;
    expect(service.folder.nextCopy(scope, clock.at, piece.id)).toMatchObject({ host: WINDOWS, kind: 'story', relativePath: studyCopyPath(ready, '2026-10-02') });
    queue(ready);
    expect((await claimed())!.content).toBe(`# 傘のある駅\n\n${STORY_BODY}\n`);
  });

  it('stops at the per-day limit and starts again the next owner-local day', async () => {
    const { note, queue, service, clock, advance, loop, model, entries, store } = folderHarness({ environment: { SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES: '2' } });
    const notes = [note('一つめ'), note('二つめ'), note('三つめ')];
    queue(notes[0]!);
    expect(service.folder.available(scope, clock.at)).toBe(true);
    queue(notes[1]!);
    expect(service.folder.available(scope, clock.at)).toBe(false);
    expect(service.folder.nextCopy(scope, clock.at)).toBeNull();
    expect(() => queue(notes[2]!)).toThrow('HOST_STEP_DAILY_LIMIT');
    // The planner is no longer offered the step, and one it plans anyway is skipped unasked.
    model.plans = [{ thought: '写しを置きます。', pursuits: [], steps: [{ action: 'copy' }] }];
    await runUntilIdle(loop);
    expect(model.prompts('think')[0]).not.toContain('copy（');
    expect(entries().some(entry => entry.domain === 'host_folder')).toBe(false);
    expect(store.hostSteps.queuedOn(scope, '2026-10-02')).toBe(2);

    advance(24 * 60 * 60_000);
    expect(service.folder.nextCopy(scope, clock.at)).toMatchObject({ pieceId: notes[2]!.id });
    expect(queue(notes[2]!)).toMatchObject({ status: 'queued', dayKey: '2026-10-03' });
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_HOST_FOLDER_WRITES: '0', SHANNON_AUTONOMY_HOST_FOLDERS_JSON: HOSTS_JSON }).maximumHostFolderWritesPerDay).toBe(0);
  });

  it('refuses to queue a piece that changed, is already queued, or is too large', () => {
    const { note, story, queue, service, store, clock } = folderHarness();
    const piece = note();
    queue(piece);
    expect(() => queue(piece)).toThrow('HOST_STEP_ALREADY_QUEUED');
    expect(() => service.folder.enqueue(scope, { host: 'owner-mac', pieceId: piece.id, pieceVersion: 1 }, clock.at)).toThrow('HOST_STEP_HOST_NOT_BOUND');
    const shown = store.study.markReady(scope, story().id, clock.at) as StudyPiece;
    store.study.revise(scope, shown.id, { body: `${STORY_BODY}続き。`, changeNote: '足しました。' }, clock.at);
    expect(() => queue(shown)).toThrow('HOST_STEP_PIECE_NOT_COPYABLE');
    // Study pieces are far below the bound (a story is at most 4,000 characters), so the bound is checked on its own.
    expect(HOST_FOLDER_LIMITS.bytes).toBe(1_048_576);
    expect(Buffer.byteLength(studyCopyContent({ ...shown, title: 'あ'.repeat(80), body: 'あ'.repeat(4_000) }), 'utf8')).toBeLessThan(HOST_FOLDER_LIMITS.bytes);
  });
});

// MARK: Claim and report

describe('device routes of her folder', () => {
  it('hands a step only to the device bound to the host', async () => {
    const { note, queue, claim, report, entries, store } = folderHarness();
    const step = queue(note());
    const before = entries().length;
    for (const deviceId of [OTHER_DEVICE, null]) {
      expect(await claim(deviceId)).toMatchObject({ status: 403, body: { error: 'HOST_NOT_BOUND' } });
    }
    // The Mac entry has a folder but no device; an unknown host has neither.
    expect(await claim(DEVICE, 'owner-mac')).toMatchObject({ status: 403, body: { error: 'HOST_NOT_BOUND' } });
    expect(await claim(DEVICE, 'friends-pc')).toMatchObject({ status: 403, body: { error: 'HOST_NOT_BOUND' } });
    expect(await claim(DEVICE, 'constructor')).toMatchObject({ status: 403 });
    // A device that did not claim the step cannot report it, or learn that it exists.
    expect(await report(step.id, { outcome: 'done' }, OTHER_DEVICE)).toMatchObject({ status: 404, body: { error: 'HOST_STEP_NOT_FOUND' } });
    expect(await report(step.id, { outcome: 'done' })).toMatchObject({ status: 404 });
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'queued' });
    expect(entries()).toHaveLength(before);

    expect(((await claim()).body as { step: ClaimedHostStep }).step.id).toBe(step.id);
    expect(await report(step.id, { outcome: 'done' }, OTHER_DEVICE)).toMatchObject({ status: 404 });
    expect(await report(step.id, { outcome: 'done' }, null)).toMatchObject({ status: 404 });
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'leased', deviceId: DEVICE });
  });

  it('validates the requests and accepts no text from the device', async () => {
    const { note, queue, post, claimed, report } = folderHarness();
    queue(note());
    expect((await post('/v1/autonomy/host-steps/claim', {})).status).toBe(400);
    expect((await post('/v1/autonomy/host-steps/claim', { host: 'Owner Windows' })).status).toBe(400);
    expect((await post('/v1/autonomy/host-steps/claim', { host: WINDOWS, deviceId: OTHER_DEVICE })).status).toBe(400);
    const step = (await claimed())!;
    expect((await report(step.id, { outcome: 'written' })).status).toBe(400);
    expect((await report(step.id, { outcome: 'failed', code: 'the disk said: SENTINEL' })).status).toBe(400);
    expect((await report(step.id, { outcome: 'done', bytes: -1 })).status).toBe(400);
    expect((await report(step.id, { outcome: 'done', bytes: HOST_FOLDER_LIMITS.bytes + 1 })).status).toBe(400);
    expect((await report(step.id, { outcome: 'done', content: 'read back from the folder' })).status).toBe(400);
    expect((await report(step.id, { outcome: 'done', message: 'free text' })).status).toBe(400);
    expect((await post('/v1/autonomy/host-steps/not-an-id/report', { outcome: 'done' })).status).toBe(404);
    expect((await post(`/v1/autonomy/host-steps/${step.id}/content`, {})).status).toBe(404);
    const api = createLocalApiKernel(() => '2026-10-02T01:00:00.000Z');
    expect((await api.dispatch({ method: 'GET', path: '/v1/autonomy/host-steps/claim', query: new URLSearchParams({ scopeKey: scope }) })).status).toBe(404);
    expect((await api.dispatch({ method: 'POST', path: '/v1/autonomy/host-steps/claim', body: { host: WINDOWS } })).status).toBe(400);
  });

  it('records a report once, whatever is sent afterwards', async () => {
    const { note, queue, claimed, report, entries, store } = folderHarness();
    queue(note());
    const step = (await claimed())!;
    expect((await report(step.id, { outcome: 'refused', code: 'link_refused' })).body).toEqual({ id: step.id, status: 'refused', recorded: true });
    const count = entries().length;
    const refusal = entries().find(entry => entry.kind === 'action' && entry.tool === 'folder.write')!;
    expect(refusal).toMatchObject({ outcome: 'failed', domain: 'host_folder' });
    expect(refusal.summary).toBe(`自分のフォルダ（${WINDOWS}）に「${step.relativePath}」を置くことを、端末が断りました（${HOST_STEP_CODES.link_refused}）。`);
    for (const again of [{ outcome: 'refused', code: 'link_refused' }, { outcome: 'done' }, { outcome: 'failed', code: 'io_error' }]) {
      expect(await report(step.id, again)).toMatchObject({ status: 200, body: { id: step.id, status: 'refused', recorded: false } satisfies HostStepReceipt });
    }
    expect(entries()).toHaveLength(count);
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'refused', code: 'link_refused', content: '' });
    // A refused or failed step is dropped: the queue does not hand it out again.
    expect(await claimed()).toBeNull();
  });

  it('records a failure with its code, and "unknown" when the device gives none', async () => {
    const { note, queue, claimed, report, entries } = folderHarness();
    queue(note('一つめ'));
    queue(note('二つめ'));
    const first = (await claimed())!;
    await report(first.id, { outcome: 'failed', code: 'io_error' });
    const second = (await claimed())!;
    expect(second.id).not.toBe(first.id);
    await report(second.id, { outcome: 'failed' });
    const failures = entries().filter(entry => entry.kind === 'action' && entry.tool === 'folder.write').map(entry => [entry.outcome, entry.summary]);
    expect(failures).toEqual([
      ['failed', `自分のフォルダ（${WINDOWS}）に「${second.relativePath}」を置けませんでした（${HOST_STEP_CODES.unknown}）。`],
      ['failed', `自分のフォルダ（${WINDOWS}）に「${first.relativePath}」を置けませんでした（${HOST_STEP_CODES.io_error}）。`],
    ]);
  });

  it('closes a lease that ran out as failed, and never hands the step out again', async () => {
    const { note, queue, claimed, claim, report, entries, store, advance, loop } = folderHarness();
    queue(note());
    const step = (await claimed())!;
    advance(4 * 60_000);
    expect((await claim()).body).toEqual({ step: null });
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'leased' });

    advance(60_000);
    // The loop closes it too, so a device that never comes back still leaves a record.
    await loop.tick();
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'expired', content: '' });
    const failures = entries().filter(entry => entry.kind === 'action' && entry.tool === 'folder.write');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ outcome: 'failed', domain: 'host_folder' });
    expect(failures[0]!.summary).toContain('時間内に結果が届きませんでした');
    expect((await claim()).body).toEqual({ step: null });
    // A late report changes nothing and is not recorded.
    expect((await report(step.id, { outcome: 'done' })).body).toEqual({ id: step.id, status: 'expired', recorded: false });
    expect(entries().filter(entry => entry.kind === 'action' && entry.tool === 'folder.write')).toHaveLength(1);
  });

  it('closes an overdue lease at the next claim or report, without the loop', async () => {
    const { note, queue, claimed, report, entries, store, advance } = folderHarness();
    queue(note('一つめ'));
    queue(note('二つめ'));
    const first = (await claimed())!;
    advance(5 * 60_000);
    expect((await report(first.id, { outcome: 'done' })).body).toEqual({ id: first.id, status: 'expired', recorded: false });
    const second = (await claimed())!;
    expect(second.id).not.toBe(first.id);
    advance(5 * 60_000);
    expect(await claimed()).toBeNull();
    expect(store.hostSteps.get(scope, second.id)).toMatchObject({ status: 'expired' });
    expect(entries().filter(entry => entry.tool === 'folder.write' && entry.kind === 'action' && entry.outcome === 'failed')).toHaveLength(2);
  });

  it('hands out nothing while the owner has paused her, and leaves no trace of the polling', async () => {
    const { note, queue, claim, claimed, service, entries, store } = folderHarness();
    const step = queue(note());
    service.setPaused(scope, true);
    const before = entries().length;
    for (let poll = 0; poll < 3; poll += 1) expect(await claim()).toMatchObject({ status: 200, body: { step: null } });
    expect(entries()).toHaveLength(before);
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'queued' });
    // Her loop cannot queue either: the gate refuses the step.
    expect(service.authorize(scope, { domain: 'host_folder', host: WINDOWS, relativePath: 'notes/a.md', summary: '写しを置く用意をします。' }))
      .toMatchObject({ decision: 'forbidden', reason: 'paused' });

    service.setPaused(scope, false);
    expect((await claimed())!.id).toBe(step.id);
  });

  it('hands out nothing while the server switch is off', async () => {
    const { note, queue, claim, service, entries, store, loop, model } = folderHarness({ enabled: false });
    const step = queue(note());
    expect(await claim()).toMatchObject({ status: 200, body: { step: null } });
    expect(await claim(OTHER_DEVICE)).toMatchObject({ status: 403 });
    expect(entries()).toHaveLength(0);
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'queued' });
    expect(service.authorize(scope, { domain: 'host_folder', host: WINDOWS, relativePath: 'notes/a.md', summary: '写しを置く用意をします。' }))
      .toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    model.plans = [{ thought: '写しを置きます。', pursuits: [], steps: [{ action: 'copy' }] }];
    expect(await loop.tick()).toBe('disabled');
    expect(store.hostSteps.queuedOn(scope, '2026-10-02')).toBe(1);
  });

  it('drops a queued copy whose piece was put away before the device came for it', async () => {
    const { note, queue, claimed, entries, store, service } = folderHarness();
    const piece = note();
    const step = queue(piece);
    service.study.putAway(scope, piece.id);
    expect(await claimed()).toBeNull();
    expect(store.hostSteps.get(scope, step.id)).toMatchObject({ status: 'dropped', content: '' });
    expect(entries().find(entry => entry.kind === 'action' && entry.tool === 'folder.write')).toMatchObject({ outcome: 'failed' });
    expect(await claimed()).toBeNull();
  });
});
