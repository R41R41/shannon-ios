import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, createInitialCompanionState, innerNoteReflectionInput, innerNoteReflectionInstructions, type CompanionStateSnapshot, type InnerNoteDraft,
  type InnerNoteReflectionFacts,
} from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import { InnerNoteService } from '../src/mind/emotion/innerNoteService.js';
import { ClaudeInnerNoteReflector, type InnerNoteReflector } from '../src/mind/emotion/innerNoteReflection.js';
import { SQLiteInnerNoteStore } from '../src/mind/emotion/store/innerNoteStore.js';
import { feelingBody } from '../src/mind/emotion/feelingPorts.js';
import { composedFeeling, configuredFeeling } from '../src/wiring/feelingWiring.js';
import { claudeBackground } from '../src/infra/models/claude/claudeStructured.js';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';

/**
 * Her inner note as narrator (Syzygy ADR-0013 §6, stage 2 item 4; `SHANNON_INNER_NARRATOR`): the note reads the fast layer (in words) and
 * the ledger, and tells her honne from them rather than from her replies; `intent` and `until` keep their gates. Off: byte for byte.
 */
const T0 = '2026-10-14T04:00:00.000Z';
const FAST = '[いまのボク]（速い層。事実として）快さ: 嫌。';
const facts = (extra: Partial<InnerNoteReflectionFacts> = {}): InnerNoteReflectionFacts => ({ at: T0, timeZone: 'Asia/Tokyo', events: [{ kind: 'until', at: T0 }],
  previous: null, apologies: [], kindnesses: [], feeling: { present: null, lingering: [] }, dayEndsAt: '2026-10-14T18:00:00.000Z', closing: false,
  yesterday: null, recent: [], ...extra });

describe('the narrator\'s reflection', () => {
  it('is the reflection of before without the fast layer, and one more fixed section with it', () => {
    expect(switchOn({}, 'SHANNON_INNER_NARRATOR')).toBe(false);
    const before = innerNoteReflectionInstructions(CHARACTER_CORE);
    expect(innerNoteReflectionInstructions(CHARACTER_CORE, { narrator: false })).toBe(before);
    const narrator = innerNoteReflectionInstructions(CHARACTER_CORE, { narrator: true });
    expect(narrator.startsWith(before)).toBe(true);
    expect(narrator).toContain('[語り手として]');
    expect(narrator).toContain('返事で言ったことを本音の元にしない');
    expect(innerNoteReflectionInput(facts())).not.toContain('[いまのボク]');
    expect(innerNoteReflectionInput(facts({ fastLayer: FAST }))).toContain(FAST);
  });

  it('is asked of the model with the narrator\'s instructions exactly when the fast layer is handed', async () => {
    const systems: string[] = [];
    const answer = { honne: '本音', tatemae: '建て前', reason: '理由', plan: 'つもり', bottom: '底', shown: 'sulky', tell: 'none', intent: 'keep', scale: 'ordinary',
      day_reason: null, until_minutes: 20, change_reason: null, route_summary: 'Sulking a little.', summary: null };
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      systems.push((JSON.parse(String(init?.body)).system as { text: string }[])[1]!.text);
      return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: DEFAULT_HAIKU_MODEL,
        content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 300, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 2400 } }),
        { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const reflector = new ClaudeInnerNoteReflector(store => claudeBackground(DEFAULT_HAIKU_MODEL, { apiKey: 'test-only', fetcher, usageStore: store })!);
    await reflector.reflect({ scopeKey: 'owner', facts: facts() });
    await reflector.reflect({ scopeKey: 'owner', facts: facts({ fastLayer: FAST }) });
    expect(systems).toEqual([innerNoteReflectionInstructions(), innerNoteReflectionInstructions(CHARACTER_CORE, { narrator: true })]);
  });
});

