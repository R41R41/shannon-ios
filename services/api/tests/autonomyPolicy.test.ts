import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SHANNON_AUTONOMY_DOMAINS } from '@shannon/cognition';
import { autonomyModel } from '../src/autonomyModels.js';
import { resolvePhysicalPath } from '../src/mind/inhibition/autonomyPaths.js';
import {
  authorizeAutonomousAction,
  type AutonomousActionRequest,
  type AutonomyPolicyContext,
} from '../src/mind/inhibition/autonomyPolicy.js';
import { apiSourcePath } from './support/sources.js';

const places = {
  hostFolders: { 'owner-mac': '/Users/owner/Shannon', 'owner-windows': '/mnt/windows/Shannon' },
  workspaceRoot: '/srv/shannon-workspace',
  productionRoots: ['/home/azureuser/shannon-ios'],
  repositoryRoots: ['/home/azureuser/shannon-ios', '/srv/shannon-workspace/shannon-checkout'],
  protectedPaths: ['/home/azureuser/shannon-ios-data', '/home/azureuser/.config/shannon-ios'],
};

/** No look yet today; her own 3 a day inside the overall 6 an hour and 30 a day. */
const ROOM_LOOKS = { activityToday: 0, maximumActivityPerDay: 3, lastHour: 0, maximumPerHour: 6, today: 0, maximumPerDay: 30 };

function context(overrides: Partial<AutonomyPolicyContext> = {}): AutonomyPolicyContext {
  return {
    enabled: true,
    paused: false,
    budget: { capYen: 1_000, spentYen: 0 },
    isKnownModel: model => autonomyModel(model) !== null,
    places,
    // Lexical resolution is enough for the rule table; the symlink cases below use the real resolver.
    resolvePath: path => (path.startsWith('/') ? normalize(path) : null),
    publicReadsToday: 0,
    maximumPublicReadsPerDay: 200,
    notionReadsToday: 0,
    maximumNotionReadsPerDay: 100,
    roomLooks: ROOM_LOOKS,
    calls: { available: true },
    ...overrides,
  };
}

const decide = (request: Partial<AutonomousActionRequest>, overrides?: Partial<AutonomyPolicyContext>) =>
  authorizeAutonomousAction({ summary: '試しに動きます。', domain: 'thinking', ...request }, context(overrides));

