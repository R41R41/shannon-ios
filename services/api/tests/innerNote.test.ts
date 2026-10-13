import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  CHARACTER_CORE, SHANNON_CORE_PROMPT, createInitialCompanionState, innerNoteReflectionInstructions, shannonIdentityPrompt,
  type CompanionStateSnapshot, type InnerNoteDraft, type InnerNoteReflectionFacts,
} from '@shannon/cognition';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';
import { INNER_NOTES_STEP } from '../src/infra/sqlite/migrations/emotion/001_inner_notes.js';
import { INNER_NOTE_EPISODES_STEP } from '../src/infra/sqlite/migrations/emotion/002_inner_note_episodes.js';
import { INNER_NOTE_ATTEMPTS_STEP } from '../src/infra/sqlite/migrations/emotion/003_inner_note_attempts.js';
import { schemaStepChecksum } from '../src/infra/sqlite/migrations/schemaSteps.js';
import { InnerNoteService } from '../src/mind/emotion/innerNoteService.js';
import type { InnerNoteReflector } from '../src/mind/emotion/innerNoteReflection.js';
import { ClaudeInnerNoteReflector } from '../src/mind/emotion/innerNoteReflection.js';
import {
  INNER_NOTE_PRESENCE_LINE, innerNoteEnabled, innerNoteMood, innerNoteRouteInput, innerNoteTouchContext, innerNoteTurnContext, innerNoteVoice,
  withCharacterCore,
} from '../src/mind/emotion/innerNotePorts.js';
import { innerNoteResponse } from '../src/infra/http/serverInnerNoteRoute.js';
import { claudeBackground } from '../src/infra/models/claude/claudeStructured.js';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { HAIKU_PROTOCOL_PREFIX } from '../src/infra/models/anthropic/haikuCache.js';
import { INNER_NOTE_REPLY_FEELING_INSTRUCTIONS, REPLY_FEELING_INSTRUCTIONS, replyFeelingInstructions } from '../src/mind/emotion/chatReplyFeeling.js';
import { JevVoiceDecisionGateway, INNER_AFFECT_INSTRUCTIONS } from '../src/mind/selectors/jevVoiceDecision.js';
import { TracedVoiceDecisionGateway } from '../src/mind/inhibition/tracedVoiceDecision.js';
import { VOICE_SKILLS } from '../src/contracts/voiceDecisionContract.js';
import { bodyReactionPrompt } from '../src/surfaces/body/bodyReactionPrompt.js';
import { voiceConversationInstructions } from '../src/surfaces/voice/voiceConversationInstructions.js';

const OWNER = 'owner';
const T0 = '2026-10-14T13:30:00.000Z'; // 22:30 in Tokyo

function draft(overrides: Partial<InnerNoteDraft> = {}): InnerNoteDraft {
  return {
    text: { honne: 'びっくりした。いやってほどじゃない。', tatemae: 'ツンとして口数を減らす。', reason: '安く見られたくない。', plan: 'しばらくこのまま。',
      bottom: 'ライ氏のことは好きなまま。' },
    shown: 'sulky', tell: 'blush', intent: 'keep', scale: 'ordinary', dayReason: null, untilMinutes: 30, changeReason: null,
    routeSummary: 'Shannon is acting a little sulky but is not truly hurt.', summary: null, ...overrides,
  };
}

type Answer = InnerNoteDraft | null | Error | (() => InnerNoteDraft);

function setup(answers: Answer[] = [], limits: Record<string, number> = {}, options: { database?: DatabaseSync;
  recent?: () => { role: 'user' | 'assistant'; content: string; sourceId?: string }[] } = {}) {
  let now = T0;
  const facts: InnerNoteReflectionFacts[] = [];
  const reflector: InnerNoteReflector = {
    model: DEFAULT_HAIKU_MODEL,
    async reflect(request) {
      facts.push(request.facts);
      const answer = answers.shift() ?? draft();
      const next = typeof answer === 'function' ? answer() : answer;
      if (next instanceof Error) throw next;
      return { draft: next, usage: { model: DEFAULT_HAIKU_MODEL, inputTokens: 900, outputTokens: 120, cacheReadTokens: 800, cacheWriteTokens: null, costUsd: 0.00015 } };
    },
  };
  const database = options.database ?? new DatabaseSync(':memory:');
  const store = new SQLiteInnerNoteStore(database);
  let snapshot: CompanionStateSnapshot = createInitialCompanionState(OWNER, T0);
  const service = new InnerNoteService({ store, reflector, state: { snapshot: () => snapshot }, ownerScope: OWNER, timeZone: 'Asia/Tokyo', now: () => now,
    manual: true, retentionDays: 30, limits, ...(options.recent ? { recent: options.recent } : {}) });
  return { service, store, facts, database, at: (value: string) => { now = value; }, setSnapshot: (value: CompanionStateSnapshot) => { snapshot = value; } };
}

