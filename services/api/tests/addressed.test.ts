import { describe, expect, it } from 'vitest';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import {
  ADDRESSED_TIMEOUT_MILLISECONDS, ADDRESSED_WINDOW_MILLISECONDS, AddressedJudge, addressedGate, addressedQuestions, addressedState, fallbackAddressed, followsHer,
  type AddressedInput, type AddressedVerdict,
} from '../src/mind/perception/addressed.js';
import { hasName, nameMatch, normalizedForName } from '../src/mind/perception/addressedName.js';
import { ADDRESSED_CASES, type AddressedCase } from './support/addressedCases.js';

/**
 * 「話しかけられたか」 (owner 2026-10-21). Jev is stood in for here by a fetch that answers from the case's label, so what is measured is
 * the part that is ours: when the question is asked at all, what it is shown, what its answers make of it, and what decides when Jev
 * does not answer. The real Jev's accuracy is measured by `addressedLiveEval.ts` (billable, with `TYPESAFE_API_KEY`).
 */
const speakerOf = (item: AddressedCase) => ({ id: item.speaker ?? 'owner', name: item.speaker ?? 'ライ氏' });
const inputOf = (item: AddressedCase): AddressedInput => ({
  scopeKey: 'owner', transcript: item.transcript, speaker: speakerOf(item), humans: item.humans,
  recent: (item.recent ?? []).map(line => ({ who: line.who, text: line.text, secondsAgo: line.secondsAgo, ...(line.shannon ? { shannon: true as const } : {}) })),
  ...(item.spoke ? { shannon: { spokeAgoMs: item.spoke.secondsAgo * 1000, toSpeaker: item.spoke.toSpeaker, ...(item.spoke.line ? { line: item.spoke.line } : {}) } } : {}),
});

