import { describe, expect, it, vi } from 'vitest';
import { HttpVoyagerCatalog, DisabledVoyagerCatalog, createConfiguredVoyagerCatalog, type VoyagerCatalog } from '../src/integrations/voyager/organizeIntegrations.js';
import { OrganizeError } from '../src/integrations/voyager/organizeSupport.js';
import { conversationCapabilityPrompt } from '../src/mind/action/respond/conversationCapabilities.js';
import { readToolPorts } from '../src/wiring/skillRoutingWiring.js';

const task = { id: 'synthetic-task', title: '申告書を提出する', details: 'data only', status: 'pending', projectIds: [], revision: 3,
  updatedAt: '2026-10-09T00:00:00Z', dueAt: '2026-10-10T00:00:00Z', priority: 4 };
const owner = { aetherNotes: false, voyagerTasks: true, upcoming: false, ownOutreach: false } as const;
const catalog = (fetcher: typeof fetch) => new HttpVoyagerCatalog({ tasksEndpoint: 'https://synthetic.invalid/api/integrations/syzygy/v1/tasks/search',
  projectsEndpoint: 'https://synthetic.invalid/api/integrations/syzygy/v1/projects', token: 'synthetic-token', workspaceId: 'synthetic-workspace', fetcher });
const envelope = { contractVersion: '1.1', workspaceId: 'synthetic-workspace', items: [task], hasMore: true };

describe('Voyager bounded open read', () => {
  it('uses the authenticated no-keyword contract and preserves coverage and task metadata', async () => {
    let url: URL | undefined;
    let headers: Headers | undefined;
    const reader = catalog(async (input, init) => { url = new URL(String(input)); headers = new Headers(init?.headers); return Response.json(envelope); });
    const result = await reader.listOpenTasks(6);
    expect(url!.pathname).toBe('/api/integrations/syzygy/v1/tasks/open');
    expect(url!.searchParams.get('query')).toBeNull();
    expect(url!.searchParams.get('workspaceId')).toBe('synthetic-workspace');
    expect(url!.searchParams.get('limit')).toBe('6');
    expect(headers!.get('x-syzygy-contract-version')).toBe('1.1');
    expect(headers!.get('authorization')).toBe('Bearer synthetic-token');
    expect(result).toEqual({ items: [task], hasMore: true });
    const projection = await conversationCapabilityPrompt('', '今やることある？', { voyagerCatalog: reader }, owner);
    expect(projection).toContain('This list is truncated');
    expect(projection).toContain('"dueAt":"2026-10-10T00:00:00Z"');
    expect(projection).toContain('"revision":3');
    expect(projection).not.toContain('Keyword searched');
  });

  it.each([
    { ...envelope, hasMore: undefined },
    { ...envelope, items: [{ ...task, status: 'done' }] },
    { ...envelope, items: [{ ...task, dueAt: 'not-a-date' }] },
    { ...envelope, workspaceId: 'another-workspace' },
  ])('rejects misleading or invalid open-list evidence', async value => {
    await expect(catalog(async () => Response.json(value)).listOpenTasks(6)).rejects.toMatchObject({ code: 'DESTINATION_RESPONSE_INVALID' });
  });

  it('uses the same open read for empty-query tools and keeps the audience selection', async () => {
    const listOpenTasks = vi.fn(async () => ({ items: [task], hasMore: false }));
    const searchTasks = vi.fn(async () => []);
    const reader: VoyagerCatalog = { listOpenTasks, searchTasks, listProjects: async () => [] };
    const prompt = await conversationCapabilityPrompt('', 'タスク', { voyagerCatalog: reader }, owner);
    const ports = readToolPorts({}, { voyagerCatalog: reader, notion: null, upcoming: { promptFor: () => '' },
      chatModel: { mode: 'local-stub', model: 'synthetic', generate: async () => ({ mode: 'local-stub', model: 'synthetic', reply: 'はい。' }) } });
    expect(await ports!.voyagerTasks!('')).toEqual({ text: prompt, sourceIds: ['voyager-task://synthetic-task'] });
    await conversationCapabilityPrompt('', '今やることある？', { voyagerCatalog: reader }, { ...owner, voyagerTasks: false });
    expect(listOpenTasks).toHaveBeenCalledTimes(2);
    expect(searchTasks).not.toHaveBeenCalled();
  });

  it('distinguishes empty, unconfigured, denied, timeout and older server reads', async () => {
    const prompt = (reader: VoyagerCatalog) => conversationCapabilityPrompt('', 'やることある？', { voyagerCatalog: reader }, owner);
    expect(await prompt(catalog(async () => Response.json({ ...envelope, items: [], hasMore: false })))).toContain('There are no open tasks in this workspace');
    expect(await prompt(new DisabledVoyagerCatalog())).toContain('integration is not configured');
    expect(await prompt(catalog(async () => Response.json({ error: { code: 'FORBIDDEN', retryable: false } }, { status: 403 })))).toContain('denied access');
    expect(await prompt(catalog(async () => { throw new DOMException('deadline', 'TimeoutError'); }))).toContain('timed out');
    expect(await prompt({ searchTasks: async () => [], listProjects: async () => [] })).toContain('does not support this open task read yet');
    const invalid = catalog(async () => { throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true); });
    expect(await prompt(invalid)).toContain('Do not claim no tasks exist');
  });

  it('keeps escaped rows whole, reports prompt truncation and pins only shown task IDs', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ ...task, id: `t${index}`, title: '\\'.repeat(160), details: '"'.repeat(400) }));
    const sourceIds: string[] = [];
    const reader: VoyagerCatalog = { listOpenTasks: async () => ({ items, hasMore: false }), searchTasks: async () => [], listProjects: async () => [] };
    const prompt = await conversationCapabilityPrompt('', 'タスク', { voyagerCatalog: reader, aetherContext: { promptFor: () => 'a'.repeat(6_000) } },
      { ...owner, aetherNotes: true }, ids => sourceIds.push(...ids));
    const json = prompt.split('\n').find(line => line.startsWith('[{'))!;
    const shown = JSON.parse(json) as typeof items;
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(items.length);
    expect(prompt).toContain('hasMore: true');
    expect(prompt).not.toContain('complete open task list');
    expect(sourceIds.filter(id => id.startsWith('voyager-task://'))).toEqual(shown.map(row => `voyager-task://${row.id}`));
  });

  it('derives configured open-read URL from the existing integration authority', () => {
    expect(createConfiguredVoyagerCatalog({ SHANNON_VOYAGER_INTEGRATION_URL: 'https://synthetic.invalid/api/integrations/syzygy/v1/task-changes:apply',
      SHANNON_VOYAGER_INTEGRATION_TOKEN: 'synthetic', SHANNON_VOYAGER_WORKSPACE_ID: 'synthetic' }).listOpenTasks).toBeTypeOf('function');
  });
});
