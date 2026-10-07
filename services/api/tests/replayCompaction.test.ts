import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { COMPACTION_V1 } from '@shannon/mind';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ConversationReplaySummarizer, type ReplaySummaryWriter, type ReplayTemplateInput, type ReplayToolPairs } from '../src/mind/memory/conversationReplaySummary.js';
import { replaySummaryRawRange } from '../src/mind/memory/memoryVisibility.js';
import { conversationReplay } from '../src/mind/recall/conversationWindow.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import { memoryPortsOf, memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';
import { replayCompaction, structuredCompactionOn } from '../src/wiring/compactionWiring.js';
import { runReachScenario, shiritoriScenario } from '../../../packages/evaluation/src/reach/index.js';
import { ScriptedShiritoriModel, shiritoriDriver } from './reach/reachConversation.js';
import { STORE_MEMORY_PARTS } from '../src/infra/sqlite/storeMemoryParts.js';
import { ensureReplaySummaryTemplateColumns, selectReplaySummary, upsertReplaySummary } from '../src/mind/memory/store/sqliteReplaySummary.js';

/**
 * Syzygy ADR-0008 stage 3, step F7: structured compaction. The replay summary is the template of `packages/mind`, updated section
 * by section; text gets every section in at most 900 characters, voice 目的・途中・次・重要な文脈 in at most 400; her tool calls and
 * results reach the summarizer as pairs that are never split, the oldest results trimmed first; the summary keeps the raw range it
 * stands for. Switched off, the table and the summary are as they were. `compact.shiritori`: the long game still holds.
 */
const ENVIRONMENT = { SHANNON_CONVERSATION_REPLAY_CHARACTERS: '2000', SHANNON_VOICE_REPLAY_CHARACTERS: '2000' };
const AT = Date.parse('2026-10-07T03:00:00.000Z');
const line = (index: number) => `発言${String(index).padStart(3, '0')}${'あ'.repeat(95)}`;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** A scripted luna: the first update fills every section; later ones rewrite only 済み, 途中 and 重要な文脈. */
function templateWriter() {
  const inputs: ReplayTemplateInput[] = [];
  const writer: ReplaySummaryWriter = {
    update: async () => { throw new Error('the plain summary is not asked for'); },
    updateTemplate: async (_scopeKey, input) => {
      inputs.push(input);
      const said = input.messages.filter(message => message.role === 'user').map(message => message.content.slice(6, 9));
      const first = input.previous === null;
      return JSON.stringify({
        目的: first ? ['長い会話を続ける'] : null, 制約: first ? ['一行で答える'] : null, 済み: [`${inputs.length}回目の要約`, ...'あいうえおか'.split('').map(kana => `${kana}の話をした`)],
        途中: ['発言の続き'], 詰まり: null, 決めたこと: first ? ['毎回確かめる'] : null, 次: first ? ['続きを話す'] : null,
        重要な文脈: said.slice(-5).map(number => `発言${number}が出た${'い'.repeat(70)}`),
      });
    },
  };
  return { inputs, writer };
}

function world(options: { structured?: boolean; toolPairs?: ReplayToolPairs } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-compaction-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: AT };
  const now = () => new Date(clock.at).toISOString();
  const structured = options.structured ?? true;
  const store = new SQLiteShannonStore({ path, now, structuredCompaction: structured, moodHistory: null });
  const model = templateWriter();
  const summarizer = new ConversationReplaySummarizer(store, store, model.writer, { backgroundLlmCostUsd: () => 0 },
    { environment: ENVIRONMENT, backgroundBudgetUsd: 1, now, ...(structured ? { compaction: { toolPairs: options.toolPairs ?? null } } : {}) });
  const turns = (count: number, from = 0) => {
    const ids: string[] = [];
    for (let index = from; index < from + count; index += 1) {
      ids.push(store.appendTurn('owner', 'thread', line(index * 2), line(index * 2 + 1), new Date(clock.at).toISOString()).id);
      clock.at += 60_000;
    }
    return ids;
  };
  return { path, store, summarizer, turns, ...model, close: () => store.close() };
}

