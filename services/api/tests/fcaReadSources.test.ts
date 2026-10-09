import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { SQLiteUpcomingStore } from '../src/mind/memory/store/upcomingStore.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { studyExecutors } from '../src/mind/tools/shannonStudyTools.js';
import { readToolExecutors } from '../src/mind/tools/shannonReadTools.js';
import { folderExecutors } from '../src/mind/tools/shannonFolderTools.js';
import { skillExecutors } from '../src/mind/tools/shannonSkillTools.js';
import { toolSessionMemory, type PreparedToolCall } from '../src/mind/tools/shannonToolTypes.js';
import type { HostFolderOperations } from '../src/mind/action/ownTime/hostFolderOperations.js';
import { readToolPorts } from '../src/wiring/skillRoutingWiring.js';
import { fcaReadReceiptSources } from '../src/mind/action/fca/fcaConversationSources.js';

const at = '2026-10-09T00:00:00.000Z', cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));
const context = () => ({ scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() });
function fixture() {
  const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  const store = new SQLiteAutonomyStore(':memory:'); cleanup.push(() => store.close());
  let alone = true, connected = true;
  const visible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => alone, state, conversations, study: store.study,
    aetherAvailable: () => connected, notionAvailable: () => connected, voyagerAvailable: () => connected,
    skill: (_scope, id) => id === 'skill-1' ? { body: 'Bounded skill text' } : null,
    folderAvailable: (_scope, host) => host === 'owner-mac' && connected });
  const forget = (id: string) => state.apply('owner', { type: 'memory-control-upserted', control: {
    memoryId: id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner',
  } });
  return { state, conversations, store, visible, forget, setAlone: (value: boolean) => { alone = value; }, setConnected: (value: boolean) => { connected = value; } };
}

