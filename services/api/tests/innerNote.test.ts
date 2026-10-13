import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  CHARACTER_CORE, SHANNON_CORE_PROMPT, createInitialCompanionState, innerNoteReflectionInstructions, shannonIdentityPrompt,
  type CompanionStateSnapshot, type InnerNoteDraft, type InnerNoteReflectionFacts,
} from '@shannon/cognition';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';
import { INNER_NOTES_STEP } from '../src/infra/sqlite/migrations/emotion/001_inner_notes.js';
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

function setup(answers: Array<InnerNoteDraft | null | Error> = []) {
  let now = T0;
  const facts: InnerNoteReflectionFacts[] = [];
  const reflector: InnerNoteReflector = {
    model: DEFAULT_HAIKU_MODEL,
    async reflect(request) {
      facts.push(request.facts);
      const next = answers.shift() ?? draft();
      if (next instanceof Error) throw next;
      return { draft: next, usage: { model: DEFAULT_HAIKU_MODEL, inputTokens: 900, outputTokens: 120, cacheReadTokens: 800, cacheWriteTokens: null, costUsd: 0.00015 } };
    },
  };
  const database = new DatabaseSync(':memory:');
  const store = new SQLiteInnerNoteStore(database);
  let snapshot: CompanionStateSnapshot = createInitialCompanionState(OWNER, T0);
  const service = new InnerNoteService({ store, reflector, state: { snapshot: () => snapshot }, ownerScope: OWNER, timeZone: 'Asia/Tokyo', now: () => now,
    manual: true, sleptAfter: () => null });
  return { service, store, facts, database, at: (value: string) => { now = value; }, setSnapshot: (value: CompanionStateSnapshot) => { snapshot = value; } };
}

const touch = (at = T0, audience: 'owner' | 'others' = 'owner') => ({ scopeKey: OWNER, audience, at, touchId: `t-${at}`, phrase: 'ライ氏に胸をつつかれた（ほんの一瞬）',
  stance: 'dislike', reflex: 'flinch', said: 'ひゃっ' });

describe('inner note storage (schema step emotion/001_inner_notes)', () => {
  it('pins the step and keeps the table additive and append-first', () => {
    expect(INNER_NOTES_STEP.id).toBe('emotion/001_inner_notes');
    // Never edit the step: a change is a new step (SHANNON_SCHEMA_STEP_CHANGED).
    expect(schemaStepChecksum(INNER_NOTES_STEP)).toBe('d683a488c6ec1095487a1f8cb721506c571bc59e9bbff5e0b876c7fa9c49e3cc');
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
    expect(note.sourceIds).toEqual([`touch:t-${T0}`]);
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
    expect(voiceConversationInstructions(true, false, false, true)).toContain('Keep the same lively personality.');
    expect(voiceConversationInstructions(true, false, true, false)).toBe(voiceConversationInstructions(true, false, true, true));
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