describe('structured compaction', () => {
  it('keeps the template, renders text in 900 and voice in 400 characters, and updates it section by section', async () => {
    const w = world();
    w.turns(15);
    expect(await w.summarizer.refresh('owner', 'thread')).toBe('updated');
    const first = w.store.replaySummary('owner', 'thread')!;
    expect(first.template).toBeDefined();
    expect(first.template!.目的).toEqual(['長い会話を続ける']);
    expect(first.template!.済み).toHaveLength(COMPACTION_V1.maximumItems);
    expect(first.template!.重要な文脈.every(item => Array.from(item).length <= COMPACTION_V1.maximumItemCharacters)).toBe(true);
    expect(Array.from(first.summary).length).toBeLessThanOrEqual(900);
    expect(first.summary.startsWith('[ここまでの要約]\n目的: 長い会話を続ける')).toBe(true);
    const messages = w.store.conversationHistory('owner', 'thread');
    expect(first.template!.coversFromId).toBe(messages[0]!.id);
    expect(first.template!.coversToId).toBe(first.coveredThroughMessageId);

    // The window of each channel shows its own rendering.
    const text = conversationReplay('text', w.store.snapshot('owner'), w.store, 'owner', 'thread', OWNER_AUDIENCE, ENVIRONMENT);
    const voice = conversationReplay('voice', w.store.snapshot('owner'), w.store, 'owner', 'thread', OWNER_AUDIENCE, ENVIRONMENT);
    expect(text.summary).toBe(first.summary);
    expect(Array.from(voice.summary!).length).toBeLessThanOrEqual(400);
    expect(voice.summary).toContain('目的: 長い会話を続ける');
    expect(voice.summary).not.toMatch(/済み:|制約:|決めたこと:/u);
    expect(text.request('').turnContext).toContain(JSON.stringify(first.summary));

    // Later: the sections the model left null stay, the ones it named are replaced, and the range grows.
    w.turns(15, 15);
    expect(await w.summarizer.refresh('owner', 'thread')).toBe('updated');
    const second = w.store.replaySummary('owner', 'thread')!;
    expect(w.inputs.at(-1)!.previous!.目的).toEqual(['長い会話を続ける']);
    expect(second.template!.目的).toEqual(['長い会話を続ける']);
    expect(second.template!.決めたこと).toEqual(['毎回確かめる']);
    // A section keeps its newest five items: the oldest one the model gave (`N回目の要約`) left first.
    expect(second.template!.済み).toEqual(['いの話をした', 'うの話をした', 'えの話をした', 'おの話をした', 'かの話をした']);
    expect(second.template!.coversFromId).toBe(first.template!.coversFromId);
    expect(second.coveredThroughMessageId).not.toBe(first.coveredThroughMessageId);
    // Recall can open the raw range the summary stands for.
    const raw = replaySummaryRawRange(w.store.snapshot('owner'), w.store, 'owner', 'thread');
    expect(raw[0]!.id).toBe(second.template!.coversFromId);
    expect(raw.at(-1)!.id).toBe(second.template!.coversToId);
    w.close();
  });

  it('gives her tool calls and results as pairs, never split, the oldest results trimmed first', async () => {
    let turnIds: string[] = [];
    const w = world({ toolPairs: (_scopeKey, _threadId, asked) => turnIds.filter(id => asked.includes(id)).slice(0, 2).flatMap((turnId, index) => [
      { turnId, call: `study.read「下書き${index}」`, result: `${'中身'.repeat(1_500)}${index}` },
    ]) });
    turnIds = w.turns(15);
    await w.summarizer.refresh('owner', 'thread');
    const messages = w.inputs[0]!.messages;
    const calls = messages.flatMap((message, index) => (message.role === 'tool_call' ? [index] : []));
    expect(calls.length).toBeGreaterThan(0);
    for (const index of calls) expect(messages[index + 1]!.role).toBe('tool_result');
    const results = messages.filter(message => message.role === 'tool_result');
    expect(results[0]!.content).toBe(COMPACTION_V1.trimmedToolOutput);
    expect(messages.reduce((sum, message) => sum + Array.from(message.content).length, 0)).toBeLessThanOrEqual(8_000);
    w.close();
  });

  it('is wired from the environment: SHANNON_ADR8_STAGE3=off or SHANNON_STRUCTURED_COMPACTION=off gives no compaction', () => {
    const w = world({ structured: false });
    for (const environment of [{ SHANNON_ADR8_STAGE3: 'off' }, { SHANNON_STRUCTURED_COMPACTION: 'off' }]) {
      expect(structuredCompactionOn(environment), JSON.stringify(environment)).toBe(false);
      expect(replayCompaction(environment, w.store), JSON.stringify(environment)).toBeNull();
    }
    expect(structuredCompactionOn({})).toBe(true);
    expect(replayCompaction({}, w.store)).not.toBeNull();
    w.close();
  });

  it('switched off: no template columns, the plain summary as it was', async () => {
    const w = world({ structured: false });
    const columns = (path: string) => {
      const database = new DatabaseSync(path, { readOnly: true });
      try { return (database.prepare('PRAGMA table_info(conversation_replay_summaries)').all() as Array<{ name: string }>).map(row => row.name); } finally { database.close(); }
    };
    expect(columns(w.path)).not.toContain('template_json');
    w.close();
    const on = world();
    expect(columns(on.path)).toEqual(expect.arrayContaining(['template_json', 'covers_from_id', 'covers_to_id']));
    on.close();
  });

  it('runs through the one memory writer as well (F5): the model calls cached, the template written under the lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-compaction-writer-'));
    directories.push(directory);
    const clock = { at: AT };
    const now = () => new Date(clock.at).toISOString();
    const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now, memoryOutbox: true, memoryParts: STORE_MEMORY_PARTS, structuredCompaction: true, moodHistory: null });
    const ports = memoryPortsOf(store, now)!;
    const model = templateWriter();
    const summarizer = new ConversationReplaySummarizer(store, store, model.writer, { backgroundLlmCostUsd: () => 0 },
      { environment: ENVIRONMENT, backgroundBudgetUsd: 1, now, memory: ports.proposals, compaction: {} });
    let last = '';
    for (let index = 0; index < 15; index += 1) { last = store.appendTurn('owner', 'thread', line(index * 2), line(index * 2 + 1), now()).id; clock.at += 60_000; }
    expect(await summarizer.refreshForTurn('owner', last)).toBe('proposed');
    await memoryWriterOf(store, { now, replaySummaries: summarizer, log: () => {} })!.drain();
    expect(store.replaySummary('owner', 'thread')!.template!.目的).toEqual(['長い会話を続ける']);
    expect(store.memoryOutbox()!.rows()[0]).toMatchObject({ kind: 'replay_summary.update', status: 'applied' });
    store.close();
  });
});

