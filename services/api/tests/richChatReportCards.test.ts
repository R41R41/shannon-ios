import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { createReportCards, reportCardMessageId, REPORT_CARD_SPOKEN_WAIT_MS } from '../src/mind/action/fca/fcaReportCards.js';
import { fallbackSpokenReport } from '../src/mind/action/fca/fcaSpokenReport.js';
import type { TaskProgress } from '../src/mind/action/taskRuntime/taskProgressPorts.js';
import type { TaskRuntime, TaskSource, TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { dispatchConversationRead } from '../src/surfaces/text/apiConversationRead.js';
import { createConversationExtras } from '../src/wiring/conversationExtrasWiring.js';

const AT = Date.parse('2026-10-13T05:00:00.000Z');
const REPORT = [
  '結論: A店がいちばん近くて安いです。',
  '',
  '| 店 | 距離 | 値段 |',
  '|---|---|---|',
  '| A | 300m | 900円 |',
  '| B | 1.2km | 1200円 |',
  '',
  '```chart',
  '{"type":"bar","title":"値段","x":["A","B"],"series":[{"name":"円","values":[900,1200]}]}',
  '```',
].join('\n');

let directory: string, store: SQLiteShannonStore, db: DatabaseSync;
afterEach(() => { store?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }); });

function harness(options: { spoken?: string; reportAt?: number; parentKind?: string; visible?: boolean; phase?: string; thread?: boolean } = {}) {
  directory = mkdtempSync(join(tmpdir(), 'shannon-report-card-'));
  const path = join(directory, 'cards.sqlite');
  const clock = { at: AT, visible: options.visible ?? true, alone: true };
  store = new SQLiteShannonStore({ path, now: () => new Date(clock.at).toISOString() });
  db = new DatabaseSync(path);
  const threadId = store.createThread('owner', '調べもの');
  store.appendTurn('owner', threadId, '近くの店を比べて', '調べてくるね。', new Date(AT - 60_000).toISOString());
  const task = { id: 'task-1', parentId: 'conversation-1', kind: 'research', origin: 'owner_request', title: '近くの店を比べる',
    phase: options.phase ?? 'completed', updatedAt: new Date(AT - 5_000).toISOString() } as TaskView;
  const parent = { id: 'conversation-1', kind: options.parentKind ?? 'conversation' } as TaskView;
  const sources: TaskSource[] = options.thread === false ? [] : [{ kind: 'conversation', stepId: 's', experienceId: 'turn-1', threadId,
    observedAt: new Date(AT).toISOString(), recalledMemoryIds: ['memory-1'] }];
  const runtime = { list: () => [task], get: (_scope: string, id: string) => id === parent.id ? parent : id === task.id ? task : null,
    taskSources: () => sources } as unknown as Pick<TaskRuntime, 'list' | 'get' | 'taskSources'>;
  const progress: TaskProgress = { currentStep: 'fca.result', status: 'received', startedAt: new Date(AT - 90_000).toISOString(),
    updatedAt: new Date(options.reportAt ?? AT - 30_000).toISOString(),
    findings: [{ id: 'f1', text: 'A店は駅前。', status: 'unconfirmed', sources: [{ title: 'A店', url: 'https://a.example/' }], updatedAt: new Date(AT).toISOString() }],
    report: { id: 'report-1', text: REPORT, updatedAt: new Date(options.reportAt ?? AT - 30_000).toISOString(), ...(options.spoken ? { spoken: options.spoken } : {}) } };
  const cards = createReportCards({ runtime, ownerScope: 'owner', conversations: store, now: () => clock.at,
    shown: () => clock.alone && clock.visible ? progress : null });
  const extras = createConversationExtras({ database: db, ownerScope: 'owner', now: () => new Date(clock.at).toISOString(), ownerAlone: () => clock.alone,
    feedback: () => null, reportVisible: () => clock.alone && clock.visible });
  return { threadId, clock, cards, extras, progress };
}

