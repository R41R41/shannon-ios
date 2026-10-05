import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import { TurnRefinementProcessor } from '../src/backgroundUpdates.js';
import { conversationReplay } from '../src/conversationWindow.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import type { ToolTraceCall } from '../src/shannonToolTrace.js';
import { sweepToolTraces } from '../src/shannonToolTraceSweep.js';
import { InMemoryToolTraces, TOOL_TRACE_RETENTION_MILLISECONDS, ToolTurnLog } from '../src/shannonToolTurns.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

/** Review of 2026-10-05: retention in every scope, forgetting and 「内緒」 reaching stored traces, and turn matching. */
const at = '2026-10-05T06:00:00.000Z';
const TRACE = '[さっきボクが道具でしたこと・見たこと]';
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function sqlite(clock = { at }) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-tool-traces-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  return { path, clock, open: () => new SQLiteShannonStore({ path, now: () => clock.at }) };
}

const list = (...names: string[]): ToolTraceCall => ({ tool: 'folder.list', ok: true, names });
const daysBefore = (days: number) => new Date(Date.parse(at) - days * 24 * 60 * 60_000).toISOString();

describe('the stored traces of her tools', () => {
  it('drops traces past the retention at every open and at the sweep, in every scope', () => {
    const { open, clock } = sqlite();
    const store = open();
    for (const scopeKey of ['owner', 'other-scope']) {
      store.saveToolTrace(scopeKey, { turnId: `old-${scopeKey}`, threadId: 't', recordedAt: daysBefore(31), asked: true, calls: [list('a/')] });
      store.saveToolTrace(scopeKey, { turnId: `new-${scopeKey}`, threadId: 't', recordedAt: daysBefore(1), asked: true, calls: [list('b/')] });
    }
    store.close();
    const reopened = open();
    expect(reopened.toolTraces('owner', null, { since: '' }).map(record => record.turnId)).toEqual(['new-owner']);
    expect(reopened.toolTraces('other-scope', null, { since: '' }).map(record => record.turnId)).toEqual(['new-other-scope']);
    clock.at = new Date(Date.parse(at) + TOOL_TRACE_RETENTION_MILLISECONDS).toISOString();
    sweepToolTraces(reopened, clock.at);
    expect(reopened.toolTraceScopes()).toEqual([]);
    reopened.close();
  });

  it('forgets the trace of a forgotten turn, and masks what is later kept secret or forgotten, at replay and in the store', () => {
    const { open } = sqlite();
    const store = open();
    const log = new ToolTurnLog(store, () => at);
    const turn = (user: string, reply: string, minute: number, calls: ToolTraceCall[]) => {
      const observedAt = new Date(Date.parse(at) - (60 - minute) * 60_000).toISOString();
      const experience = store.appendTurn('owner', 'talk', user, reply, observedAt, { capturedStateVersion: 0, messageEmotion: emotion });
      store.saveToolTrace('owner', { turnId: experience.id, threadId: 'talk', recordedAt: observedAt, asked: true, calls });
      return experience;
    };
    const source = turn('私は紅茶が好き。フォルダも見て。', '紅茶が好きなんですね。見てみます。', 1, [list('tea/')]);
    new TurnRefinementProcessor(store, store).process('owner', source.userMessage, source.id, source.observedAt);
    const fact = store.snapshot('owner').userFacts[0]!;
    turn('フォルダの中は？', 'こうなっています。', 2, [list('紅茶が好き.md', '転職活動中のメモ.md', 'stories/')]);
    const replay = () => conversationReplay('text', store.snapshot('owner'), store, 'owner', 'talk', OWNER_AUDIENCE, {}, log).request('').systemPrompt;
    expect(replay()).toContain('tea/');
    expect(replay()).toContain('転職活動中のメモ.md');

    // A later 「内緒」 and a later forgetting reach the traces already stored.
    store.apply('owner', { type: 'user-fact-upserted', source: 'sleep', fact: { id: 'job', statement: 'ユーザーは転職活動中', confidence: 0.9, observedAt: at, evidence: '転職活動中',
      disclosure: { audience: { kind: 'owner' }, sensitivity: 'sensitive', category: 'secret', decidedBy: 'owner' } } });
    new ShannonMemoryService(store, store, () => at).mutate('owner', { memoryId: fact.id, action: 'forget' });
    const after = replay();
    expect(after).toContain(TRACE);
    expect(after).not.toContain('tea/');
    expect(after).not.toContain('転職活動中');
    expect(after).not.toContain('紅茶');
    expect(after).toContain('stories/');
    expect(after).toContain('（伏せた）');

    sweepToolTraces(store, at);
    const kept = store.toolTraces('owner', null, { since: '' });
    expect(kept.map(record => record.turnId)).not.toContain(source.id);
    expect(JSON.stringify(kept)).not.toContain('転職活動中');
    expect(JSON.stringify(kept)).toContain('stories/');
    store.close();
  });

  it('keeps every valid trace of a Talk with more than 200 turns (re-review 2)', () => {
    const { open } = sqlite();
    const store = open();
    for (let index = 0; index < 250; index += 1) {
      const observedAt = new Date(Date.parse(at) - (300 - index) * 60_000).toISOString();
      const turn = store.appendTurn('owner', 'talk', `フォルダを見て ${index}`, `見ました ${index}`, observedAt, { capturedStateVersion: 0, messageEmotion: emotion });
      store.saveToolTrace('owner', { turnId: turn.id, threadId: 'talk', recordedAt: observedAt, asked: true, calls: [list(`entry-${index}/`)] });
    }
    sweepToolTraces(store, at);
    expect(store.toolTraces('owner', null, { since: '' })).toHaveLength(250);
    store.close();
  });

  it('links a Talk-only trace to its turn after a restart, and drops it with a turn others heard or one forgotten (re-review 4)', () => {
    const { open } = sqlite();
    const store = open();
    const before = new ToolTurnLog(store, () => at);
    const create = (path: string): ToolTraceCall => ({ tool: 'folder.create', target: path, ok: true });
    before.open('owner', 'talk', '試しにメモを作って', false).called(create('memo.md'));
    before.open('owner', 'talk', '別のファイルも作って、内緒で', false).called(create('other.md'));
    before.open('owner', 'talk', '途中で切れた話', false).called(create('cut.md'));
    // The API restarts: nothing holds the pending turns. The client stores two of them a few seconds later.
    store.close();
    const reopened = open();
    const later = new Date(Date.parse(at) + 5_000).toISOString();
    const stored = reopened.appendTurn('owner', 'talk', '試しにメモを作って。', '作りました。', later, { capturedStateVersion: 0, messageEmotion: emotion });
    reopened.appendTurn('owner', 'talk', '別のファイルも作って、内緒で', '作りました。', later,
      { capturedStateVersion: 0, messageEmotion: emotion, audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' });
    sweepToolTraces(reopened, later);
    const kept = reopened.toolTraces('owner', 'talk', { since: '' });
    expect(kept.find(record => record.turnId === stored.id)?.calls).toEqual([create('memo.md')]);
    expect(JSON.stringify(kept)).not.toContain('other.md');
    // The reply that was cut off keeps its Talk-only trace.
    expect(kept.filter(record => record.turnId.startsWith('unstored:')).map(record => record.calls[0]!.target)).toEqual(['cut.md']);
    const after = new ToolTurnLog(reopened, () => later);
    expect(conversationReplay('text', reopened.snapshot('owner'), reopened, 'owner', 'talk', OWNER_AUDIENCE, {}, after).request('').systemPrompt)
      .toContain('- 2つ前の返事: folder.create「memo.md」 → できた');
    reopened.close();
  });

  it('does not merge a repeated short yes into an earlier turn that was never stored, and links by utterance id first', () => {
    const traces = new InMemoryToolTraces();
    const clock = { at: Date.parse(at) };
    const log = new ToolTurnLog(traces, () => new Date(clock.at).toISOString());
    const create = (path: string): ToolTraceCall => ({ tool: 'folder.create', target: path, ok: true });
    log.open('owner', 'talk', 'はい', false).called(create('first.md'));
    clock.at += 5_000;
    log.open('owner', 'talk', 'はい', false).called(create('second.md'));
    log.turnStored('owner', 'talk', 'turn-2', 'はい', true);
    expect(traces.toolTraces('owner', 'talk', { turnIds: ['turn-2'] })[0]?.calls).toEqual([create('second.md')]);
    // The first, never stored, stays linked to the Talk.
    expect(log.traces('owner', 'talk', [], '').map(record => record.calls)).toEqual([[create('first.md')]]);
    // By id: other words, the same utterance.
    log.open('owner', 'talk', '書斎を見て', true, 'utt-9').called(list('x'));
    log.turnStored('owner', 'talk', 'turn-3', 'まったく別の言葉', true, 'utt-9');
    expect(traces.toolTraces('owner', 'talk', { turnIds: ['turn-3'] })).toHaveLength(1);
    // Ids that differ never link, whatever the words.
    log.open('owner', 'talk', '書斎を見て', true, 'utt-10').called(list('y'));
    log.turnStored('owner', 'talk', 'turn-4', '書斎を見て', true, 'utt-11');
    expect(traces.toolTraces('owner', 'talk', { turnIds: ['turn-4'] })).toHaveLength(0);
  });
});