const touch = (at = T0, audience: 'owner' | 'others' = 'owner') => ({ scopeKey: OWNER, audience, at, touchId: `t-${at}`, sourceId: `experience:burst-${at}`,
  phrase: 'ライ氏に胸をつつかれた（ほんの一瞬）', stance: 'dislike', reflex: 'flinch', said: 'ひゃっ' });
const forgotten = (memoryId: string, sourceEvidence?: string) => ({ memoryId, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: T0,
  changeReason: 'test', ...(sourceEvidence ? { sourceEvidence } : {}) }) as never;

describe('inner note storage (schema step emotion/001_inner_notes)', () => {
  it('pins the step and keeps the table additive and append-first', () => {
    expect(INNER_NOTES_STEP.id).toBe('emotion/001_inner_notes');
    // Never edit the step: a change is a new step (SHANNON_SCHEMA_STEP_CHANGED).
    expect(schemaStepChecksum(INNER_NOTES_STEP)).toBe('d683a488c6ec1095487a1f8cb721506c571bc59e9bbff5e0b876c7fa9c49e3cc');
    // N10: the later steps are pinned the same way.
    expect([INNER_NOTE_EPISODES_STEP.id, INNER_NOTE_ATTEMPTS_STEP.id]).toEqual(['emotion/002_inner_note_episodes', 'emotion/003_inner_note_attempts']);
    expect(schemaStepChecksum(INNER_NOTE_EPISODES_STEP)).toBe('82db51e74ebb56f08b3392b192a27490a0f3fc111deb956c022a59b9497452df');
    expect(schemaStepChecksum(INNER_NOTE_ATTEMPTS_STEP)).toBe('da679362296ea082a98c9b58ea1105862782f38e1f131b07162f319eddee1010');
    const { database } = setup();
    const columns = database.prepare("PRAGMA table_info('shannon_inner_notes')").all().map(row => String(row.name));
    expect(columns).toEqual(expect.arrayContaining(['honne', 'tatemae', 'reason', 'plan', 'bottom', 'shown', 'tell', 'until_at', 'scale', 'intent',
      'route_summary', 'source_ids_json', 'core_version', 'core_hash', 'cost_usd', 'replaced_at', 'closed_at']));
  });
});