describe('what the note is handed', () => {
  const draft: InnerNoteDraft = { text: { honne: '本音。', tatemae: '建て前。', reason: '理由。', plan: 'つもり。', bottom: '底。' }, shown: 'sulky', tell: 'none',
    intent: 'keep', scale: 'ordinary', dayReason: null, untilMinutes: 20, changeReason: null, routeSummary: 'Sulking.', summary: null };

  async function reflected(fastLayer?: () => string | null) {
    const handed: InnerNoteReflectionFacts[] = [];
    const reflector: InnerNoteReflector = { model: 'test', async reflect(request) { handed.push(request.facts); return { draft, usage: null }; } };
    const snapshot = createInitialCompanionState('owner', T0);
    const notes = new InnerNoteService({ store: new SQLiteInnerNoteStore(new DatabaseSync(':memory:')), reflector, state: { snapshot: () => snapshot },
      ownerScope: 'owner', timeZone: 'Asia/Tokyo', now: () => T0, manual: true });
    notes.useBody({ partCounts: () => [], ...(fastLayer ? { fastLayer } : {}) });
    notes.turnEnded({ scopeKey: 'owner', surface: 'text', alone: true, at: T0, userMessage: 'ごめん', reply: 'べつに', feeling: null });
    await notes.flush('owner');
    return handed[0]!;
  }

  it('her fast layer while she is the narrator; nothing of it otherwise', async () => {
    expect((await reflected(() => FAST)).fastLayer).toBe(FAST);
    expect('fastLayer' in await reflected(() => null)).toBe(false);
    expect('fastLayer' in await reflected()).toBe(false);
  });

  it('reads her fast layer from her events in words, only with the narrator and the shadow', () => {
    const snapshot = (): CompanionStateSnapshot => createInitialCompanionState('owner', T0);
    const port = (narrator: boolean, shadow: boolean) => {
      const database = new DatabaseSync(':memory:');
      return composedFeeling({ database, now: () => T0, timeZone: 'Asia/Tokyo', chooser: null, turn: false, singleFace: false, narrator,
        ...(shadow ? { shadow: { database, snapshot } } : {}) }).port;
    };
    const on = port(true, true);
    const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1_000).toISOString();
    for (const [index, stance] of [['dislike'], [null], [null], [null]].map(([value], i) => [i, value] as const)) {
      feelingBody.touched(on, 'owner', { id: `t${index}`, type: 'poke', part: 'chest', audience: 'owner', occurredAt: at(index * 30), burstId: `b${index}` },
        stance ? { stance } : {});
    }
    const line = feelingBody.noteReader(() => on, snapshot).fastLayer('owner', at(150));
    expect(line).toMatch(/^\[いまのボク\]/u);
    expect(line).not.toContain('相手を責めたい気持ち: ない');
    expect(line).not.toMatch(/\d/u);
    expect(feelingBody.noteReader(() => port(false, true), snapshot).fastLayer('owner', T0)).toBeNull();
    expect(feelingBody.noteReader(() => port(true, false), snapshot).fastLayer('owner', T0)).toBeNull();
    expect(feelingBody.noteReader(() => null, snapshot).fastLayer('owner', T0)).toBeNull();
  });

  it('is wired only with her inner note and the fast layer', () => {
    const environment = { SHANNON_FEELING_EVENTS: 'on', SHANNON_CORE_AFFECT: 'on', SHANNON_INNER_NARRATOR: 'on' };
    const parts = { databasePath: ':memory:', timeZone: 'Asia/Tokyo', now: () => T0, trace: null, state: () => createInitialCompanionState('owner', T0) };
    expect(configuredFeeling(environment, parts)!.port.narrator).toBeUndefined();
    expect(configuredFeeling({ ...environment, SHANNON_INNER_NOTE: 'on' }, parts)!.port.narrator).toBe(true);
    expect(configuredFeeling({ ...environment, SHANNON_INNER_NOTE: 'on', SHANNON_CORE_AFFECT: 'off' }, parts)!.port.narrator).toBeUndefined();
  });
});