describe('FCA private read receipts', () => {
  it('checks schedule snapshot freshness at the current clock independently of future item windows and original read time', () => {
    const f = fixture(), store = new SQLiteUpcomingStore(':memory:'); cleanup.push(() => store.close());
    let currentAt = at;
    const future = new Date(Date.parse(at) + 14 * 24 * 60 * 60_000).toISOString();
    store.replaceCalendar('owner', 'local', { generatedAt: at, timeZone: 'Asia/Tokyo', windowStart: at, windowEnd: new Date(Date.parse(at) + 31 * 24 * 60 * 60_000).toISOString(),
      events: [{ id: 'future-1', title: 'Future event', start: future, end: new Date(Date.parse(future) + 60 * 60_000).toISOString(), allDay: false }] }, at);
    store.replaceTasks('owner', 'voyager', [{ id: 'task-1', title: 'Future task', dueAt: future }], at);
    const visible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, now: () => currentAt, state: f.state, conversations: f.conversations,
      voyagerAvailable: () => true, upcoming: { calendarEnabled: true, mayShareCalendar: () => true, store } });
    const calendar = `calendar-item://${encodeURIComponent(`calendar:future-1@${future}`)}`, task = 'calendar-item://task%3Atask-1';
    expect(visible('owner', calendar, at)).toBe(true); expect(visible('owner', task, at)).toBe(true);
    currentAt = new Date(Date.parse(at) + 7 * 60 * 60_000).toISOString();
    expect(visible('owner', task, at)).toBe(false); expect(visible('owner', calendar, at)).toBe(true);
    currentAt = new Date(Date.parse(at) + 8 * 24 * 60 * 60_000).toISOString();
    expect(visible('owner', calendar, at)).toBe(false);
    store.replaceTasks('owner', 'voyager', [{ id: 'task-1', title: 'Future task', dueAt: future }], currentAt);
    expect(visible('owner', task, at)).toBe(true);
    f.state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: task, kind: 'experience', status: 'active', pinned: false,
      overrideText: 'Corrected item', contextInvalidatedAt: currentAt, updatedAt: currentAt, changeReason: 'owner' } });
    expect(visible('owner', task, at)).toBe(false);
  });
  it('reuses only recognized provider receipts under the original owner scope, fresh audience and memory controls', () => {
    const f = fixture();
    const sources = ['aether-document://doc-1', 'notion-page://0123456789abcdef0123456789abcdef', 'voyager-task://task-1'];
    for (const id of sources) expect(f.visible('owner', id, at)).toBe(true);
    expect(f.visible('other', sources[0]!, at)).toBe(false);
    expect(f.visible('owner', 'arbitrary://doc-1', at)).toBe(false);
    expect(f.visible('owner', 'fca-unresolved://private-read', at)).toBe(false);
    expect(f.visible('owner', 'notion-page://not-a-page', at)).toBe(false);
    f.forget('doc-1'); expect(f.visible('owner', sources[0]!, at)).toBe(false);
    f.setAlone(false); expect(f.visible('owner', sources[1]!, at)).toBe(false);
    f.setAlone(true); f.setConnected(false); expect(f.visible('owner', sources[2]!, at)).toBe(false);
  });

  it('resolves study and skill references through their existing local readers and preserves own-time listing semantics', async () => {
    const f = fixture();
    const piece = f.store.study.create('owner', { kind: 'note', title: 'Study note', body: 'A sufficiently long local study note for the reader.' }, at);
    if (typeof piece === 'string') throw new Error(piece);
    const listing = studyExecutors(f.store, () => at)['study.list']!({}, context()) as PreparedToolCall;
    const run = await listing.run();
    expect(run.documents?.read).toBeUndefined();
    expect(run.documents?.sourceIds).toEqual([`shannon-study://${piece.id}`]);
    expect(f.visible('owner', `shannon-study://${piece.id}`, at)).toBe(true);
    expect(f.visible('owner', 'shannon-study://missing', at)).toBe(false);
    const skills = skillExecutors({ index: () => '', used: () => null, nextTurn() {}, open: () => ({ skillId: 'skill-1', name: 'fixture', body: 'Bounded skill text', status: 'active', version: 1 }) });
    const skill = await (skills['skill.read']!({ name: 'fixture' }, context()) as PreparedToolCall).run();
    expect(skill.documents?.sourceIds).toEqual(['shannon-skill://skill-1']);
    expect(f.visible('owner', skill.documents!.sourceIds![0]!, at)).toBe(true);
    f.forget(`shannon-study://${piece.id}`); expect(f.visible('owner', `shannon-study://${piece.id}`, at)).toBe(false);
  });

  it('attaches closed host/path digests without copying private paths or changing the read result', async () => {
    const f = fixture();
    const operations = { boundHosts: () => ['owner-mac'], presence: () => 'present', run: async () => ({ kind: 'done',
      result: { content: 'File content', sha256: 'a'.repeat(64), totalBytes: 12, offset: 0, nextOffset: null } }) } as unknown as HostFolderOperations;
    const call = folderExecutors(operations)['folder.read']!({ path: 'private-name.txt' }, context()) as PreparedToolCall;
    const run = await call.run(), id = run.documents!.sourceIds![0]!;
    expect(run.result.text).toContain('File content'); expect(id).not.toContain('private-name');
    expect(run.documents?.read).toBeUndefined(); expect(f.visible('owner', id, at)).toBe(true);
    f.setConnected(false); expect(f.visible('owner', id, at)).toBe(false);
  });

  it('preserves read projection text and records Voyager/Notion/schedule identifiers from the same reads', async () => {
    let searches = 0;
    const pageId = '0123456789abcdef0123456789abcdef';
    const ports = readToolPorts({}, { now: () => at, chatModel: { mode: 'local-stub', model: 'fixture', generate: async () => { throw new Error('no model'); } },
      voyagerCatalog: { listProjects: async () => [], searchTasks: async () => { searches++; return [{ id: 'task-1', title: 'Task text', status: 'open', revision: 1, updatedAt: at } as never]; } },
      notion: { connected: true, diagnostics: () => { throw new Error('unused'); }, queryDatabase: async () => { throw new Error('unused'); },
        search: async () => [{ id: pageId, kind: 'page', title: '設定', url: null, lastEditedAt: null }],
        readPage: async () => ({ id: pageId, kind: 'page', title: '設定', url: null, lastEditedAt: null, text: 'Page text', truncated: false, skippedBlocks: 0 }) },
      upcoming: { promptFor: () => 'Schedule text', promptWithSources: () => ({ prompt: 'Schedule text', sourceIds: ['promise:promise-1'] }) },
    })!;
    const tools = readToolExecutors(ports);
    const task = await (tools['voyager.tasks']!({ query: 'task' }, context()) as PreparedToolCall).run();
    expect(task.result.text).toContain('Task text'); expect(task.documents?.sourceIds).toEqual(['voyager-task://task-1']); expect(searches).toBe(1);
    const notion = await (tools['notion.read']!({ query: '設定' }, context()) as PreparedToolCall).run();
    expect(notion.result.text).toContain('Page text'); expect(notion.documents?.sourceIds).toEqual([`notion-page://${pageId}`]);
    const schedule = await (tools['schedule.upcoming']!({ range: 'day' }, context()) as PreparedToolCall).run();
    expect(schedule.result.text).toBe('Schedule text'); expect(schedule.documents?.sourceIds).toEqual(['calendar-item://promise%3Apromise-1']);
  });

  it('maps native documents and sideband sources without accepting missing or unknown private metadata as public', () => {
    expect(fcaReadReceiptSources({ name: 'aether.read', ok: true, documents: { read: ['doc-1'] } })).toEqual({ readSourceIds: ['aether-document://doc-1'] });
    expect(fcaReadReceiptSources({ name: 'study.list', ok: true, documents: { sourceIds: ['shannon-study://one'] } })).toEqual({ readSourceIds: ['shannon-study://one'] });
    expect(fcaReadReceiptSources({ name: 'study.read', ok: true }).readSourceIds?.[0]).toContain('fca-unresolved://');
    expect(fcaReadReceiptSources({ name: 'study.read', ok: true, documents: { read: ['opaque-unknown'] } }).readSourceIds?.[0]).toContain('fca-unresolved://');
    expect(fcaReadReceiptSources({ name: 'web.search', ok: true })).toEqual({});
  });
});