describe('the reflection writes her note after salient events (ADR-0012 D2.3)', () => {
  it('writes a note after a touch of the owner alone, and none for a touch anyone else may have made', async () => {
    const { service, store, facts } = setup();
    service.touched(touch(T0, 'others'));
    await service.flush(OWNER);
    expect(store.latest(OWNER)).toBeNull();
    service.touched(touch());
    expect(service.pending(OWNER)).toHaveLength(1);
    await service.flush(OWNER);
    const note = store.latest(OWNER)!;
    expect(note.hooks).toMatchObject({ shown: 'sulky', intent: 'keep', scale: 'ordinary', until: '2026-10-14T14:00:00.000Z' });
    expect(note.coreVersion).toBe(CHARACTER_CORE.version);
    expect(note.sourceIds).toEqual([`experience:burst-${T0}`]);
    expect(note.dayKey).toBe('2026-10-14');
    expect(note.dayEndsAt).toBe('2026-10-14T18:00:00.000Z');
    expect(facts[0]!.events[0]!.touch).toMatchObject({ stance: 'dislike', reflex: 'flinch' });
    expect(service.pending(OWNER)).toHaveLength(0);
    expect(service.current(OWNER, T0)?.id).toBe(note.id);
    expect(service.current('someone-else', T0)).toBeNull();
  });

  it('lets one apology move intent one step only (K1), and counts the apologies of the day as facts', async () => {
    const { service, store, facts, at } = setup([draft(), draft({ intent: 'none', untilMinutes: null }), draft({ intent: 'none', untilMinutes: null })]);
    service.touched(touch());
    await service.flush(OWNER);
    at('2026-10-14T13:31:00.000Z');
    service.turnEnded({ scopeKey: OWNER, surface: 'voice', alone: true, at: '2026-10-14T13:31:00.000Z', userMessage: 'ごめん', reply: '……そうですか。', feeling: null });
    await service.flush(OWNER);
    expect(store.latest(OWNER)!.hooks.intent).toBe('soften');
    expect(store.latest(OWNER)!.flags).toMatchObject({ gateStopped: true });
    at('2026-10-14T13:33:00.000Z');
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: '2026-10-14T13:33:00.000Z', userMessage: 'ほんとにごめん', reply: '……', feeling: null });
    await service.flush(OWNER);
    expect(facts[2]!.apologies).toEqual(['2026-10-14T13:31:00.000Z', '2026-10-14T13:33:00.000Z']);
    expect(store.latest(OWNER)!.hooks.intent).toBe('forgive');
  });

  it('ignores turns with others present and ordinary turns; reacts to a tease and a strong reply', async () => {
    const { service, store } = setup();
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: false, at: T0, userMessage: 'ごめん', reply: 'はい', feeling: null });
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: '今日の天気は？', reply: '晴れです', feeling: { kind: 'focused', intensity: 0.52 } });
    expect(service.pending(OWNER)).toHaveLength(0);
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: 'ほんとポンコツだな', reply: 'むっ', feeling: null });
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: '物語なんてAIが量産すればいい', reply: '反対です', feeling: { kind: 'annoyed', intensity: 0.6 } });
    expect(service.pending(OWNER).map(event => event.kind)).toEqual(['teasing', 'strong_reply']);
    await service.flush(OWNER);
    expect(store.latest(OWNER)!.triggers).toEqual(['teasing', 'strong_reply']);
  });

  it('reflects again when her until comes, and closes her day at 3:00 with a reflection that is never carried on (K10)', async () => {
    const { service, store, facts, at } = setup([draft(), draft({ intent: 'soften' }),
      draft({ intent: 'keep', untilMinutes: 30, summary: '胸をつつかれて、すねた日。' })]);
    service.touched(touch());
    await service.flush(OWNER);
    at('2026-10-14T14:01:00.000Z');
    await service.sweep();
    await service.flush(OWNER);
    expect(facts[1]!.events.map(event => event.kind)).toEqual(['until']);
    at('2026-10-14T18:00:30.000Z');
    await service.sweep();
    const closed = store.latest(OWNER)!;
    expect(closed.closedAt).toBe('2026-10-14T18:00:30.000Z');
    expect(closed.hooks).toMatchObject({ intent: 'none', until: null });
    expect(closed.summary).toBe('胸をつつかれて、すねた日。');
    expect(facts[2]!.closing).toBe(true);
    expect(service.current(OWNER, '2026-10-14T18:01:00.000Z')).toBeNull();
    // The next day starts without a grudge: the first reflection is told yesterday only as something that happened.
    at('2026-10-15T01:00:00.000Z');
    service.touched(touch('2026-10-15T01:00:00.000Z'));
    await service.flush(OWNER);
    expect(facts[3]!.previous).toBeNull();
    expect(facts[3]!.yesterday).toBe('胸をつつかれて、すねた日。');
    expect(store.latest(OWNER)!.dayKey).toBe('2026-10-15');
  });

  it('closes her day at his goodnight, and closes it as it stands when the closing reflection fails', async () => {
    const { service, store } = setup([draft(), new Error('INNER_NOTE_UPSTREAM_529')]);
    service.touched(touch());
    await service.flush(OWNER);
    service.turnEnded({ scopeKey: OWNER, surface: 'voice', alone: true, at: T0, userMessage: 'じゃあ、おやすみ', reply: 'おやすみなさい', feeling: null });
    await service.idle();
    expect(store.latest(OWNER)!.closedAt).toBe(T0);
    expect(service.current(OWNER, T0)).toBeNull();
  });

  it('forgets a note whose turn the owner had her forget', async () => {
    const { service, store, setSnapshot } = setup();
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: 'ごめん', reply: '…', feeling: null, sourceId: 'experience:e1' });
    await service.flush(OWNER);
    expect(store.latest(OWNER)).not.toBeNull();
    const state = createInitialCompanionState(OWNER, T0);
    setSnapshot({ ...state, memoryControls: [{ memoryId: 'e1', status: 'forgotten', updatedAt: T0 } as never] });
    await service.sweep();
    expect(store.latest(OWNER)).toBeNull();
  });
});

