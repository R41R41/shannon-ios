import { describe, expect, it } from 'vitest';
import { LocalVoiceDecisionGateway, VOICE_SKILLS } from '../src/mind/selectors/voiceDecision.js';
import { ownerCallFacts, voiceDecisionEvaluationCases, type VoiceDecisionEvaluationCase } from './voiceDecisionEvaluationCases.js';

describe('voice decision evaluation catalog', () => {
  it('covers at least twenty named conversation patterns without duplicate IDs', () => {
    expect(voiceDecisionEvaluationCases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(voiceDecisionEvaluationCases.map(item => item.id)).size)
      .toBe(voiceDecisionEvaluationCases.length);
  });

  it('covers every selectable skill and every response class', () => {
    const skills = new Set(voiceDecisionEvaluationCases.flatMap(item => item.expectedSkills));
    expect([...skills].sort()).toEqual([...VOICE_SKILLS].sort());
    const classes = new Set(voiceDecisionEvaluationCases.flatMap(item => item.expectedClasses));
    expect([...classes].sort()).toEqual([
      'direct', 'greeting', 'no_response', 'skill_complex', 'skill_simple',
    ]);
  });

  it('covers each reason for silence, the answers she must still give, and what the owner said on 2026-10-02', () => {
    const quiet = voiceDecisionEvaluationCases.filter(item => !item.shouldRespond);
    for (const category of ['not_addressed', 'backchannel', 'unfinished', 'hold', 'echo'] as const) {
      expect(quiet.filter(item => item.silence === category).length, category).toBeGreaterThanOrEqual(2);
    }
    expect(quiet.length).toBeGreaterThanOrEqual(35);
    expect(voiceDecisionEvaluationCases.filter(item => item.shouldRespond).length).toBeGreaterThanOrEqual(60);
    // Short utterances without a mark, where a "too small to be an utterance" rule would make her mute.
    expect(voiceDecisionEvaluationCases.filter(item => item.shouldRespond && Array.from(item.transcript).length <= 4 && !/[?？。]/u.test(item.transcript)).length).toBeGreaterThanOrEqual(10);
    expect(voiceDecisionEvaluationCases.filter(item => item.production).map(item => item.transcript)).toEqual(expect.arrayContaining([
      '言われた。', 'え?', 'あれ?', 'あれ、ウェブコミに乗っ', '出るの。', 'そっか、ちょっと待ってね。',
      '僕のこと見れる?', 'もちろん、そう、カメラ使っていいよ、自由に。', 'うん、じゃあ部屋を見て。',
    ]));
    expect(voiceDecisionEvaluationCases.filter(item => item.turn?.sheAsked && item.shouldRespond).length).toBeGreaterThanOrEqual(4);
    expect(voiceDecisionEvaluationCases.filter(item => item.turn?.othersPresent).length).toBeGreaterThanOrEqual(6);
  });
});

/** The third tier alone: the local rules with the facts of the moment, and no model. */
async function localTier(item: VoiceDecisionEvaluationCase) {
  return new LocalVoiceDecisionGateway().decide({
    scopeKey: `eval:${item.id}`, transcript: item.transcript, participantMode: 'owner',
    requestedLocation: false, hasFreshLocation: false, turn: { ...ownerCallFacts, ...item.turn },
  });
}

describe('the local rules of silence, measured on the catalog', () => {
  it('answers every utterance that needs an answer, and is wrong only where a model is needed', async () => {
    const rows = await Promise.all(voiceDecisionEvaluationCases.map(async item => ({ item, decision: await localTier(item) })));
    const count = (expected: boolean, actual: boolean) => rows.filter(row => row.item.shouldRespond === expected && row.decision.shouldRespond === actual).length;
    const [answered, missed, spokeWrongly, keptQuiet] = [count(true, true), count(true, false), count(false, true), count(false, false)];
    const precision = answered / (answered + spokeWrongly);
    const recall = answered / (answered + missed);
    if (process.env.SHANNON_PRINT_VOICE_EVAL) {
      console.info(rows.map(({ item, decision }) => [
        item.id, item.transcript, item.shouldRespond ? 'answer' : `silent(${item.silence ?? '-'})`,
        decision.shouldRespond ? 'answer' : `silent(${decision.silence ?? '-'})`, item.shouldRespond === decision.shouldRespond ? 'ok' : 'WRONG',
      ].join(' | ')).join('\n'));
      console.info(JSON.stringify({ cases: rows.length, answered, missed, spokeWrongly, keptQuiet, precision, recall }));
    }
    // She is never made mute: no utterance that needs an answer is left unanswered.
    expect(rows.filter(row => row.item.shouldRespond && !row.decision.shouldRespond).map(row => row.item.id)).toEqual([]);
    expect(recall).toBe(1);
    // Where the rules answer although silence was right, the case says so: it is the models' to judge.
    expect(rows.filter(row => !row.item.shouldRespond && row.decision.shouldRespond).map(row => row.item.id).sort())
      .toEqual(voiceDecisionEvaluationCases.filter(item => item.needsModel).map(item => item.id).sort());
    expect(precision).toBeGreaterThanOrEqual(0.85);
    // 111 utterances: 68 to answer (all answered), 43 to leave (35 left, 8 answered). Precision 68/76, recall 68/68.
    expect({ answered, missed, spokeWrongly, keptQuiet }).toEqual({ answered: 68, missed: 0, spokeWrongly: 8, keptQuiet: 35 });
  });

  it('is silent for the stated reason, and a silent turn costs under a second and no waiting phrase', async () => {
    for (const item of voiceDecisionEvaluationCases.filter(candidate => !candidate.shouldRespond && !candidate.needsModel)) {
      const decision = await localTier(item);
      expect(decision, item.id).toMatchObject({ shouldRespond: false, conversationClass: 'no_response', latencyClass: 'under_1s' });
      if (item.silence) expect(decision.silence, item.id).toBe(item.silence);
    }
  });

  it('with the rules switched off decides as it does without the facts, which is the path from before the rules', async () => {
    const before = await Promise.all(voiceDecisionEvaluationCases.map(item => new LocalVoiceDecisionGateway().decide({
      scopeKey: 'eval', transcript: item.transcript, participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
    })));
    process.env.SHANNON_VOICE_SILENCE_RULES = 'off';
    try {
      const off = await Promise.all(voiceDecisionEvaluationCases.map(item => localTier(item)));
      expect(off).toEqual(before);
      expect(off.filter(decision => !decision.shouldRespond).length).toBe(2);
    } finally {
      delete process.env.SHANNON_VOICE_SILENCE_RULES;
    }
  });
});