/** A Jev that knows the answer: it reads the utterance (and how long ago she spoke) out of the request and answers from the label. */
function standInJev(options: { calls?: { count: number; bodies: unknown[] }; delayMilliseconds?: number; honest?: boolean } = {}) {
  const fetcher = (async (_url: unknown, init?: { body?: unknown; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body)) as { state: { utterance: string; shannon_spoke_seconds_ago: number | null }; questions: Record<string, unknown> };
    if (options.calls) { options.calls.count += 1; options.calls.bodies.push(body); }
    if (options.delayMilliseconds) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMilliseconds);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      });
    }
    const item = ADDRESSED_CASES.find(candidate => candidate.transcript.slice(0, 400) === body.state.utterance
      && (candidate.spoke ? Math.round(candidate.spoke.secondsAgo) : null) === body.state.shannon_spoke_seconds_ago);
    const to = item?.to ?? false;
    const target = to ? 'shannon' : item?.group === 'about' ? 'about_shannon' : item?.group === 'self' ? 'self' : 'other_person';
    return new Response(JSON.stringify({ answers: {
      addressed_to_shannon: { type: 'noul', noul: to ? 0.93 : 0.06 }, target: { type: 'choice', choice: target },
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return fetcher;
}

function judgeWith(fetcher: typeof fetch | null, traces?: JevChoiceTrace[], timeoutMilliseconds = ADDRESSED_TIMEOUT_MILLISECONDS) {
  const chooser = fetcher
    ? new JevChooser(new JevChoiceClient({ apiKey: 'test-key', fetcher }), { usdPerCall: null, cacheMilliseconds: 0, ...(traces ? { trace: (_scope: string, trace: JevChoiceTrace) => { traces.push(trace); } } : {}) })
    : null;
  return new AddressedJudge({ chooser, timeoutMilliseconds });
}

describe('her name in a transcript', () => {
  it('is normalised: katakana, hiragana, long vowels, spaces and marks do not matter', () => {
    expect(normalizedForName('ねぇ、シャノーン！')).toBe('ねぇしゃのん');
    expect(normalizedForName('Ｓｈａｎｎｏｎ ちゃん')).toBe('shannonちゃん');
    expect(hasName('シャノン')).toBe(true);
    expect(hasName('しゃのん')).toBe(true);
    expect(hasName('Shannon, are you there')).toBe(true);
    expect(hasName('シャ ノン')).toBe(true);
  });

  it('knows the mishearings (しゃの, シャノ, 社の, シャロン) as weak, and keeps ordinary words out', () => {
    for (const text of ['シャノ、おはよう', 'しゃの、聞いて', '社の、これ見て', 'シャロン、いる？', 'ちゃのん、きて']) expect(nameMatch(text)?.tier, text).toBe('weak');
    for (const text of ['会社の人が休み', '今日は天気がいい', 'ジャズの練習', 'おはよう', '本社のビル']) expect(hasName(text), text).toBe(false);
    expect(nameMatch('シャノンちゃん')?.tier).toBe('strong');
  });

  it('reads where it stands: the head, the end, a lone call, the topic of a sentence', () => {
    expect(nameMatch('ねえシャノン、今日の天気は')).toMatchObject({ atHead: true, atEnd: false, bare: false, called: true });
    expect(nameMatch('今日どうだった？シャノン')).toMatchObject({ atHead: false, atEnd: true });
    expect(nameMatch('おーいシャノンちゃん')).toMatchObject({ bare: true });
    expect(nameMatch('シャノン')).toMatchObject({ bare: true });
    expect(nameMatch('シャノンってさ、昨日')).toMatchObject({ atHead: true, topic: true, called: false });
    expect(nameMatch('昨日シャノンがさ')).toMatchObject({ atHead: false, atEnd: false, topic: true });
  });
});

describe('when Jev is asked at all', () => {
  it('asks only for her name or inside the follow-up window, from the person she was speaking to', () => {
    const none = { scopeKey: 'owner', speaker: { id: 'a', name: 'ア' }, humans: 1 };
    expect(addressedGate({ ...none, transcript: '今日は疲れたなあ' })).toMatchObject({ kind: 'quiet', reason: 'no_name' });
    expect(addressedGate({ ...none, transcript: 'シャノン、いる？' })).toMatchObject({ kind: 'ask' });
    expect(addressedGate({ ...none, transcript: 'シャノン' })).toMatchObject({ kind: 'yes', reason: 'bare_call' });
    // A weak mishearing alone is never taken as a bare call: a model must say so.
    expect(addressedGate({ ...none, transcript: 'シャノ' })).toMatchObject({ kind: 'ask' });
    const spoke = (secondsAgo: number, toSpeaker: boolean | null) => ({ ...none, transcript: 'それでどうなったの', shannon: { spokeAgoMs: secondsAgo * 1000, toSpeaker } });
    expect(addressedGate(spoke(5, true))).toMatchObject({ kind: 'ask', follows: true });
    expect(addressedGate(spoke(5, null))).toMatchObject({ kind: 'ask', follows: true });
    expect(addressedGate(spoke(19.9, true))).toMatchObject({ kind: 'ask' });
    expect(addressedGate(spoke(20.1, true))).toMatchObject({ kind: 'quiet' });
    expect(addressedGate(spoke(5, false))).toMatchObject({ kind: 'quiet' });
    expect(followsHer({ ...none, transcript: 'x', shannon: { spokeAgoMs: 0, toSpeaker: true } })).toBe(true);
    expect(followsHer({ ...none, transcript: 'x', shannon: { spokeAgoMs: null, toSpeaker: true } })).toBe(false);
    expect(ADDRESSED_WINDOW_MILLISECONDS).toBe(20_000);
  });

  it('shows Jev the words, who is there and how long ago she spoke, and nothing of the speaker beyond a name', () => {
    const state = addressedState({
      scopeKey: 'owner', transcript: 'ねえシャノン、続きは？', speaker: { id: 'u1', name: 'ユウ' }, humans: 3,
      recent: [{ who: 'ミキ', text: 'さっきのボスやばかった', secondsAgo: 30 }, { who: 'シャノン', shannon: true, text: '次はネザーだね。', secondsAgo: 7.4 }],
      shannon: { spokeAgoMs: 7_400, toSpeaker: true, line: '次はネザーだね。' },
    }, nameMatch('ねえシャノン、続きは？'), true);
    expect(state).toMatchObject({
      utterance: 'ねえシャノン、続きは？', speaker: 'ユウ', people_present: 3, alone_with_shannon: false, name_in_utterance: 'exact',
      shannon_spoke_seconds_ago: 7, shannon_last_spoke_to_this_speaker: true, follows_her_last_words: true,
    });
    expect(state.recent_talk).toEqual([{ who: 'ミキ', text: 'さっきのボスやばかった', seconds_ago: 30 }, { who: 'シャノン', text: '次はネザーだね。', seconds_ago: 7 }]);
    expect(JSON.stringify(state)).not.toContain('u1');
    const questions = addressedQuestions();
    expect(Object.keys(questions)).toEqual(['addressed_to_shannon', 'target']);
    expect(Object.keys(questions.target!.criteria)).toEqual(['shannon', 'about_shannon', 'other_person', 'self', 'unclear']);
  });
});

describe('the judgement over the cases (Jev stood in for by the label)', () => {
  it('answers every case as labelled and asks Jev only where the gate says it should', async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const traces: JevChoiceTrace[] = [];
    const judge = judgeWith(standInJev({ calls }), traces);
    const wrong: string[] = [];
    const verdicts = new Map<string, AddressedVerdict>();
    for (const item of ADDRESSED_CASES) {
      const verdict = await judge.judge(inputOf(item));
      verdicts.set(item.id, verdict);
      if (verdict.addressed !== item.to) wrong.push(`${item.id} (said to her: ${item.to}, got ${verdict.addressed} by ${verdict.source})`);
      if (verdict.asked !== item.ask) wrong.push(`${item.id} (asked ${verdict.asked}, expected ${item.ask})`);
    }
    const asked = [...verdicts.values()].filter(verdict => verdict.asked).length;
    // eslint-disable-next-line no-console
    console.log(`addressed cases: ${ADDRESSED_CASES.length}, wrong ${wrong.length}, Jev asked ${asked} of ${ADDRESSED_CASES.length} (${Math.round((asked / ADDRESSED_CASES.length) * 100)}%), calls ${calls.count}`);
    expect(wrong).toEqual([]);
    expect(calls.count).toBe(asked);
    // One content-free trace per question: the decision's answers and its source, never the words.
    expect(traces).toHaveLength(asked);
    expect(traces[0]).toMatchObject({ surface: 'voice', decision: 'addressed', outcome: 'ok' });
    expect(JSON.stringify(traces)).not.toContain('シャノン');
  });

  it('puts the words, the room and the two questions into the call', async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const judge = judgeWith(standInJev({ calls }));
    const item = ADDRESSED_CASES.find(candidate => candidate.id === 'follow-meaning')!;
    await judge.judge(inputOf(item));
    const body = calls.bodies[0] as { model: string; state: Record<string, unknown>; questions: Record<string, { type: string }> };
    expect(body.model).toBe('jev-latest');
    expect(body.state).toMatchObject({ utterance: item.transcript, alone_with_shannon: true, shannon_spoke_seconds_ago: 5, follows_her_last_words: true });
    expect(Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key, question.type]))).toEqual({ addressed_to_shannon: 'noul', target: 'choice' });
  });

  it('needs both answers to agree for a yes: the choice says her and the probability backs it', async () => {
    const answer = (noul: number, choice: string) => (async () => new Response(JSON.stringify({ answers: {
      addressed_to_shannon: { type: 'noul', noul }, target: { type: 'choice', choice },
    } }))) as unknown as typeof fetch;
    const item = ADDRESSED_CASES.find(candidate => candidate.id === 'call-weather')!;
    expect((await judgeWith(answer(0.9, 'shannon')).judge(inputOf(item))).addressed).toBe(true);
    expect((await judgeWith(answer(0.2, 'shannon')).judge(inputOf(item))).addressed).toBe(false);
    expect((await judgeWith(answer(0.95, 'about_shannon')).judge(inputOf(item)))).toMatchObject({ addressed: false, reason: 'about_her', source: 'jev' });
    expect((await judgeWith(answer(0.95, 'other_person')).judge(inputOf(item)))).toMatchObject({ addressed: false, reason: 'not_to_her' });
    expect((await judgeWith(answer(0.8, 'unclear')).judge(inputOf(item))).addressed).toBe(true);
    expect((await judgeWith(answer(0.5, 'unclear')).judge(inputOf(item))).addressed).toBe(false);
  });
});