describe('forgetting follows the note and everything derived from it (H1)', () => {
  it('deletes the notes of a forgotten voice turn by its words, and every later note of its lineage', async () => {
    const { service, store, at, setSnapshot } = setup();
    service.turnEnded({ scopeKey: OWNER, surface: 'voice', alone: true, at: T0, userMessage: 'ごめん、出来心でケーキを全部食べちゃった', reply: 'しばらく口ききません', feeling: null,
      sourceId: 'utterance:u1' });
    service.bind(OWNER, 'utterance:u1', 'experience:e-voice');
    await service.flush(OWNER);
    at('2026-10-14T13:35:00.000Z');
    service.touched(touch('2026-10-14T13:35:00.000Z'));
    await service.flush(OWNER);
    const derived = store.latest(OWNER)!;
    expect(derived.sourceIds).toEqual(expect.arrayContaining(['experience:e-voice', 'experience:burst-2026-10-14T13:35:00.000Z']));
    // He has her forget the turn: by its id (bound) and by its words, both notes go, the later one through its lineage.
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten('e-voice', 'ごめん、出来心でケーキを全部食べちゃった')] });
    expect(service.current(OWNER, '2026-10-14T13:36:00.000Z')).toBeNull();
    await service.sweep();
    expect(store.since(OWNER, '2026-10-14T00:00:00.000Z', 10)).toEqual([]);
  });

  it('discards a reflection whose turn was forgotten while the call ran, and drops queued events of a forgotten turn', async () => {
    const { service, store, setSnapshot } = setup([() => {
      setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten('e2', 'ほんとにごめんって')] });
      return draft();
    }]);
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: 'ほんとにごめんって', reply: '…', feeling: null, sourceId: 'experience:e2' });
    await service.flush(OWNER);
    expect(store.latest(OWNER)).toBeNull();
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: 'ほんとにごめんって', reply: '…', feeling: null, sourceId: 'experience:e2' });
    expect(service.pending(OWNER)).toEqual([]);
  });

  it('carries a closed day into the next day only through lineage: forgetting the touch removes yesterday\'s summary too', async () => {
    const { service, store, at, setSnapshot, facts } = setup([draft(), draft({ summary: '胸をつつかれた日。' }), draft({ intent: 'none', untilMinutes: null })]);
    service.touched(touch());
    await service.flush(OWNER);
    at('2026-10-14T18:01:00.000Z');
    await service.sweep();
    at('2026-10-15T01:00:00.000Z');
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: '2026-10-15T01:00:00.000Z', userMessage: 'おはよう、昨日はごめんね', reply: 'おはようございます',
      feeling: null, sourceId: 'experience:e3' });
    await service.flush(OWNER);
    expect(facts[2]!.yesterday).toBe('胸をつつかれた日。');
    expect(store.latest(OWNER)!.sourceIds).toContain(`experience:burst-${T0}`);
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten(`burst-${T0}`)] });
    await service.sweep();
    expect(store.since(OWNER, '2026-10-14T00:00:00.000Z', 10)).toEqual([]);
  });

  it('keeps notes only as long as the touches they come from (retention)', async () => {
    const { service, store, at } = setup();
    service.touched(touch());
    await service.flush(OWNER);
    at('2026-11-14T13:31:00.000Z');
    await service.sweep();
    expect(store.latest(OWNER)).toBeNull();
  });
});

describe('the cap and the queue (H2, low)', () => {
  it('asks an ordinary sulk without until to settle at its hour, and ends it there', async () => {
    const { service, store, facts, at } = setup([draft({ untilMinutes: null }), draft({ untilMinutes: 60 })]);
    service.touched(touch());
    await service.flush(OWNER);
    expect(store.latest(OWNER)!.hooks).toMatchObject({ intent: 'keep', until: null });
    expect(service.current(OWNER, '2026-10-14T14:29:00.000Z')).not.toBeNull();
    at('2026-10-14T14:31:00.000Z');
    await service.sweep();
    await service.flush(OWNER);
    expect(facts[1]!.events.map(event => event.kind)).toEqual(['until']);
    expect(store.latest(OWNER)!.hooks).toMatchObject({ intent: 'none', until: null });
    expect(store.latest(OWNER)!.flags).toMatchObject({ capEnded: true });
    // Asked once: the sweep does not keep calling her.
    await service.sweep();
    expect(service.pending(OWNER)).toEqual([]);
  });

  it('closes a day without taking the next day\'s events, and counts failed attempts toward the cap', async () => {
    const { service, store, facts, at } = setup([draft(), draft({ summary: '一日。' }), draft()], { reflectionsPerDay: 2 });
    service.touched(touch());
    await service.flush(OWNER);
    at('2026-10-14T18:00:30.000Z');
    service.touched(touch('2026-10-14T18:00:10.000Z'));
    await service.sweep();
    expect(facts[1]!.events.map(event => event.kind)).toEqual(['day_end']);
    expect(service.pending(OWNER).map(event => event.at)).toEqual(['2026-10-14T18:00:10.000Z']);
    await service.flush(OWNER);
    expect(store.latest(OWNER)!.dayKey).toBe('2026-10-15');
    const capped = setup([new Error('INNER_NOTE_UPSTREAM_529'), draft()], { reflectionsPerDay: 1 });
    capped.service.touched(touch());
    await capped.service.flush(OWNER);
    capped.service.touched(touch());
    await capped.service.flush(OWNER);
    expect(capped.facts).toHaveLength(1);
    expect(capped.store.latest(OWNER)).toBeNull();
  });
});

