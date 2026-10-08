import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { FileAetherContextReader } from '../src/integrations/aether/aetherContext.js';
import { conversationCapabilityContext } from '../src/mind/action/respond/conversationCapabilities.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { OwnerUpcoming } from '../src/mind/memory/ownerUpcoming.js';
import { SQLiteUpcomingStore } from '../src/mind/memory/store/upcomingStore.js';
import { createFcaReadSources } from '../src/wiring/fcaReadSources.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import type { FcaConversationPort } from '../src/mind/action/fca/fcaConversationPorts.js';

const at = '2026-10-09T00:00:00.000Z', cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));
function fileReader() {
  const dir = mkdtempSync(join(tmpdir(), 'fca-aether-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'context.json');
  writeFileSync(path, JSON.stringify({ version: 1, source: 'aether-ios', sharedAt: at,
    notes: [{ id: 'note-1', title: '設定', excerpt: '明示的に共有された本文', updatedAt: at, tags: [], type: 'note', status: 'active' }] }), { mode: 0o600 });
  return { reader: new FileAetherContextReader(path), path };
}

describe('initial FCA conversation read provenance', () => {
  it('keeps default context exactly shaped and carries the rendered IDs with no extra provider calls when opted in', async () => {
    const { reader } = fileReader(); let searches = 0, pageReads = 0, taskReads = 0;
    const pageId = '0123456789abcdef0123456789abcdef';
    const parts = { aetherContext: reader,
      voyagerCatalog: { listProjects: async () => [], searchTasks: async () => { taskReads++; return [{ id: 'task-1', title: '設定 task', status: 'open', revision: 1, updatedAt: at } as never]; } },
      notion: { connected: true, diagnostics: () => { throw new Error('unused'); }, queryDatabase: async () => { throw new Error('unused'); },
        search: async () => { searches++; return [{ id: pageId, kind: 'page' as const, title: '設定', url: null, lastEditedAt: null }]; },
        readPage: async () => { pageReads++; return { id: pageId, kind: 'page' as const, title: '設定', url: null, lastEditedAt: null, text: '設定の資料', truncated: false, skippedBlocks: 0 }; } },
    };
    const ordinary = await conversationCapabilityContext('owner', 'NotionとAetherの「設定」タスクを確認して', parts);
    expect(Object.keys(ordinary).sort()).toEqual(['prompt', 'sources']);
    const tracked = await conversationCapabilityContext('owner', 'NotionとAetherの「設定」タスクを確認して', parts, undefined, true);
    expect(tracked.prompt).toBe(ordinary.prompt); expect(tracked.sources).toEqual(ordinary.sources);
    expect(tracked.readSourceIds).toEqual(expect.arrayContaining(['aether-context://note-1', 'voyager-task://task-1', `notion-page://${pageId}`]));
    expect([searches, pageReads, taskReads]).toEqual([2, 2, 2]);
  });

  it('resolves the static Aether projection under its native file gate and fresh memory controls', () => {
    const { reader, path } = fileReader(), state = new InMemoryCompanionStateStore(() => at);
    const visible = createFcaReadSources({ ownerScope: 'owner', ownerAlone: () => true, state,
      conversations: new InMemoryConversationStore(), aetherContext: reader });
    expect(reader.promptWithSources('owner', 'Aether')).toEqual({ prompt: reader.promptFor('owner', 'Aether'), sourceIds: ['note-1'] });
    expect(visible('owner', 'aether-context://note-1', at)).toBe(true);
    expect(visible('owner', 'aether-context://missing', at)).toBe(false);
    chmodSync(path, 0o644); expect(visible('owner', 'aether-context://note-1', at)).toBe(false);
    chmodSync(path, 0o600);
    state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: 'note-1', kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'owner' } });
    expect(visible('owner', 'aether-context://note-1', at)).toBe(false);
  });

  it('takes schedule subjects from the exact same read and clock used to render the prompt', async () => {
    const store = new SQLiteUpcomingStore(':memory:'); cleanup.push(() => store.close());
    const state = new InMemoryCompanionStateStore(() => at); let clocks = 0;
    state.apply('owner', { type: 'prospective-memory-upserted', memory: { id: 'p-1', summary: '準備する', dueAt: '2026-10-09T01:00:00.000Z', status: 'pending', createdAt: at, updatedAt: at } });
    const upcoming = new OwnerUpcoming({ store, snapshot: scope => state.snapshot(scope), now: () => { clocks++; return at; } });
    const tracked = await conversationCapabilityContext('owner', '今日の予定', { upcoming }, { aetherNotes: false, voyagerTasks: false }, true);
    expect(tracked.prompt).toContain('準備する'); expect(tracked.readSourceIds).toEqual(['calendar-item://promise%3Ap-1']); expect(clocks).toBe(1);
  });

  it('passes initial provenance to the bridge before the unchanged foreground model call', async () => {
    const { reader } = fileReader(); let input: Parameters<FcaConversationPort['begin']>[0] | null = null, calls = 0;
    const port: FcaConversationPort = { begin(value) { input = value; return { context: () => '', commit() {}, abort() {} }; },
      taskToolsAvailable: () => false, executeTaskTool: () => ({ ok: false, text: '', retryable: false }), observeRead: () => false, observeSources: () => false };
    const kernel = createLocalApiKernel(() => at, { aetherContext: reader, fcaConversation: () => port,
      chatModel: { mode: 'local-stub', model: 'fixture', async generate() { calls++; expect(input?.readSourceIds).toEqual(['aether-context://note-1']); return { mode: 'local-stub', model: 'fixture', reply: '資料を確認しました。' }; } } });
    expect((await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'Aetherの設定を教えて' } })).status).toBe(200);
    expect(calls).toBe(1); await kernel.waitForBackground('owner');
  });
});