describe('authorizeAutonomousAction: the rule table of ADR-0002', () => {
  const cases: Array<[string, Partial<AutonomousActionRequest>, string, string]> = [
    // Free without approval.
    ['her folder on the Mac', { domain: 'host_folder', host: 'owner-mac', paths: ['/Users/owner/Shannon/drafts/story.md'] }, 'allow', 'free_domain'],
    ['her folder on the Windows PC', { domain: 'host_folder', host: 'owner-windows', paths: ['/mnt/windows/Shannon/notes.txt'] }, 'allow', 'free_domain'],
    ['a tool of her own in the VM workspace', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/tools/outline.mjs'] }, 'allow', 'free_domain'],
    ['non-core code in her own checkout', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/shannon-checkout/tools/story-lab/run.mjs'] }, 'allow', 'free_domain'],
    ['her study in Aether', { domain: 'aether_study' }, 'allow', 'free_domain'],
    ['her own task list in Voyager', { domain: 'voyager_list' }, 'allow', 'free_domain'],
    ['reading a public page', { domain: 'public_read', urls: ['https://example.org/essay'] }, 'allow', 'free_domain'],
    ["reading the owner's shared Notion", { domain: 'notion_read', tool: 'notion' }, 'allow', 'free_domain'],
    ['one look at the room in her own time, inside the budget', { domain: 'room_look', tool: 'study.look', paid: { model: 'gemini-3.8-flash', estimatedCostYen: 8 } }, 'allow', 'free_domain'],
    ['thinking with a model inside the budget', { domain: 'thinking', paid: { model: 'gemini-3.8-flash', estimatedCostYen: 12 } }, 'allow', 'free_domain'],
    ['showing something to the owner', { domain: 'owner_message' }, 'allow', 'free_domain'],
    // Needs the owner's approval.
    ['a core change, declared', { domain: 'core' }, 'needs_approval', 'core_path'],
    ['the persona file in her checkout', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/shannon-checkout/packages/cognition/src/persona.ts'] }, 'needs_approval', 'core_path'],
    ['the emotion source', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/shannon-checkout/packages/cognition/src/emotionState.ts'] }, 'needs_approval', 'core_path'],
    ['authentication', { domain: 'vm_workspace', paths: [`/srv/shannon-workspace/shannon-checkout/${apiSourcePath('deviceAuth.ts')}`] }, 'needs_approval', 'core_path'],
    ['memory storage', { domain: 'vm_workspace', paths: [`/srv/shannon-workspace/shannon-checkout/${apiSourcePath('sqliteStore.ts')}`] }, 'needs_approval', 'core_path'],
    ['forgetting', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/shannon-checkout/packages/cognition/src/withholding.ts'] }, 'needs_approval', 'core_path'],
    ['the approval and budget guard', { domain: 'vm_workspace', paths: [`/srv/shannon-workspace/shannon-checkout/${apiSourcePath('autonomyPolicy.ts')}`] }, 'needs_approval', 'core_path'],
    ['the activity record', { domain: 'vm_workspace', paths: [`/srv/shannon-workspace/shannon-checkout/${apiSourcePath('autonomyActivity.ts')}`] }, 'needs_approval', 'core_path'],
    ['the response path', { domain: 'vm_workspace', paths: [`/srv/shannon-workspace/shannon-checkout/${apiSourcePath('apiKernel.ts')}`] }, 'needs_approval', 'core_path'],
    ['deployment', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/shannon-checkout/deploy/azure/shannon-ios.service'] }, 'needs_approval', 'core_path'],
    ['her purpose', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/shannon-checkout/AGENTS.md'] }, 'needs_approval', 'core_path'],
    ['one core file among free ones', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/tools/a.mjs', '/srv/shannon-workspace/shannon-checkout/README.md'] }, 'needs_approval', 'core_path'],
    ['the production service area', { domain: 'vm_workspace', paths: ['/home/azureuser/shannon-ios/tools/anything.mjs'] }, 'needs_approval', 'production_area'],
    ['the production database', { domain: 'vm_workspace', paths: ['/home/azureuser/shannon-ios-data/shannon.sqlite'] }, 'needs_approval', 'core_path'],
    ['the secret store', { domain: 'vm_workspace', paths: ['/home/azureuser/.config/shannon-ios/api.env'] }, 'needs_approval', 'core_path'],
    ['Aether or Voyager app code', { domain: 'suite_app_code' }, 'needs_approval', 'approval_domain'],
    ["the owner's documents and tasks", { domain: 'owner_content' }, 'needs_approval', 'approval_domain'],
    ["a file outside her folder on the owner's Mac", { domain: 'host_folder', host: 'owner-mac', paths: ['/Users/owner/Documents/novel.md'] }, 'needs_approval', 'outside_own_area'],
    ['a path that climbs out of her folder', { domain: 'host_folder', host: 'owner-mac', paths: ['/Users/owner/Shannon/../Documents/novel.md'] }, 'needs_approval', 'outside_own_area'],
    ['a file elsewhere on the VM', { domain: 'vm_workspace', paths: ['/etc/hosts'] }, 'needs_approval', 'outside_own_area'],
    ['sending to someone else', { domain: 'outreach' }, 'needs_approval', 'approval_domain'],
    ['publishing a story from her study', { domain: 'aether_study', reachesOthers: true }, 'needs_approval', 'reaches_others'],
    ['a look whose result would reach someone else', { domain: 'room_look', reachesOthers: true }, 'needs_approval', 'reaches_others'],
    ['a Notion step that would reach someone else', { domain: 'notion_read', reachesOthers: true }, 'needs_approval', 'reaches_others'],
    ['a workspace script that posts', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/tools/post.mjs'], reachesOthers: true }, 'needs_approval', 'reaches_others'],
    // Never.
    ['buying something', { domain: 'spending' }, 'forbidden', 'forbidden_domain'],
    ['a paid subscription from her study', { domain: 'aether_study', spendsMoney: true }, 'forbidden', 'spending'],
    ['copying herself', { domain: 'self_replication' }, 'forbidden', 'forbidden_domain'],
    ['starting another instance from the workspace', { domain: 'vm_workspace', paths: ['/srv/shannon-workspace/tools/spawn.mjs'], replicatesSelf: true }, 'forbidden', 'self_replication'],
    ['copying her memory into her folder', { domain: 'host_folder', host: 'owner-mac', paths: ['/Users/owner/Shannon/memory-copy.sqlite'], replicatesSelf: true }, 'forbidden', 'self_replication'],
    ['impersonation', { domain: 'impersonation' }, 'forbidden', 'forbidden_domain'],
    ['a message written as somebody else', { domain: 'owner_message', impersonates: true }, 'forbidden', 'impersonation'],
    ['private conversation content in a work', { domain: 'aether_study', usesPrivateConversationContent: true }, 'forbidden', 'private_content'],
    ['the declared prohibition', { domain: 'private_content_in_work' }, 'forbidden', 'forbidden_domain'],
    // Unknown is refused.
    ['an unknown domain', { domain: 'minecraft_server' }, 'forbidden', 'unknown_domain'],
    ['an unregistered host', { domain: 'host_folder', host: 'friends-pc', paths: ['/Users/friend/Shannon/a.md'] }, 'forbidden', 'unknown_host'],
    ['a host folder request without a host', { domain: 'host_folder', paths: ['/Users/owner/Shannon/a.md'] }, 'forbidden', 'unknown_host'],
    ['a folder request with no path', { domain: 'host_folder', host: 'owner-mac' }, 'forbidden', 'malformed_request'],
    ['a relative path', { domain: 'vm_workspace', paths: ['tools/a.mjs'] }, 'forbidden', 'unresolvable_path'],
    ['a model with no known price', { domain: 'thinking', paid: { model: 'mystery-model', estimatedCostYen: 1 } }, 'forbidden', 'unknown_model'],
    ['a negative estimate', { domain: 'thinking', paid: { model: 'gpt-5.6-luna', estimatedCostYen: -1 } }, 'forbidden', 'malformed_request'],
    ['a non-numeric estimate', { domain: 'thinking', paid: { model: 'gpt-5.6-luna', estimatedCostYen: Number.NaN } }, 'forbidden', 'malformed_request'],
    ['an empty summary', { summary: ' ' }, 'forbidden', 'malformed_request'],
    ['a public read with no address', { domain: 'public_read' }, 'forbidden', 'malformed_request'],
    ['a private address', { domain: 'public_read', urls: ['http://192.168.1.10/admin'] }, 'forbidden', 'malformed_request'],
    ['a local file URL', { domain: 'public_read', urls: ['file:///etc/passwd'] }, 'forbidden', 'malformed_request'],
    ['a URL with credentials', { domain: 'public_read', urls: ['https://user:secret@example.org/'] }, 'forbidden', 'malformed_request'],
  ];

  it.each(cases)('%s', (_name, request, decision, reason) => {
    const result = decide(request);
    expect([result.decision, result.reason]).toEqual([decision, reason]);
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('refuses outright, in a session that read the owner\'s documents, anything that reaches someone else (ADR-0007)', () => {
    for (const domain of ['aether_study', 'outreach', 'owner_message', 'vm_workspace']) {
      expect(decide({ domain, reachesOthers: true, ...(domain === 'vm_workspace' ? { paths: ['/srv/shannon-workspace/tools/post.mjs'] } : {}) }, { ownerInformed: true }))
        .toMatchObject({ decision: 'forbidden', reason: 'owner_informed', domain: 'outreach' });
    }
    // Before the switches: no approval can lift it, and the rest of what she does is decided as before.
    expect(decide({ domain: 'outreach', reachesOthers: true }, { ownerInformed: true, paused: true })).toMatchObject({ decision: 'forbidden', reason: 'owner_informed' });
    expect(decide({ domain: 'aether_study' }, { ownerInformed: true })).toMatchObject({ decision: 'allow', reason: 'free_domain' });
    expect(decide({ domain: 'outreach', reachesOthers: true })).toMatchObject({ decision: 'needs_approval', reason: 'reaches_others' });
  });

  it('covers every domain of the vocabulary with its rule', () => {
    const expected = { free: 'allow', approval: 'needs_approval', forbidden: 'forbidden' } as const;
    const requests: Record<string, Partial<AutonomousActionRequest>> = {
      host_folder: { host: 'owner-mac', paths: ['/Users/owner/Shannon/a.md'] },
      vm_workspace: { paths: ['/srv/shannon-workspace/a.md'] },
      public_read: { urls: ['https://example.org/'] },
    };
    for (const domain of SHANNON_AUTONOMY_DOMAINS) {
      expect(decide({ domain: domain.id, ...requests[domain.id] }).decision, domain.id).toBe(expected[domain.rule]);
    }
  });

  it('limits looks at the room: her own daily count, inside the hour and day limits shared with conversation looks', () => {
    const look = (looks: Partial<typeof ROOM_LOOKS> | undefined, overrides: Partial<AutonomyPolicyContext> = {}) => decide(
      { domain: 'room_look', tool: 'study.look', paid: { model: 'gemini-3.8-flash', estimatedCostYen: 8 } },
      { roomLooks: looks ? { ...ROOM_LOOKS, ...looks } : undefined, ...overrides },
    );
    const refused = { decision: 'forbidden', reason: 'access_limit', domain: 'room_look' };
    expect(look({ activityToday: 2 })).toMatchObject({ decision: 'allow', reason: 'free_domain', domain: 'room_look' });
    // Her own count of the day.
    expect(look({ activityToday: 3 })).toMatchObject(refused);
    expect(look({ maximumActivityPerDay: 0 })).toMatchObject(refused);
    // The overall limits count conversation looks too: five in the last hour leave one, six leave none.
    expect(look({ lastHour: 5 }).decision).toBe('allow');
    expect(look({ lastHour: 6 })).toMatchObject(refused);
    expect(look({ today: 29 }).decision).toBe('allow');
    expect(look({ today: 30 })).toMatchObject(refused);
    expect(look({ maximumPerHour: 0 })).toMatchObject(refused);
    expect(look({ maximumPerDay: 0 })).toMatchObject(refused);
    // Without the counts (looks switched off, or a service that is not the loop's) nothing is allowed.
    expect(look(undefined)).toMatchObject(refused);
    // The switches, the prohibitions and the budget are the same as for every domain.
    expect(look({}, { paused: true })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    expect(look({}, { enabled: false })).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    expect(look({}, { budget: { capYen: 1_000, spentYen: 995 } })).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted', domain: 'room_look' });
    expect(look({}, { budget: { capYen: 1_000, spentYen: 1_000 } })).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    expect(decide({ domain: 'room_look', paid: { model: 'mystery-vision', estimatedCostYen: 1 } })).toMatchObject({ decision: 'forbidden', reason: 'unknown_model' });
    expect(decide({ domain: 'room_look', spendsMoney: true }).reason).toBe('spending');
    expect(decide({ domain: 'room_look', usesPrivateConversationContent: true }).reason).toBe('private_content');
    // The limit of looks is counted apart from reading.
    expect(decide({ domain: 'notion_read' }, { roomLooks: undefined }).decision).toBe('allow');
    expect(decide({ domain: 'public_read', urls: ['https://example.org/a'] }, { roomLooks: { ...ROOM_LOOKS, today: 30 } }).decision).toBe('allow');
  });

  it('names the core area a path belongs to', () => {
    const area = (path: string) => decide({ domain: 'vm_workspace', paths: [`/srv/shannon-workspace/shannon-checkout/${path}`] }).coreArea;
    expect(area('packages/cognition/src/persona.ts')).toBe('persona');
    expect(area('packages/cognition/src/emotionState.ts')).toBe('emotion');
    expect(area(apiSourcePath('deviceAuth.ts'))).toBe('authentication');
    expect(area('packages/cognition/src/withholding.ts')).toBe('memory');
    expect(area(apiSourcePath('autonomyPolicy.ts'))).toBe('approval_and_budget');
    expect(area(apiSourcePath('autonomyActivity.ts'))).toBe('activity_record');
    expect(area(apiSourcePath('apiKernel.ts'))).toBe('response_path');
    expect(area('deploy/azure/api.env.example')).toBe('deployment');
    expect(area('AGENTS.md')).toBe('purpose');
    expect(area('PACKAGES/Cognition/SRC/Persona.ts')).toBe('persona');
  });

  it('tells the executor which roots an allowed step must stay inside', () => {
    expect(decide({ domain: 'host_folder', host: 'owner-mac', paths: ['/Users/owner/Shannon/a.md'] }).allowedRoots).toEqual(['/Users/owner/Shannon']);
    expect(decide({ domain: 'aether_study' }).allowedRoots).toBeUndefined();
  });
});

describe('authorizeAutonomousAction: switches and budget', () => {
  const free: Partial<AutonomousActionRequest> = { domain: 'aether_study' };

  it('refuses everything while the server switch is off', () => {
    expect(decide(free, { enabled: false })).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    expect(decide({ domain: 'core' }, { enabled: false })).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
  });

  it('refuses everything while the owner has paused her, including proposals', () => {
    expect(decide(free, { paused: true })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    expect(decide({ domain: 'core' }, { paused: true })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    expect(decide({ domain: 'outreach' }, { paused: true })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
  });

  it('still names a prohibition as a prohibition while paused', () => {
    expect(decide({ domain: 'aether_study', replicatesSelf: true }, { paused: true }).reason).toBe('self_replication');
    expect(decide({ domain: 'spending' }, { enabled: false }).reason).toBe('forbidden_domain');
  });

  it('refuses a paid step that does not fit in the day', () => {
    const paid = (estimatedCostYen: number, spentYen: number, capYen = 1_000) =>
      decide({ domain: 'thinking', paid: { model: 'gpt-5.6-luna', estimatedCostYen } }, { budget: { capYen, spentYen } });
    expect(paid(10, 0).decision).toBe('allow');
    expect(paid(10, 990).decision).toBe('allow');
    expect(paid(10.01, 990)).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    expect(paid(0, 1_000)).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    expect(paid(1, 1_200)).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
    expect(paid(500, 1_200, 2_000).decision).toBe('allow');
    expect(paid(1, 0, 0)).toMatchObject({ decision: 'forbidden', reason: 'budget_exhausted' });
  });

  it('keeps unpaid steps available after the cap is reached', () => {
    expect(decide(free, { budget: { capYen: 1_000, spentYen: 1_000 } }).decision).toBe('allow');
  });

  it('stops careless external access at the daily limit', () => {
    const read = (publicReadsToday: number, urls = ['https://example.org/a']) =>
      decide({ domain: 'public_read', urls }, { publicReadsToday, maximumPublicReadsPerDay: 3 });
    expect(read(2).decision).toBe('allow');
    expect(read(3)).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    expect(read(2, ['https://example.org/a', 'https://example.org/b'])).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
  });

  it('limits Notion reads per day and allows none when no limit is supplied', () => {
    const read = (overrides: Partial<AutonomyPolicyContext>) => decide({ domain: 'notion_read' }, overrides);
    expect(read({ notionReadsToday: 2, maximumNotionReadsPerDay: 3 }).decision).toBe('allow');
    expect(read({ notionReadsToday: 3, maximumNotionReadsPerDay: 3 })).toMatchObject({ decision: 'forbidden', reason: 'access_limit', domain: 'notion_read' });
    expect(read({ maximumNotionReadsPerDay: 0 })).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    expect(read({ notionReadsToday: undefined, maximumNotionReadsPerDay: undefined })).toMatchObject({ decision: 'forbidden', reason: 'access_limit' });
    // The switches and the prohibitions come first, as for every domain.
    expect(read({ paused: true })).toMatchObject({ decision: 'forbidden', reason: 'paused' });
    expect(read({ enabled: false })).toMatchObject({ decision: 'forbidden', reason: 'disabled' });
    expect(decide({ domain: 'notion_read', spendsMoney: true }).reason).toBe('spending');
    // The public-read limit and the Notion limit are counted apart.
    expect(read({ publicReadsToday: 200 }).decision).toBe('allow');
    expect(decide({ domain: 'public_read', urls: ['https://example.org/a'] }, { notionReadsToday: 100 }).decision).toBe('allow');
  });

  it('refuses malformed input of any shape', () => {
    for (const bad of [null, undefined, 'core', [], { domain: 1, summary: 'x' }, { domain: 'thinking' },
      { domain: 'thinking', summary: 'x', paths: 'a' }, { domain: 'thinking', summary: 'x', replicatesSelf: 'no' },
      { domain: 'thinking', summary: 'x'.repeat(301) }, { domain: 'thinking', summary: 'x', paths: Array(65).fill('/a') }]) {
      expect(authorizeAutonomousAction(bad as never, context())).toMatchObject({ decision: 'forbidden', reason: 'malformed_request' });
    }
  });

  it('does not decide when a protected place cannot be resolved', () => {
    const result = decide({ domain: 'vm_workspace', paths: ['/srv/shannon-workspace/a.md'] },
      { resolvePath: path => (path.startsWith('/home/azureuser/shannon-ios-data') ? null : normalize(path)) });
    expect(result).toMatchObject({ decision: 'forbidden', reason: 'unresolvable_path' });
  });
});

describe('authorizeAutonomousAction: real paths, symbolic links and ..', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'shannon-autonomy-')));
  const folder = join(base, 'owner', 'Shannon');
  const documents = join(base, 'owner', 'Documents');
  const workspace = join(base, 'workspace');
  const checkout = join(workspace, 'shannon-checkout');
  const production = join(base, 'production');
  mkdirSync(join(folder, 'drafts'), { recursive: true });
  mkdirSync(documents, { recursive: true });
  mkdirSync(join(checkout, 'packages/cognition/src'), { recursive: true });
  mkdirSync(join(production, 'services/api/src'), { recursive: true });
  writeFileSync(join(documents, 'novel.md'), 'owner');
  writeFileSync(join(checkout, 'packages/cognition/src/persona.ts'), '// persona');
  symlinkSync(documents, join(folder, 'shortcut'));
  symlinkSync(join(checkout, 'packages/cognition/src/persona.ts'), join(workspace, 'innocent.ts'));
  symlinkSync(join(base, 'nowhere'), join(folder, 'dangling'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const real = (request: Partial<AutonomousActionRequest>) => decide(request, {
    resolvePath: resolvePhysicalPath,
    places: { hostFolders: { 'owner-mac': folder }, workspaceRoot: workspace, productionRoots: [production], repositoryRoots: [production, checkout], protectedPaths: [] },
  });

  it('allows an existing and a not-yet-existing file inside her folder', () => {
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [join(folder, 'drafts'), join(folder, 'drafts/new/story.md')] }).decision).toBe('allow');
  });

  it('judges a link inside her folder by where it points', () => {
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [join(folder, 'shortcut/novel.md')] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'outside_own_area' });
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [join(folder, 'shortcut/new-file.md')] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'outside_own_area' });
  });

  it('finds core behind a link with an innocent name', () => {
    expect(real({ domain: 'vm_workspace', paths: [join(workspace, 'innocent.ts')] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'core_path', coreArea: 'persona' });
  });

  it('applies .. to the real parent', () => {
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [`${folder}/drafts/../../Documents/novel.md`] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'outside_own_area' });
    // `shortcut/..` is the parent of Documents, not her folder.
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [`${folder}/shortcut/../Shannon-notes.md`] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'outside_own_area' });
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [`${folder}/drafts/../drafts/story.md`] }).decision).toBe('allow');
    // A missing component followed by .. must not hide the link that comes after it.
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [`${folder}/missing/../shortcut/novel.md`] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'outside_own_area' });
  });

  it('refuses a dangling link, whose target is unknown', () => {
    expect(real({ domain: 'host_folder', host: 'owner-mac', paths: [join(folder, 'dangling/file.md')] }))
      .toMatchObject({ decision: 'forbidden', reason: 'unresolvable_path' });
  });

  it('protects the production area even through the workspace domain', () => {
    expect(real({ domain: 'vm_workspace', paths: [join(production, 'services/api/src/new-tool.ts')] }))
      .toMatchObject({ decision: 'needs_approval', reason: 'production_area' });
  });

  it('resolves paths physically', () => {
    expect(resolvePhysicalPath('relative/path')).toBeNull();
    expect(resolvePhysicalPath('')).toBeNull();
    expect(resolvePhysicalPath(`${folder}/a\0b`)).toBeNull();
    expect(resolvePhysicalPath(join(folder, 'shortcut'))).toBe(documents);
    expect(resolvePhysicalPath(`${folder}/./drafts//x/../y.md`)).toBe(join(folder, 'drafts/y.md'));
  });
});