describe('the re-review (N1–N4)', () => {
  it('retries an expired sulk\'s settling with backoff, then ends the sulk in code without closing her day (N1, N8)', async () => {
    const failing = () => new Error('INNER_NOTE_UPSTREAM_529');
    const { service, store, at, facts } = setup([draft({ untilMinutes: 10 }), failing(), failing(), failing()]);
    service.touched(touch());
    await service.flush(OWNER);
    const first = store.latest(OWNER)!;
    const minutes = (value: number) => new Date(Date.parse('2026-10-14T13:41:00.000Z') + value * 60_000).toISOString();
    // Tries at +0, +2 and +6 minutes (backoff 2, 4, 8); at +14 the third failure ends the sulk.
    for (const offset of [0, 1, 2, 6, 14]) {
      at(minutes(offset));
      await service.sweep();
      await service.flush(OWNER);
      expect(store.latest(OWNER)!.flags.endedByCode ?? null, `at +${offset}`).toBe(offset === 14 ? true : null);
    }
    const ended = store.latest(OWNER)!;
    // N8: one row of the same day, calm, not closed: the day keeps its id, its apologies and its summary for 3:00.
    expect(ended).toMatchObject({ dayId: first.dayId, closedAt: null, summary: null, hooks: { intent: 'none', until: null, shown: 'neutral', tell: 'none' } });
    expect(ended.text).toEqual(first.text);
    expect(store.since(OWNER, '2026-10-14T00:00:00.000Z', 10).filter(note => note.closedAt)).toEqual([]);
    expect(innerNoteTurnContext(service, OWNER, 'owner', minutes(15))).toContain('[さっきまでの気持ち]');
    expect(innerNoteRouteInput(service, OWNER, true, minutes(15))).toEqual({});
    at(minutes(30));
    await service.sweep();
    await service.flush(OWNER);
    expect(facts).toHaveLength(4);
  });

  it('records the conversation lines it read as sources, and forgets a note that quotes a forgotten turn (N2)', async () => {
    const { service, store, setSnapshot } = setup([draft({ text: { ...draft().text, honne: '「来週の京都旅行で行くお寺の話」をされて、ちょっと嬉しかった。' } })], {},
      { recent: () => [{ role: 'user', content: '来週の京都旅行で行くお寺の話なんだけど', sourceId: 'experience:e-trip' }] });
    service.touched(touch());
    await service.flush(OWNER);
    expect(store.latest(OWNER)!.sourceIds).toContain('experience:e-trip');
    // Forgotten by its words only (no id): the note's own words quote it, so it goes too.
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten('other-id', '来週の京都旅行で行くお寺の話')] });
    await service.sweep();
    expect(store.latest(OWNER)).toBeNull();
  });

  it('keeps a day\'s sources at its close and drops yesterday\'s, bounded (N3)', async () => {
    const { service, store, at } = setup([draft(), draft({ summary: '一日目。' }), draft(), draft({ summary: '二日目。' })]);
    service.touched(touch());
    await service.flush(OWNER);
    at('2026-10-14T18:01:00.000Z');
    await service.sweep();
    at('2026-10-15T13:00:00.000Z');
    service.touched(touch('2026-10-15T13:00:00.000Z'));
    await service.flush(OWNER);
    // N6: and the summary it read, as a note of its own.
    expect(store.latest(OWNER)!.sourceIds).toEqual([expect.stringMatching(/^note:/u), `experience:burst-${T0}`, 'experience:burst-2026-10-15T13:00:00.000Z']);
    at('2026-10-15T18:01:00.000Z');
    await service.sweep();
    // The second day's closing note keeps its own moment only: forgetting the first day's touch would not reach it.
    expect(store.latest(OWNER)!.sourceIds).toEqual(['experience:burst-2026-10-15T13:00:00.000Z']);
  });

  it('keeps the day\'s attempts in the database across a restart (N4)', async () => {
    const database = new DatabaseSync(':memory:');
    const first = setup([draft()], { reflectionsPerDay: 1 }, { database });
    first.service.touched(touch());
    await first.service.flush(OWNER);
    const second = setup([draft()], { reflectionsPerDay: 1 }, { database });
    second.service.touched(touch('2026-10-14T13:40:00.000Z'));
    await second.service.flush(OWNER);
    expect(second.facts).toHaveLength(0);
  });
});

