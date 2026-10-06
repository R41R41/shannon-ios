import { describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { executeConversationCommand } from '../src/conversationCommands.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { InMemoryOrganizeStore } from '../src/integrations/voyager/organize.js';
import type { AetherProposalInput, AetherProposalStore } from '../src/integrations/aether/aetherProposal.js';
import { extractProspectiveMemories } from '../src/prospectiveMemory.js';
import { commitmentDeadline } from '../src/commitmentTime.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { createLocalApiKernel } from '../src/apiKernel.js';

const at = '2026-09-24T12:00:00.000Z';
const earlier = '2026-09-24T11:59:00.000Z';
function fixture() {
  const stateStore = new InMemoryCompanionStateStore(() => at);
  const conversationStore = new InMemoryConversationStore();
  const organizeStore = new InMemoryOrganizeStore();
  const notes: AetherProposalInput[] = [];
  const aetherProposals: AetherProposalStore = { configured: true, create: (_scope, input) => {
    notes.push(input); return { id: 'note-1', operation: 'new-note', title: '保存案', content: input.content, reason: input.reason ?? '', createdAt: at };
  } };
  const deps = { stateStore, conversationStore, organizeStore, aetherProposals };
  const run = (text: string, id = 'u-save') => executeConversationCommand('owner', 'thread', { id, text }, at, deps);
  return { ...deps, notes, run };
}

// A note goes to Aether only when Aether is named (owner decision 2026-10-05, memoPlace.test.ts); the references are the same.
describe('source-bound conversation references', () => {
  it('saves the prior owner content, not the words さっきの話, to a note proposal', () => {
    const f = fixture();
    f.conversationStore.appendTurn('owner', 'thread', '旅行の写真は日付ごとに整理する。', 'いいね', earlier);
    const result = f.run('さっきの話をAetherに保存して');
    expect(f.notes[0]?.content).toBe('旅行の写真は日付ごとに整理する。');
    expect(f.notes[0]?.reason).toContain('source');
    expect(result?.receipt).toMatchObject({ capability: 'aether.propose', status: 'proposed' });
    expect(result?.reply).toContain('旅行の写真');
  });

  it('attaches actual source message IDs to a referenced task proposal', () => {
    const f = fixture();
    f.conversationStore.appendTurn('owner', 'thread', '旅行の写真を整理する', 'いいね', earlier);
    const source = f.conversationStore.conversationHistory('owner', 'thread')[0]!;
    const result = f.run('これをタスクにして');
    expect(result?.organizeSession?.items[0]?.title).toBe('旅行の写真を整理する');
    expect(result?.organizeSession?.sourceMessageIds).toContain(source.id);
    expect(result?.organizeSession?.sourceMessageIds).toContain('utterance:u-save');
  });

  it('asks for missing or ambiguous references instead of creating literal proposals', () => {
    const f = fixture();
    expect(f.run('これをAetherのノートにして')?.reply).toContain('どの内容');
    expect(f.run('さっきの話をタスクにして')?.receipt).toBeUndefined();
    expect(f.notes).toHaveLength(0);
    expect(f.organizeStore.list('owner', 'thread')).toHaveLength(0);
    f.conversationStore.appendTurn('owner', 'thread', '写真を整理する方法を教えて', 'AかBの方法がある', earlier);
    expect(f.run('これをタスクにして')?.receipt).toBeUndefined();
    expect(f.organizeStore.list('owner', 'thread')).toHaveLength(0);
  });

  it('does not borrow another thread, stale content, hidden experience, or assistant assertions', () => {
    const f = fixture();
    f.conversationStore.appendTurn('owner', 'other', '別スレッドの秘密', '了解', earlier);
    expect(f.run('これをAetherのノートにして')?.receipt).toBeUndefined();
    f.conversationStore.appendTurn('owner', 'thread', '古い内容', '新しい作り話', '2026-09-23T12:00:00.000Z');
    expect(f.run('これをAetherのノートにして')?.receipt).toBeUndefined();
    const source = f.conversationStore.appendTurn('owner', 'thread', '忘れた内容', '保存しよう', earlier);
    f.stateStore.apply('owner', { type: 'memory-control-upserted', control: {
      memoryId: source.id, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'test',
    } });
    expect(f.run('これをAetherのノートにして')?.receipt).toBeUndefined();
    expect(f.notes).toHaveLength(0);
  });

  it('pins a source experience for explicit referenced remembering without inventing a user fact', () => {
    const f = fixture();
    const source = f.conversationStore.appendTurn('owner', 'thread', '旅行で雨宿りしながら話した時間が楽しかった', '楽しかったね', earlier);
    const result = f.run('さっきの話を覚えておいて');
    expect(result?.receipt).toMatchObject({ id: source.id, capability: 'memory.control', status: 'completed' });
    expect(f.stateStore.snapshot('owner').memoryControls).toContainEqual(expect.objectContaining({ memoryId: source.id, pinned: true, status: 'active' }));
    expect(f.stateStore.snapshot('owner').userFacts).toHaveLength(0);
    expect(result?.reply).toContain('旅行で雨宿り');
  });

  it.each(['さっきの予定覚えておいて', 'さっきの予定を覚えておいて'])(
    'resolves the audited plan reference %s to the original event', text => {
      const f = fixture();
      const source = f.conversationStore.appendTurn('owner', 'thread', '金曜日に旅行の写真を整理する', '了解', earlier);
      const result = f.run(text);
      expect(result?.receipt).toMatchObject({ id: source.id, capability: 'memory.control', status: 'completed' });
      expect(f.stateStore.snapshot('owner').memoryControls).toContainEqual(expect.objectContaining({ memoryId: source.id, pinned: true }));
      expect(f.stateStore.snapshot('owner').prospectiveMemories).toHaveLength(0);
      expect(extractProspectiveMemories(text, at)).toHaveLength(0);
    },
  );

  it('resolves the audited plan task reference and asks when its source is missing', () => {
    const f = fixture();
    const text = 'さっきの予定をタスクにして';
    expect(f.run(text)?.receipt).toBeUndefined();
    expect(f.organizeStore.list('owner', 'thread')).toHaveLength(0);
    f.conversationStore.appendTurn('owner', 'thread', '金曜日に旅行の写真を整理する', '了解', earlier);
    const result = f.run(text, 'task-plan');
    expect(result?.organizeSession?.items[0]?.title).toBe('金曜日に旅行の写真を整理する');
  });

  it('shares noun vocabulary between deictic and time-qualified references', () => {
    for (const noun of ['話', '内容', '会話', '発言', '件', '計画', '予定', '作業', 'タスク', 'アイデア', '案']) {
      for (const prefix of ['この', 'その', 'さっきの', '先ほどの']) {
        const f = fixture();
        f.conversationStore.appendTurn('owner', 'thread', '旅行の写真を整理する', '了解', earlier);
        expect(f.run(`${prefix}${noun}をAetherのノートにして`)?.receipt, `${prefix}${noun}`).toBeDefined();
        expect(f.notes[0]?.content, `${prefix}${noun}`).toBe('旅行の写真を整理する');
      }
    }
  });

  it('never persists unresolved referents as future commitments', () => {
    for (const text of ['これを覚えておいて', 'さっきの話を覚えておいて', 'それをリマインドして', '明日これをやる', '今週末にこれをリマインドして', '明日の10時にこれをリマインドして']) {
      expect(extractProspectiveMemories(text, at), text).toHaveLength(0);
    }
  });

  it('uses a durable source ID rather than matching identical text across conversations', () => {
    const f = fixture();
    const db = new SQLiteShannonStore({ path: ':memory:', now: () => at });
    try {
      db.appendTurn('owner', 'other', '旅行の写真を整理する', '了解', earlier);
      const source = db.appendTurn('owner', 'thread', '旅行の写真を整理する', '了解', earlier);
      const userMessage = db.conversationHistory('owner', 'thread')[0]!;
      expect(userMessage.sourceExperienceId).toBe(source.id);
      const result = executeConversationCommand('owner', 'thread', { id: 'save-1', text: 'これを覚えておいて' }, at,
        { ...f, stateStore: db, conversationStore: db });
      expect(result?.receipt?.id).toBe(source.id);
      expect(db.snapshot('owner').memoryControls).toHaveLength(1);
    } finally { db.close(); }
  });

  it('uses the same source resolution from text and authorized voice but not a generated tool paraphrase', async () => {
    const f = fixture();
    f.conversationStore.appendTurn('owner', 'thread', '旅行の写真を整理する', '了解', earlier);
    const api = createLocalApiKernel(() => at, f);
    const body = { scopeKey: 'owner', threadId: 'thread', transcript: 'これをタスクにして', deviceContext: {
      timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: 'voice-1', text: 'これをタスクにして' },
    } };
    const first = await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body });
    expect(first).toMatchObject({ status: 200, body: { organizeSession: { items: [{ title: '旅行の写真を整理する' }] } } });
    expect(await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body })).toEqual(first);
    expect(f.organizeStore.list('owner', 'thread')).toHaveLength(1);
    const text = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'これをAetherのノートにして' } });
    expect(text).toMatchObject({ status: 200 });
    expect(f.notes[0]?.content).toBe('旅行の写真を整理する');
  });

  it('honors the fifteen-minute boundary and refuses future or invalid source timestamps', () => {
    for (const [time, succeeds] of [
      ['2026-09-24T11:45:00.000Z', true], ['2026-09-24T11:44:59.999Z', false],
      ['2026-09-24T12:00:00.001Z', false], ['invalid', false],
    ] as const) {
      const f = fixture();
      f.conversationStore.appendTurn('owner', 'thread', '旅行の写真を整理する', '了解', time);
      expect(Boolean(f.run('これをタスクにして')?.receipt), time).toBe(succeeds);
    }
  });

  it('does not jump past a recent ambiguous message to an older saveable statement', () => {
    const f = fixture();
    f.conversationStore.appendTurn('owner', 'thread', '旅行の写真を整理する', '了解', earlier);
    for (let i = 0; i < 4; i++) f.conversationStore.appendTurn('owner', 'thread', 'うん', 'うん', at);
    expect(f.run('さっきの話をタスクにして')?.receipt).toBeUndefined();
    expect(f.organizeStore.list('owner', 'thread')).toHaveLength(0);
  });

  it('asks which task when the referent contains alternatives, multiple plans or cancellation', () => {
    for (const source of ['写真を整理する。動画を編集する。', '写真を整理する\n動画を編集する', '写真を整理する予定は取り消した', '写真整理は終わった', '写真を整理する、または動画を編集する']) {
      const f = fixture();
      f.conversationStore.appendTurn('owner', 'thread', source, '了解', earlier);
      expect(f.run('これをタスクにして')?.receipt, source).toBeUndefined();
      expect(f.organizeStore.list('owner', 'thread')).toHaveLength(0);
    }
  });

  it('does not silently resolve older references or unspecified parts into the latest message', () => {
    const f = fixture();
    f.conversationStore.appendTurn('owner', 'thread', '旅行の写真を整理する', '了解', earlier);
    for (const text of ['昨日の話をAetherのノートにして', 'これの要点をタスクにして', '写真のそれをAetherのノートにして']) {
      expect(f.run(text)?.receipt, text).toBeUndefined();
    }
    expect(f.notes).toHaveLength(0);
    expect(f.organizeStore.list('owner', 'thread')).toHaveLength(0);
    expect(f.run('これから写真を整理するをタスクにして')?.receipt).toBeDefined();
  });

  it('does not create another memory from the later voice transcript mirror', async () => {
    const f = fixture();
    const source = f.conversationStore.appendTurn('owner', 'thread', '雨宿りしながら話した時間が楽しかった', '楽しかったね', earlier);
    const api = createLocalApiKernel(() => at, f);
    const body = { scopeKey: 'owner', threadId: 'thread', transcript: 'これを覚えておいて', deviceContext: {
      timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
      userUtterance: { id: 'voice-remember', text: 'これを覚えておいて' },
    } };
    expect(await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body })).toMatchObject({ status: 200, body: { receipt: { id: source.id } } });
    await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: 'thread', userTranscript: 'これを覚えておいて', shannonTranscript: '会話の記憶を固定したよ',
    } });
    await api.waitForBackground('owner');
    const snapshot = f.stateStore.snapshot('owner');
    expect(snapshot.prospectiveMemories).toHaveLength(0);
    expect(snapshot.userFacts).toHaveLength(0);
    expect(snapshot.memoryControls.filter(control => control.pinned)).toHaveLength(1);
    expect(snapshot.memoryControls[0]?.memoryId).toBe(source.id);
    // A delayed command retry cannot promote the mirrored command into memory.
    const retry = await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body });
    expect(retry).toMatchObject({ status: 200, body: { reply: expect.stringContaining('どの内容') } });
    expect(f.stateStore.snapshot('owner').memoryControls.filter(control => control.pinned)).toHaveLength(1);
  });
});

describe('consistent explicit future intent vocabulary', () => {
  it.each([
    ['明後日、写真を整理しよう', '明後日', '2026-09-26'],
    ['金曜日に写真を整理する', '金曜日', '2026-09-25'],
    ['来週の月曜日に写真を整理したい', '来週の月曜日', '2026-09-28'],
    ['今週末、写真を整理しよう', '今週末', undefined],
  ])('captures %s from the original timestamp', (text, hint, date) => {
    const memories = extractProspectiveMemories(text, at, 'source-1');
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ sourceExperienceId: 'source-1', createdAt: at, dueHint: hint });
    expect(memories[0]?.dueDate).toBe(date);
    expect(commitmentDeadline(text, at).dueHint).toBe(hint);
  });

  it('does not convert quoted, negated, conditional or questioning intent into a promise', () => {
    for (const text of ['金曜日に写真を整理する？', '明後日、写真を整理したいかもしれない', '「今週末、写真を整理しよう」と友人が言った', 'もし金曜日なら写真を整理する', '金曜日は写真を整理しない', '金曜日に友人が写真を整理する']) {
      expect(extractProspectiveMemories(text, at), text).toHaveLength(0);
    }
  });
});
