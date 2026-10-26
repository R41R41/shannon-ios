import { describe, expect, it } from 'vitest';
import { type ShannonApiKernelOptions } from '../src/infra/http/apiKernel.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import type { NotionSource } from '../src/integrations/notion/notionSource.js';
import type { VoyagerCatalog } from '../src/integrations/voyager/organizeIntegrations.js';
import { readToolPlan } from '../src/mind/action/respond/conversationCapabilities.js';
import { createInMemoryAutonomyService } from '../src/wiring/autonomyServiceWiring.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { READ_TOOL_DOMAINS, WEB_CAPABILITY_ENTRY, isReadToolDomain } from '../src/mind/tools/shannonTools.js';
import type { TurnChooser } from '../src/mind/selectors/turnChoices.js';
import { readToolPorts } from '../src/wiring/skillRoutingWiring.js';

/** Syzygy ADR-0008 stage 2, step 3: her read tools in place of the projections they fold, with today's audience rules. */
const at = '2026-10-07T03:00:00.000Z';
const NOTION_MARK = 'ノーションの本文マーク';
const TASK_MARK = 'ボイジャーのタスクマーク';
const SCHEDULE_HEADER = "[Owner's upcoming items";
const ASK_ALL = 'Notionの「設定」と、今日の予定と、Voyagerのタスク「買い物」を見せて';

const notion: NotionSource = {
  connected: true,
  search: async () => [{ id: 'p1', kind: 'page', title: '設定', url: 'https://www.notion.so/p1', lastEditedAt: null }],
  readPage: async id => ({ id, kind: 'page', title: '設定', url: 'https://www.notion.so/p1', lastEditedAt: null, text: NOTION_MARK, truncated: false, skippedBlocks: 0 }),
  queryDatabase: async () => { throw new Error('not used'); },
  diagnostics: () => { throw new Error('not used'); },
};
const voyagerCatalog: VoyagerCatalog = {
  searchTasks: async () => [{ id: 't1', title: TASK_MARK, status: 'open', revision: 1, updatedAt: at } as never],
  listProjects: async () => [],
};

class RecordingModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly all: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
  async generate(request: ShannonChatModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。', ...(request.useWebSearch ? {} : {}) }; }
  async generateVoice(request: ShannonVoiceModelRequest) { this.all.push(request); return { mode: this.mode, model: this.model, reply: 'はい。' }; }
}

function kernel(reads: boolean, extra: Partial<ShannonApiKernelOptions> = {}) {
  const model = new RecordingModel();
  const autonomy = createInMemoryAutonomyService(() => at);
  const options: ShannonApiKernelOptions = { chatModel: model, notion, voyagerCatalog, autonomy, ...extra };
  const api = createLocalApiKernel(() => at, options);
  // The upcoming reader the kernel built, as server.ts hands it to the ports.
  const upcoming = (api as unknown as { upcoming: { promptFor(scopeKey: string, message: string, present?: 'owner' | 'others'): string } }).upcoming;
  if (reads) {
    const ports = readToolPorts({}, { notion, voyagerCatalog, upcoming, chatModel: model });
    autonomy.tools.useReads(ports!);
    (api as unknown as { readTools: boolean }).readTools = true;
  }
  return { api, model, autonomy };
}

const text = async (k: ReturnType<typeof kernel>, message: string, extra: Record<string, unknown> = {}) => {
  const response = await k.api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message, ...extra } });
  expect(response.status).toBe(200);
  return k.model.all.at(-1) as ShannonChatModelRequest;
};
const voice = async (k: ReturnType<typeof kernel>, transcript: string, extra: { companionPresent?: boolean; participantMode?: 'guest' } = {}) => {
  const response = await k.api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
    scopeKey: 'owner', threadId: 'thread-voice', transcript, ...(extra.participantMode ? { participantMode: extra.participantMode } : {}),
    deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...(extra.companionPresent ? { companionPresent: true } : {}),
      userUtterance: { id: `u-${transcript.length}`, text: transcript, source: 'speech', rawText: transcript,
        ...(extra.participantMode ? { callContext: { callId: 'call-reads-0001', turns: [], introductionStart: true } } : {}) } },
  } });
  expect(response.status).toBe(200);
  return k.model.all.at(-1) as ShannonVoiceModelRequest | undefined;
};
const readToolsOf = (request: { tools?: ShannonChatModelRequest['tools'] } | undefined) =>
  (request?.tools?.menu?.offered ?? request?.tools?.definitions ?? []).filter(tool => isReadToolDomain(tool.domain)).map(tool => tool.domain).sort();