describe('the third review (N6, N9)', () => {
  it('deletes every later note of a day whose note was forgotten, however busy the day (N6)', async () => {
    const { service, store, at, setSnapshot } = setup([draft(), draft(), draft(), draft({ summary: '忙しい日。' })], { reflectionsPerDay: 100 });
    service.touched(touch());
    await service.flush(OWNER);
    // A busy evening: seventy of his turns in one reflection, more sources than one note keeps.
    at('2026-10-14T13:40:00.000Z');
    for (let index = 0; index < 70; index += 1) {
      service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: '2026-10-14T13:40:00.000Z', userMessage: `ほんとポンコツだな${index}`, reply: 'むっ',
        feeling: null, sourceId: `experience:busy-${index}` });
    }
    await service.flush(OWNER);
    at('2026-10-14T13:50:00.000Z');
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: '2026-10-14T13:50:00.000Z', userMessage: 'ごめん', reply: '…', feeling: null,
      sourceId: 'experience:late' });
    await service.flush(OWNER);
    const notes = store.since(OWNER, '2026-10-14T00:00:00.000Z', 10);
    expect(notes).toHaveLength(3);
    expect(store.latest(OWNER)!.sourceIds).toHaveLength(64);
    expect(store.latest(OWNER)!.sourceIds).not.toContain(`experience:burst-${T0}`);
    // A summary she read the next day goes with its day: the next day's first note lists it.
    at('2026-10-14T18:01:00.000Z');
    await service.sweep();
    const closing = store.latest(OWNER)!;
    at('2026-10-15T01:00:00.000Z');
    service.touched(touch('2026-10-15T01:00:00.000Z'));
    await service.flush(OWNER);
    expect(store.latest(OWNER)!.sourceIds).toContain(`note:${closing.id}`);
    expect(store.latest(OWNER)!.sourceIds.length).toBeLessThanOrEqual(64);
    // He has her forget the first touch: its note goes, every later note of that day though its capped lineage lost it, and what read the day.
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten(`burst-${T0}`)] });
    await service.sweep();
    expect(store.since(OWNER, '2026-10-14T00:00:00.000Z', 10)).toEqual([]);
  });

  it('keeps a later day that never read a forgotten day, and an earlier note of the same day', async () => {
    const { service, store, at, setSnapshot } = setup([draft(), draft()], { reflectionsPerDay: 100 });
    service.turnEnded({ scopeKey: OWNER, surface: 'text', alone: true, at: T0, userMessage: 'ごめん', reply: '…', feeling: null, sourceId: 'experience:early' });
    await service.flush(OWNER);
    at('2026-10-14T13:40:00.000Z');
    service.touched(touch('2026-10-14T13:40:00.000Z'));
    await service.flush(OWNER);
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten('burst-2026-10-14T13:40:00.000Z')] });
    await service.sweep();
    expect(store.since(OWNER, '2026-10-14T00:00:00.000Z', 10).map(note => note.sourceIds)).toEqual([['experience:early']]);
  });

  it('matches only forgotten words, and only a quote of twelve characters or more (N9)', async () => {
    const { service, store, setSnapshot } = setup([draft({ text: { ...draft().text, honne: 'おはようって言われて、来週の京都旅行で行くお寺の話を思い出した。' } })]);
    service.touched(touch());
    await service.flush(OWNER);
    const corrected = { memoryId: 'fact-trip', kind: 'user_fact', status: 'active', pinned: false, updatedAt: T0, changeReason: 'test',
      overrideText: '再来週の旅行', sourceEvidence: '来週の京都旅行で行くお寺の話' } as never;
    // A greeting forgotten is not a quote; a corrected fact is not forgotten; a short forgotten phrase is not matched.
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten('greet', 'おはよう'), corrected, forgotten('short', '京都旅行')] });
    await service.sweep();
    expect(store.latest(OWNER)).not.toBeNull();
    expect(service.current(OWNER, T0)).not.toBeNull();
    setSnapshot({ ...createInitialCompanionState(OWNER, T0), memoryControls: [forgotten('trip', '来週の京都旅行で行くお寺の話')] });
    await service.sweep();
    expect(store.latest(OWNER)).toBeNull();
  });
});