describe('compact.shiritori', () => {
  it('the long game still holds with the structured summary refreshed after every turn', async () => {
    const updates: ReplayTemplateInput[] = [];
    const driver = shiritoriDriver(new ScriptedShiritoriModel(), {
      compaction: (store, now) => {
        const summarizer = new ConversationReplaySummarizer(store, store, {
          update: async () => null,
          updateTemplate: async (_scopeKey, input) => {
            updates.push(input);
            return JSON.stringify({ 目的: ['しりとりを続ける'], 制約: ['同じ言葉は使わない'], 済み: null, 途中: ['しりとりの途中'], 詰まり: null, 決めたこと: null,
              次: ['次の言葉を言う'], 重要な文脈: input.messages.filter(message => message.role !== 'tool_call').slice(-5).map(message => message.content.slice(0, 40)) });
          },
        }, { backgroundLlmCostUsd: () => 0 }, { backgroundBudgetUsd: 1, now, compaction: {} });
        return new BackgroundUpdateCoordinator(store, store, undefined, (turn, id) => (id ? summarizer.refreshForTurn(turn.scopeKey, id) : Promise.resolve()));
      },
    });
    const record = await runReachScenario(shiritoriScenario, driver, { mode: 'scripted', startedAt: '2026-10-05T00:00:00.000Z', clock: () => performance.now() });
    expect(Object.fromEntries(record.checks.filter(check => !check.passed).map(check => [check.id, check.cause]))).toEqual({});
    expect(record).toMatchObject({ status: 'passed', stop: null, steps: 64 });
    expect(record.metrics).toMatchObject({ turns: 60, validTurns: 60, repeats: 0, questionsAsked: 4, chatErrors: 0 });
    // Every update the summarizer made was within the template's bounds (and none of them took part of the game away).
    for (const input of updates) expect(input.messages.length).toBeGreaterThan(0);
  });

  it('off then on: a summary written while it was off clears the template and range that stood for an older one (review M3)', () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`CREATE TABLE conversation_replay_summaries (scope_key TEXT NOT NULL, thread_id TEXT NOT NULL, summary TEXT NOT NULL,
      covered_through_message_id TEXT NOT NULL, chain_started_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope_key, thread_id))`);
    ensureReplaySummaryTemplateColumns(database);
    const at = '2026-10-07T01:00:00.000Z';
    upsertReplaySummary(database, 'owner', 'thread', { summary: '古い要約', coveredThroughMessageId: 'm1', chainStartedAt: at, updatedAt: at }, true);
    database.prepare(`UPDATE conversation_replay_summaries SET template_json = '{"目的":["古い"]}', covers_from_id = 'm0', covers_to_id = 'm1'`).run();
    // Switched off: the plain summary is written, and the template of the older one is cleared.
    upsertReplaySummary(database, 'owner', 'thread', { summary: '新しい要約', coveredThroughMessageId: 'm9', chainStartedAt: at, updatedAt: at }, false);
    expect(database.prepare('SELECT summary, template_json, covers_from_id, covers_to_id FROM conversation_replay_summaries').get())
      .toEqual({ summary: '新しい要約', template_json: null, covers_from_id: null, covers_to_id: null });
    // On again: what is read is the plain summary, with no template of the old one.
    const read = selectReplaySummary(database, 'owner', 'thread', true);
    expect(read?.summary).toBe('新しい要約');
    expect(read).not.toHaveProperty('template');
    database.close();
  });
});