describe('when Jev does not answer', () => {
  const item = (id: string) => ADDRESSED_CASES.find(candidate => candidate.id === id)!;

  it('decides by the local rules after the timeout, and says so', async () => {
    const judge = judgeWith(standInJev({ delayMilliseconds: 5_000 }), undefined, 60);
    const started = performance.now();
    const verdict = await judge.judge(inputOf(item('call-weather')));
    const elapsed = performance.now() - started;
    expect(verdict).toMatchObject({ addressed: true, reason: 'named', source: 'fallback', asked: true });
    expect(elapsed).toBeLessThan(400);
    const about = await judge.judge(inputOf(item('about-topic')));
    expect(about).toMatchObject({ addressed: false, source: 'fallback' });
  });

  it('decides by the local rules for an error, an unusable answer, or no Jev key at all', async () => {
    const broken = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const empty = (async () => new Response(JSON.stringify({ answers: {} }))) as unknown as typeof fetch;
    for (const fetcher of [broken, empty, null]) {
      const judge = judgeWith(fetcher);
      expect(await judge.judge(inputOf(item('call-weather')))).toMatchObject({ addressed: true, source: 'fallback' });
      expect(await judge.judge(inputOf(item('about-voice')))).toMatchObject({ addressed: false, source: 'fallback' });
    }
    expect((await judgeWith(null).judge(inputOf(item('call-weather')))).asked).toBe(false);
  });

  it('lets a call through by its form and not a name in the middle of a sentence', () => {
    const base = { scopeKey: 'owner', speaker: { id: 'a', name: 'ア' }, humans: 3 };
    const decide = (transcript: string, humans = 3) => {
      const input = { ...base, humans, transcript };
      return fallbackAddressed(input, nameMatch(transcript), false).addressed;
    };
    expect(decide('シャノン、おはよう')).toBe(true);
    expect(decide('ねえシャノン今日の天気')).toBe(true);
    expect(decide('お願いシャノン')).toBe(true);
    expect(decide('昨日シャノンがさ')).toBe(false);
    expect(decide('あとでシャノンに聞こう')).toBe(false);
    expect(decide('シャノンはまだ寝てるのかな')).toBe(false);
    expect(decide('シャノンは何が好きなの？', 1)).toBe(true);
    // A likely mishearing is a call only in the form of one: at the head, then a pause or a mark.
    expect(decide('シャノ、おはよう')).toBe(true);
    expect(decide('社の、これ見て')).toBe(true);
    expect(decide('シャノおはよう')).toBe(false);
    expect(decide('昨日シャノ、ってなんだっけって話した')).toBe(false);
    expect(decide('シャノワールっていうカフェ、いいよね')).toBe(false);
  });

  it('answers the follow-up of a lone speaker, and in a room only a question, a request, a thanks or a short reaction', () => {
    const base = { scopeKey: 'owner', speaker: { id: 'a', name: 'ア' } };
    const decide = (transcript: string, humans: number) => fallbackAddressed({ ...base, humans, transcript }, null, true).addressed;
    expect(decide('あー疲れた、今日は早く寝よう', 1)).toBe(true);
    expect(decide('それってどういう意味？', 3)).toBe(true);
    expect(decide('ありがとう、助かった', 3)).toBe(true);
    expect(decide('なるほどね', 3)).toBe(true);
    expect(decide('昨日の夜にさ、みんなで集まってマイクラをやっていたときに急にサーバーが落ちてしまって大変だったんだよね', 3)).toBe(false);
  });
});

/** The local rules alone over the whole set: a lower bound for the case where Jev is down, with its misses named. */
describe('the local rules alone over the cases', () => {
  it('get most of them right, and the misses are the ones that need a reading of the sentence', async () => {
    const judge = judgeWith(null);
    const wrong: string[] = [];
    for (const item of ADDRESSED_CASES) {
      const verdict = await judge.judge(inputOf(item));
      if (verdict.addressed !== item.to) wrong.push(item.id);
    }
    const accuracy = (ADDRESSED_CASES.length - wrong.length) / ADDRESSED_CASES.length;
    // eslint-disable-next-line no-console
    console.log(`addressed local rules only: ${ADDRESSED_CASES.length - wrong.length}/${ADDRESSED_CASES.length} right (${Math.round(accuracy * 100)}%); misses: ${wrong.join(', ')}`);
    expect(accuracy).toBeGreaterThanOrEqual(0.7);
  });
});