const projected = (request: { turnContext?: string } | undefined) => ({
  notion: request?.turnContext?.includes(NOTION_MARK) ?? false, tasks: request?.turnContext?.includes(TASK_MARK) ?? false,
  schedule: request?.turnContext?.includes(SCHEDULE_HEADER) ?? false,
});

describe('her read tools in the registry and the runner', () => {
  it('exist only while the runner has their ports, for the owner alone in a conversation, and never in her own time', () => {
    const off = createInMemoryAutonomyService(() => at).tools;
    expect(off.offered('text', 'owner_alone', 'owner').some(tool => isReadToolDomain(tool.domain))).toBe(false);
    expect(off.knownTool('notion_read')).toBeNull();
    const on = createInMemoryAutonomyService(() => at).tools;
    on.useReads({ notion: async () => ({ text: 'x', sources: [] }), upcoming: () => 'y' });
    // Only the ports handed exist.
    expect(on.offered('text', 'owner_alone', 'owner').filter(tool => isReadToolDomain(tool.domain)).map(tool => tool.name)).toEqual(['notion.read', 'schedule.upcoming']);
    expect(on.offered('voice', 'owner_alone', 'owner').filter(tool => isReadToolDomain(tool.domain))).toHaveLength(2);
    expect(on.offered('text', 'others', 'owner').some(tool => isReadToolDomain(tool.domain))).toBe(false);
    expect(on.offered('autonomy', 'owner_alone', 'owner').some(tool => isReadToolDomain(tool.domain))).toBe(false);
    expect(on.knownTool('voyager_tasks')).toBeNull();
  });

  it('run the same read as the projection, record the call without its content, and refuse anyone else', async () => {
    const k = kernel(true);
    const runner = k.autonomy.tools;
    const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    const read = await runner.call('notion.read', JSON.stringify({ query: '設定' }), context);
    expect(read.ok).toBe(true);
    expect(read.text).toContain(NOTION_MARK);
    expect(read.text).toContain('https://www.notion.so/p1');
    expect((await runner.call('voyager.tasks', JSON.stringify({ query: '買い物' }), context)).text).toContain(TASK_MARK);
    expect((await runner.call('schedule.upcoming', JSON.stringify({ range: 'week' }), context)).text).toContain(SCHEDULE_HEADER);
    const refused = await runner.call('schedule.upcoming', '{}', { ...context, audience: 'others' });
    expect(refused).toMatchObject({ ok: false, failure: 'not_offered' });
    const entries = k.autonomy.activityDays('owner', 30).flatMap(day => day.entries);
    expect(entries.map(entry => entry.tool)).toEqual(expect.arrayContaining(['notion.read', 'voyager.tasks', 'schedule.upcoming']));
    expect(JSON.stringify(entries)).not.toMatch(/設定|買い物|ノーション|ボイジャー/u);
  });

  it('are handed by the wiring only while SHANNON_READ_TOOLS is on (and stage 2)', () => {
    const parts = { notion, voyagerCatalog, upcoming: { promptFor: () => '' }, chatModel: new RecordingModel() };
    expect(readToolPorts({ SHANNON_READ_TOOLS: 'off' }, parts)).toBeNull();
    expect(readToolPorts({ SHANNON_ADR8_STAGE2: 'off' }, parts)).toBeNull();
    expect(Object.keys(readToolPorts({}, parts)!).sort()).toEqual(['daily', 'notion', 'places', 'upcoming', 'voyagerTasks']);
  });
});