describe('the owner reads her notes afterwards (answer 3)', () => {
  it('shows what she shows at once and the whole note only once its episode closed; the day summary counts the gate', async () => {
    const { service, store, at } = setup([draft(), draft({ intent: 'none', untilMinutes: null, changeReason: '時間がたって、もう怒っていない' })]);
    service.touched(touch());
    await service.flush(OWNER);
    let view = innerNoteResponse({ store, now: () => T0 }, OWNER);
    expect(view.notes[0]).toMatchObject({ tatemae: 'ツンとして口数を減らす。', closed: false, shown: 'sulky' });
    expect(view.notes[0]!.text).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('びっくりした');
    // Her until comes and she lets it go (time is her own reason; an apology alone would have moved it one step).
    at('2026-10-14T14:00:00.000Z');
    await service.sweep();
    await service.flush(OWNER);
    view = innerNoteResponse({ store, now: () => '2026-10-14T14:01:00.000Z' }, OWNER);
    const first = view.notes.find(note => note.intent === 'keep')!;
    expect(first.closed).toBe(true);
    expect(first.text?.honne).toBe('びっくりした。いやってほどじゃない。');
    // The note that let it go is the newest: what it says in full waits for its own episode to end.
    expect(view.notes[0]!.text).toBeUndefined();
    expect(view.days[0]).toMatchObject({ dayKey: '2026-10-14', reflections: 2, gateStopped: 0, episodes: [{ scale: 'ordinary', minutes: 30 }] });
  });
});

describe('the reflection call (D3: Haiku, its fixed part cached for an hour, booked in memory_background)', () => {
  it('sends the core and the rules as their own cached block, and the facts uncached', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const answer = { honne: '本音', tatemae: '建て前', reason: '理由', plan: 'つもり', bottom: '底', shown: 'sulky', tell: 'none', intent: 'keep', scale: 'ordinary',
      day_reason: null, until_minutes: 20, change_reason: null, route_summary: 'Sulking a little.', summary: null };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL, content: [{ type: 'text', text: JSON.stringify(answer) }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 300, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 2400,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }), { headers: { 'content-type': 'application/json' } });
    });
    const rows: unknown[] = [];
    const reflector = new ClaudeInnerNoteReflector(store => claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: 'test-only', fetcher: fetcher as typeof fetch, usageStore: store })!,
      { recordLlmUsage: row => rows.push(row) });
    const result = await reflector.reflect({ scopeKey: OWNER, facts: { at: T0, timeZone: 'Asia/Tokyo', events: [{ kind: 'until', at: T0 }], previous: null, apologies: [],
      kindnesses: [], feeling: { present: null, lingering: [] }, dayEndsAt: '2026-10-14T18:00:00.000Z', closing: false, yesterday: null, recent: [] } });
    expect(result.draft).toMatchObject({ shown: 'sulky', intent: 'keep', untilMinutes: 20 });
    expect(result.usage).toMatchObject({ cacheReadTokens: 2400, model: DEFAULT_HAIKU_MODEL });
    const system = bodies[0]!.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]!.text).toBe(HAIKU_PROTOCOL_PREFIX);
    expect(system[1]).toEqual({ type: 'text', text: innerNoteReflectionInstructions(), cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(JSON.stringify(bodies[0]!.messages)).toContain('前のメモで決めた時刻が来た');
    expect(rows).toMatchObject([{ lane: 'memory_background' }]);
  });
});