describe('report cards (rich chat)', () => {
  it('leaves one card in the Talk the work came from, carrying the short answer and the full report', () => {
    const { threadId, cards } = harness({ spoken: 'A店がいちばん近くて安いです。' });
    expect(cards.tick()).toBe(1);
    expect(cards.tick()).toBe(0);
    const note = store.conversationHistory('owner', threadId).at(-1)!;
    expect(note.id).toBe(reportCardMessageId('owner', 'task-1', 'report-1'));
    expect(note.content).toBe('A店がいちばん近くて安いです。');
    expect(note.reportCard).toMatchObject({ taskId: 'task-1', reportId: 'report-1', title: '近くの店を比べる', status: 'completed',
      answer: 'A店がいちばん近くて安いです。', report: REPORT, findings: [{ text: 'A店は駅前。', sources: [{ title: 'A店', url: 'https://a.example/' }] }] });
    // Display history only: no experience, and her replay withholds it when its sources go.
    expect(store.experienceCandidates('owner')).toHaveLength(1);
    expect(note.recalledMemoryIds).toEqual(['turn-1', 'memory-1']);
  });

  it('survives a restart of the scan without a second card', () => {
    const { threadId, cards } = harness({ spoken: '近いのはA店です。' });
    cards.tick();
    const again = createReportCards({ runtime: { list: () => [], get: () => null, taskSources: () => [] }, ownerScope: 'owner', conversations: store,
      now: () => AT, shown: () => null });
    expect(again.tick()).toBe(0);
    expect(store.conversationHistory('owner', threadId).filter(message => message.reportCard)).toHaveLength(1);
  });

  it('waits for the spoken form, then falls back to a plain cut that never reads a table or a chart', () => {
    const { threadId, clock, cards } = harness({ reportAt: AT - 1_000 });
    expect(cards.tick()).toBe(0);
    clock.at = AT + REPORT_CARD_SPOKEN_WAIT_MS;
    expect(cards.tick()).toBe(1);
    const answer = store.conversationHistory('owner', threadId).at(-1)!.content;
    expect(answer).toBe(fallbackSpokenReport(REPORT, '近くの店を比べる'));
    expect(answer).not.toMatch(/\||chart|series|900/u);
  });

  it('writes nothing while the owner is not alone or a source is no longer visible, nor for nested or unfinished work', () => {
    for (const options of [{ visible: false }, { parentKind: 'research' }, { phase: 'executing' }, { thread: false }]) {
      const { threadId, cards } = harness({ spoken: '答え。', ...options });
      expect(cards.tick()).toBe(0);
      expect(store.conversationHistory('owner', threadId).some(message => message.reportCard)).toBe(false);
      store.close(); db.close(); rmSync(directory, { recursive: true, force: true });
    }
    const { cards, clock, threadId } = harness({ spoken: '答え。' });
    clock.alone = false;
    expect(cards.tick()).toBe(0);
    clock.alone = true;
    expect(cards.tick()).toBe(1);
    expect(store.conversationHistory('owner', threadId).some(message => message.reportCard)).toBe(true);
  });

  it('shows the card in GET /v1/conversation only to the owner alone while the work stays visible, never without the ports', () => {
    const { threadId, cards, clock, extras } = harness({ spoken: '答え。' });
    cards.tick();
    const read = (withExtras: boolean) => {
      const response = dispatchConversationRead({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner', threadId }) }, {
        conversationStore: store, stateStore: store, cognitiveIntents: { list: () => [] } as never, now: () => new Date(clock.at).toISOString(),
        ownerAlone: () => clock.alone, extras: withExtras ? extras.ports : null });
      return (response!.body as { messages: Array<{ content: string; reportCard?: { taskId: string }; recalledMemoryIds?: unknown }> }).messages;
    };
    const shown = read(true);
    expect(shown.at(-1)?.reportCard?.taskId).toBe('task-1');
    expect(shown.at(-1)?.recalledMemoryIds).toBeUndefined();
    expect(read(false).some(message => message.reportCard || message.content === '答え。')).toBe(false);
    clock.visible = false;
    expect(read(true).some(message => message.reportCard || message.content === '答え。')).toBe(false);
    clock.visible = true;
    clock.alone = false;
    expect(read(true).some(message => message.reportCard || message.content === '答え。')).toBe(false);
    expect(read(true).map(message => message.content)).toEqual(['近くの店を比べて', '調べてくるね。']);
  });
});