describe('the audience matrix of her reads: as today, with the read tools on', () => {
  it('keeps every projection of a text turn of the owner alone as it was, and offers the tools beside them', async () => {
    const off = await text(kernel(false), ASK_ALL);
    expect(projected(off)).toEqual({ notion: true, tasks: true, schedule: true });
    expect(readToolsOf(off)).toEqual([]);
    const on = await text(kernel(true), ASK_ALL);
    // No turn is slower or poorer than today: the same projections, the same turn context, and the tools in addition.
    expect(on.turnContext).toBe(off.turnContext);
    // This recording model has no native search port. The schedule has two tools: its search and its free time.
    expect(readToolsOf(on)).toEqual([...READ_TOOL_DOMAINS.filter(domain => domain !== 'web_search'), 'schedule_read'].sort());
    // Her description says so in that turn only.
    expect(on.systemPrompt).toContain('読む道具:');
    expect(off.systemPrompt).not.toContain('読む道具:');
  });

  it('sends exactly today\'s request to every turn with anyone else present, on text and on voice', async () => {
    const seen: boolean[] = [];
    for (const run of [
      (k: ReturnType<typeof kernel>) => text(k, ASK_ALL, { audience: 'others' }),
      (k: ReturnType<typeof kernel>) => voice(k, ASK_ALL, { companionPresent: true }),
      (k: ReturnType<typeof kernel>) => voice(k, ASK_ALL, { participantMode: 'guest' }),
    ]) {
      const off = await run(kernel(false));
      const on = await run(kernel(true));
      expect(on).toEqual(off);
      seen.push(off !== undefined);
      expect(readToolsOf(on)).toEqual([]);
    }
    // The text turn and the companion's turn reach the model (a guest's unaddressed turn may not).
    expect(seen.slice(0, 2)).toEqual([true, true]);
  });

  it('keeps every voice projection as it was and adds the tools only for the owner alone, in a turn that offers tools', async () => {
    const offPlain = await voice(kernel(false), '今日の予定ある？');
    const onPlain = await voice(kernel(true), '今日の予定ある？');
    expect(onPlain).toEqual(offPlain);
    const offTools = await voice(kernel(false), '書斎のメモと今日の予定を見せて');
    const onTools = await voice(kernel(true), '書斎のメモと今日の予定を見せて');
    expect(projected(onTools)).toEqual(projected(offTools));
    expect(readToolsOf(onTools)).toEqual([...READ_TOOL_DOMAINS.filter(domain => domain !== 'web_search'), 'schedule_read'].sort());
  });

  it('reads as today when the session does not serve the tools: others known to the server, or Jev chose the web', async () => {
    const k = kernel(true);
    await voice(k, 'こんにちは', { participantMode: 'guest' });
    const withheld = await text(k, ASK_ALL);
    expect(readToolsOf(withheld)).toEqual([]);
    expect(projected(withheld)).toEqual({ notion: true, tasks: true, schedule: true });
    const web: TurnChooser = { choose: async request => ({ menu: { chosen: request.menu.some(item => item.name === WEB_CAPABILITY_ENTRY.name) ? [WEB_CAPABILITY_ENTRY.name] : [] } }) };
    const searched = await text(kernel(true, { turnChooser: web }), ASK_ALL);
    expect(searched.useWebSearch).toBe(true);
    expect(projected(searched)).toEqual({ notion: true, tasks: true, schedule: true });
  });

  it('keeps the offer to the projections\' own audience rules', () => {
    expect(readToolPlan(undefined).offer).toEqual({ notion_read: true, voyager_read: true, schedule_read: true, places_search: true, web_search: true });
    // A guarded schedule (others present) is never a tool; nor is a read the selection switched off.
    expect(readToolPlan({ aetherNotes: false, voyagerTasks: false, notion: false, upcoming: 'guarded' }).offer).toMatchObject({ notion_read: false, voyager_read: false, schedule_read: false });
  });
});