describe('readers: switched off is byte for byte what it was (ADR-0012 stage 1)', () => {
  it('reads the switch off unless it is on', () => {
    expect(innerNoteEnabled({})).toBe(false);
    expect(innerNoteEnabled({ SHANNON_INNER_NOTE: 'on' })).toBe(true);
    expect(replyFeelingInstructions({})).toBe(REPLY_FEELING_INSTRUCTIONS);
    expect(replyFeelingInstructions({ SHANNON_INNER_NOTE: 'on' })).toBe(INNER_NOTE_REPLY_FEELING_INSTRUCTIONS);
    expect(INNER_NOTE_REPLY_FEELING_INSTRUCTIONS).not.toMatch(/すでに謝ってもらった|今回のライ氏の発言そのものに|ふだんの会話はnullかsubtle/u);
  });

  it('changes no identity, block, line or face without a port', () => {
    const parts = { identity: SHANNON_CORE_PROMPT, profile: '', state: '' };
    expect(withCharacterCore(parts, null)).toBe(parts);
    expect(innerNoteTurnContext(null, OWNER, 'owner', T0)).toBe('');
    expect(innerNoteRouteInput(null, OWNER, true, T0)).toEqual({});
    expect(innerNoteVoice.presence(null)).toBe('Prioritize emotional presence or natural companionship; do not force a problem-solving frame or checklist.');
    const mood = { expression: 'calm' as const };
    expect(innerNoteMood(null, OWNER, T0, mood)).toBe(mood);
    expect(voiceConversationInstructions(true, false, false, false)).toContain('Keep the same lively maid personality.');
    expect(voiceConversationInstructions(true, false, false, false)).toContain('Sound bright and self-assured');
    // M4: with the switch on, no fixed tone and no "lively personality": how she sounds is her core's.
    expect(voiceConversationInstructions(true, false, false, true)).not.toMatch(/lively|Sound bright/u);
    expect(voiceConversationInstructions(true, false, false, true)).toContain('present with a friend');
  });

  it('with a port: her character core in all three identities, her note, Jev, the face and the touch prompt', async () => {
    const { service } = setup();
    service.touched(touch());
    await service.flush(OWNER);
    const alone = withCharacterCore({ identity: SHANNON_CORE_PROMPT }, service).identity;
    expect(alone).toContain(CHARACTER_CORE.text);
    expect(alone).not.toContain('メイドAI');
    expect(withCharacterCore({ identity: shannonIdentityPrompt('guest') }, service).identity).toContain('名前のAGIである');
    expect(withCharacterCore({ identity: 'anything else' }, service).identity).toBe('anything else');
    expect(innerNoteTurnContext(service, OWNER, 'owner', T0)).toContain('本音: びっくりした');
    expect(innerNoteTurnContext(service, OWNER, 'others', T0)).not.toContain('本音');
    expect(innerNoteRouteInput(service, OWNER, true, T0)).toEqual({ shannonInner: 'Shannon is acting a little sulky but is not truly hurt.' });
    expect(innerNoteRouteInput(service, OWNER, false, T0)).toEqual({});
    expect(innerNoteVoice.presence(service)).toBe(INNER_NOTE_PRESENCE_LINE);
    expect(innerNoteMood(service, OWNER, T0, { expression: 'joyful' as const, feeling: 'proud' as const })).toEqual({ expression: 'annoyed', tell: 'blush',
      until: '2026-10-14T14:00:00.000Z' });
    // M1: an override (an emergency) keeps its face.
    const urgent = { expression: 'concerned' as const };
    expect(innerNoteMood(service, OWNER, T0, urgent, true)).toBe(urgent);
    const prompt = bodyReactionPrompt({ touch: { type: 'poke', durationMs: 200, ongoing: false } as never, audience: 'owner', feeling: { primary: 'neutral' } as never,
      burst: { id: 'b', type: 'poke', count: 1 } as never, sitting: [], said: [], conversation: [], at: T0, inner: { block: innerNoteTouchContext(service, OWNER, 'owner', T0) } });
    expect(prompt).toContain(CHARACTER_CORE.summary);
    expect(prompt).toContain('- 建て前: ツンとして口数を減らす。');
    expect(prompt).not.toContain('からかいに寄せず');
  });

  it('asks Jev voice_route.v3 with her line in the state, and records it as such', async () => {
    const states: unknown[] = [];
    const answers = {
      ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
      reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.2 },
      conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'bright' }, affect_intensity: { type: 'choice', choice: 'subtle' },
      delivery: { type: 'choice', choice: 'quick' }, latency_class: { type: 'choice', choice: 'under_3s' },
    };
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      states.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ answers }));
    });
    const traces: Array<{ answers: Record<string, unknown> }> = [];
    const gateway = new TracedVoiceDecisionGateway(new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch }),
      (_scope, trace) => { traces.push(trace as never); }, { usdPerJevCall: null, questionSet: { id: 'voice_route.v1', language: 'en' } });
    const input = { scopeKey: OWNER, transcript: 'ごめんね', participantMode: 'owner' as const, requestedLocation: false, hasFreshLocation: false };
    await gateway.decide(input);
    await gateway.decide({ ...input, shannonInner: 'Shannon is sulking a little.' });
    const [before, after] = states as Array<{ state: Record<string, unknown>; questions: Record<string, { instructions: string }> }>;
    expect(before!.state.shannon_inner).toBeUndefined();
    expect(after!.state.shannon_inner).toBe('Shannon is sulking a little.');
    expect(after!.questions.affect!.instructions).toBe(INNER_AFFECT_INSTRUCTIONS);
    expect(before!.questions.affect!.instructions).toBe('Choose the primary emotional performance for Shannon\'s spoken reply.');
    expect(traces.map(trace => trace.answers.qv)).toEqual([['voice_route.v1'], ['voice_route.v3']]);
  });
});

