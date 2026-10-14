import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { reactionHarness, scope } from './bodyReactionHarness.js';
import { fakeFeelingJev, scenarioPolicy } from './support/feelingHarness.js';
import { composedFeeling } from '../src/wiring/feelingWiring.js';
import { SQLiteFeelingShadowStore } from '../src/mind/emotion/store/feelingShadowStore.js';
import { feelingTurnFromAnswers, feelingTurnQuestions } from '../src/contracts/feelingEventContract.js';
import { JevVoiceDecisionGateway, VOICE_SKILLS } from '../src/mind/selectors/voiceDecision.js';
import { TracedVoiceDecisionGateway } from '../src/mind/inhibition/tracedVoiceDecision.js';
import type { DecisionTraceDraft } from '../src/contracts/decisionTraceContract.js';

/**
 * Stage 2's reading of meaning (Syzygy ADR-0013 D3.1): while the fast layer is recorded (`SHANNON_CORE_AFFECT`), the feeling turn's one
 * Jev call also asks whether his words were meant and whether they were teasing; the answers go on his words' event as numbers and
 * the appraisal reads them. Without the shadow nothing is asked and nothing changes.
 */
const DAY = '2026-10-14T04:00:00.000Z';

async function chat(shadow: boolean, meaning?: { deliberate: number; teasing: number }, asked = shadow) {
  const database = new DatabaseSync(':memory:');
  const clock = { at: DAY };
  const jev = fakeFeelingJev(scenarioPolicy, meaning ? { meaning } : {});
  let harness: Awaited<ReturnType<typeof reactionHarness>> | null = null;
  const configured = composedFeeling({ database, now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: jev.chooser, turn: true, singleFace: false,
    ...(shadow ? { shadow: { database, snapshot: (scopeKey: string) => harness!.stateStore.snapshot(scopeKey) } } : {}), meaning: asked });
  harness = await reactionHarness({ feeling: configured.port, stage2: false });
  harness.clock.at = DAY;
  await harness.send('POST', '/v1/chat', { message: 'お前ポンコツだな' }, 'iphone');
  const words = database.prepare("SELECT facts_json FROM shannon_feeling_events WHERE kind = 'spoke'").all() as { facts_json: string }[];
  return { database, jev, harness, words: words.map(row => JSON.parse(row.facts_json) as Record<string, unknown>) };
}

describe('the meaning questions (feeling_meaning.v1)', () => {
  it('are asked only with the reading, and parse to numbers only when both answers are usable', () => {
    expect(Object.keys(feelingTurnQuestions())).toEqual(['stance', 'intensity', 'drawer']);
    expect(Object.keys(feelingTurnQuestions('feeling_', 'owner_alone', true))).toEqual(['feeling_stance', 'feeling_intensity', 'feeling_drawer',
      'feeling_deliberate', 'feeling_teasing']);
    const choices = { stance: { choice: 'scold' }, intensity: { choice: 'moderate' }, drawer: { choice: 'none' } };
    expect(feelingTurnFromAnswers({ ...choices, deliberate: { noul: 0.876 }, teasing: { noul: 0.1 } }, 'normal').meaning)
      .toEqual({ deliberate: 0.88, teasing: 0.1 });
    expect(feelingTurnFromAnswers({ ...choices, deliberate: { noul: 0.9 } }, 'normal').meaning).toBeUndefined();
    expect(feelingTurnFromAnswers({ ...choices, deliberate: { noul: 1.4 }, teasing: { noul: 0.1 } }, 'normal').meaning).toBeUndefined();
  });

  it('ride on the feeling turn while the shadow is on, and the reading is kept on his words\' event (no words)', async () => {
    const { jev, words } = await chat(true, { deliberate: 0.9, teasing: 0.05 });
    expect(Object.keys(jev.questions[0]!)).toContain('deliberate');
    expect((jev.states[0]!.shannon_feeling as Record<string, unknown>).read_meaning).toBe(true);
    expect(jev.traces[0]!.answers.qv).toEqual(['feeling_turn.v1', 'feeling_meaning.v1']);
    expect(words.at(-1)!.meaning).toEqual({ deliberate: 0.9, teasing: 0.05 });
    expect(JSON.stringify(words)).not.toContain('ポンコツ');
  });

  it('are not asked with the shadow alone (review M4: SHANNON_CORE_AFFECT changes no Jev question)', async () => {
    const { jev } = await chat(true, { deliberate: 0.9, teasing: 0.05 }, false);
    expect(Object.keys(jev.questions[0]!)).toEqual(['stance', 'intensity', 'drawer']);
    expect(jev.traces[0]!.answers.qv).toEqual(['feeling_turn.v1']);
  });

  it('are not asked without the shadow: the same questions, state and set as stage 1', async () => {
    const { jev, words } = await chat(false, { deliberate: 0.9, teasing: 0.05 });
    expect(Object.keys(jev.questions[0]!)).toEqual(['stance', 'intensity', 'drawer']);
    expect('read_meaning' in (jev.states[0]!.shannon_feeling as Record<string, unknown>)).toBe(false);
    expect(jev.traces[0]!.answers.qv).toEqual(['feeling_turn.v1']);
    expect(words.at(-1)!.meaning).toBeUndefined();
  });

  it('move her appraisal: meant words build more blame than words read as unmeant teasing', async () => {
    const blameAfter = async (meaning: { deliberate: number; teasing: number }) => {
      const { database } = await chat(true, meaning);
      const series = new SQLiteFeelingShadowStore(database).series(scope, 'owner', 'owner_alone', '2026-10-13T00:00:00.000Z');
      return series.filter(point => point.kind === 'spoke').at(-1)!.blame;
    };
    expect(await blameAfter({ deliberate: 0.95, teasing: 0.05 })).toBeGreaterThan(await blameAfter({ deliberate: 0.1, teasing: 0.95 }));
  });

  it('ride on the voice router\'s call too, traced as voice_route.v5', async () => {
    const asked: Record<string, unknown>[] = [];
    const answers = { ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
      reply_required: { noul: 0.9 }, solution_wanted: { noul: 0.2 }, conversation_class: { choice: 'direct' }, affect: { choice: 'annoyed' },
      affect_intensity: { choice: 'moderate' }, delivery: { choice: 'quick' }, latency_class: { choice: 'under_3s' },
      feeling_stance: { choice: 'scold' }, feeling_intensity: { choice: 'moderate' }, feeling_drawer: { choice: 'none' },
      feeling_deliberate: { noul: 0.8 }, feeling_teasing: { noul: 0.3 } };
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      asked.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ answers }));
    }) as typeof fetch;
    const drafts: DecisionTraceDraft[] = [];
    const gateway = new TracedVoiceDecisionGateway(new JevVoiceDecisionGateway({ apiKey: 'test', fetcher }), (_scope, draft) => { drafts.push(draft); },
      { usdPerJevCall: null, questionSet: { id: 'voice_route.v2', language: 'en' } });
    const input = { scopeKey: 'owner', transcript: 'ポンコツ', participantMode: 'owner' as const, requestedLocation: false, hasFreshLocation: false };
    const decided = await gateway.decide({ ...input, shannonFeeling: { audience: 'owner_alone', register_hint: 'normal', read_meaning: true } });
    expect(Object.keys(asked[0]!.questions as object)).toEqual(expect.arrayContaining(['feeling_deliberate', 'feeling_teasing']));
    expect(decided.feeling?.meaning).toEqual({ deliberate: 0.8, teasing: 0.3 });
    expect(drafts.map(draft => draft.answers.qv)).toEqual([['voice_route.v5']]);
  });
});
