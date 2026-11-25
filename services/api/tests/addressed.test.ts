import { describe, expect, it } from 'vitest';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../src/infra/models/jev/jevChoice.js';
import {
  ADDRESSED_TIMEOUT_MILLISECONDS, ADDRESSED_WINDOW_MILLISECONDS, AddressedJudge, addressedGate, addressedQuestions, addressedState, fallbackAddressed, followsHer,
  parsedAddressed, type AddressedInput, type AddressedVerdict,
} from '../src/mind/perception/addressed.js';
import { hasName, nameMatch, normalizedForName } from '../src/mind/perception/addressedName.js';
import { ADDRESSED_CASES, type AddressedCase } from './support/addressedCases.js';

/**
 * 「話しかけられたか」 (owner 2026-10-21). Jev is stood in for here by a fetch that answers from the case's label, so what is measured is
 * the part that is ours: when the question is asked at all, what it is shown, what its answers make of it, and what decides when Jev
 * does not answer. The real Jev's accuracy is measured by `addressedLiveEval.ts` (billable, with `TYPESAFE_API_KEY`).
 */
const speakerOf = (item: AddressedCase) => ({ id: item.speaker ?? 'owner', name: item.speaker ?? 'ライ' });
const inputOf = (item: AddressedCase): AddressedInput => ({
  scopeKey: 'owner', transcript: item.transcript, speaker: speakerOf(item), humans: item.humans,
  recent: (item.recent ?? []).map(line => ({ who: line.who, text: line.text, secondsAgo: line.secondsAgo, ...(line.shannon ? { shannon: true as const } : {}) })),
  ...(item.spoke ? { shannon: { spokeAgoMs: item.spoke.secondsAgo * 1000, toSpeaker: item.spoke.toSpeaker, ...(item.spoke.line ? { line: item.spoke.line } : {}),
    ...(item.spoke.asked ? { asked: true } : {}) } } : {}),
  ...(item.work ? { work: item.work } : {}),
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
      about_the_job: { type: 'noul', noul: to ? 0.93 : 0.05 }, answers_her_question: { type: 'noul', noul: to ? 0.93 : 0.05 }, reply_needed: { type: 'noul', noul: to ? 0.95 : 0.05 },
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
    expect(Object.keys(questions)).toEqual(['addressed_to_shannon', 'target', 'about_the_job', 'answers_her_question', 'introduces_her', 'reply_needed']);
    expect(Object.keys(questions.target!.criteria)).toEqual(['shannon', 'about_shannon', 'other_person', 'self', 'unclear']);
    // Being introduced to the people present is to her (she greets them back); an announcement or a remark about her is not.
    expect(questions.addressed_to_shannon!.instructions).toContain('presenting Shannon to the people who are there');
    expect(questions.addressed_to_shannon!.instructions).toContain('It is not an introduction, and not to her, when the speaker is only talking about her');
    expect(questions.reply_needed!.instructions).toContain('is itself the invitation');
    expect(questions.reply_needed!.instructions).toContain('A reason or an occasion written in front of the request is not an announcement');
    expect(questions.target!.criteria.about_shannon).toContain('that one is to her');
    expect(questions.introduces_her!.instructions).toContain('presenting, showing or announcing Shannon to the people who are there');
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
    expect(Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key, question.type])))
      .toEqual({ addressed_to_shannon: 'noul', target: 'choice', about_the_job: 'noul', answers_her_question: 'noul', introduces_her: 'noul', reply_needed: 'noul' });
  });

  it('needs both answers to agree for a yes: the choice says her and the probability backs it', async () => {
    const answer = (noul: number, choice: string, needsReply = 0.95) => (async () => new Response(JSON.stringify({ answers: {
      addressed_to_shannon: { type: 'noul', noul }, target: { type: 'choice', choice },
      reply_needed: { type: 'noul', noul: needsReply },
    } }))) as unknown as typeof fetch;
    const item = ADDRESSED_CASES.find(candidate => candidate.id === 'call-weather')!;
    expect((await judgeWith(answer(0.9, 'shannon')).judge(inputOf(item))).addressed).toBe(true);
    expect((await judgeWith(answer(0.2, 'shannon')).judge(inputOf(item))).addressed).toBe(false);
    expect((await judgeWith(answer(0.95, 'about_shannon')).judge(inputOf(item)))).toMatchObject({ addressed: false, reason: 'about_her', source: 'jev' });
    expect((await judgeWith(answer(0.95, 'other_person')).judge(inputOf(item)))).toMatchObject({ addressed: false, reason: 'not_to_her' });
    expect((await judgeWith(answer(0.8, 'unclear')).judge(inputOf(item))).addressed).toBe(false);
    expect((await judgeWith(answer(0.5, 'unclear')).judge(inputOf(item))).addressed).toBe(false);
    expect(await judgeWith(answer(0.95, 'shannon', 0.2)).judge(inputOf(item)))
      .toMatchObject({ addressed: false, reason: 'no_reply_needed' });
    expect((await judgeWith(answer(0.6, 'shannon')).judge(inputOf(item))).addressed).toBe(false);
  });

  it('reads a presentation said in front of the others as to her, and marks it for the reply (an answer about her is never turned)', async () => {
    const answer = (choice: string, presenting: number | null, noul = 0.9, needsReply = 0.9) => (async () => new Response(JSON.stringify({ answers: {
      addressed_to_shannon: { type: 'noul', noul }, target: { type: 'choice', choice },
      ...(presenting === null ? {} : { introduces_her: { type: 'noul', noul: presenting } }), reply_needed: { type: 'noul', noul: needsReply },
    } }))) as unknown as typeof fetch;
    const item = ADDRESSED_CASES.find(candidate => candidate.id === 'call-weather')!;
    // Only the Discord call reads a presentation (`presentation`): any other entrance keeps its own reading.
    const inCall: AddressedInput = { ...inputOf(item), presentation: true };
    expect(await judgeWith(answer('shannon', 0.95)).judge(inCall)).toMatchObject({ addressed: true, introduced: true });
    expect(await judgeWith(answer('other_person', 0.92)).judge(inCall)).toMatchObject({ addressed: true, reason: 'named', introduced: true });
    expect((await judgeWith(answer('other_person', 0.5)).judge(inCall)).addressed).toBe(false);
    expect((await judgeWith(answer('other_person', null)).judge(inCall)).addressed).toBe(false);
    expect((await judgeWith(answer('about_shannon', 0.99)).judge(inCall)).addressed).toBe(false);
    expect((await judgeWith(answer('self', 0.99)).judge(inCall)).addressed).toBe(false);
    expect((await judgeWith(answer('other_person', 0.95, 0.4)).judge(inCall)).addressed).toBe(false);
    // Answered, but not a presentation (a question to her): no mark; a missing answer is no mark and no failure.
    expect(await judgeWith(answer('shannon', 0.1)).judge(inCall)).toMatchObject({ addressed: true });
    expect((await judgeWith(answer('shannon', 0.1)).judge(inCall)).introduced).toBeUndefined();
    expect(await judgeWith(answer('shannon', null)).judge(inCall)).toMatchObject({ addressed: true });
    expect((await judgeWith(answer('shannon', null)).judge(inCall)).introduced).toBeUndefined();
    expect((await judgeWith(answer('other_person', 0.95)).judge(inputOf(item))).addressed).toBe(false);
    expect((await judgeWith(answer('shannon', 0.95)).judge(inputOf(item))).introduced).toBeUndefined();
  });

  it('名前なしの質問も残し、返事不要・不明な相手・弱い確信では会話中も黙る', async () => {
    const input: AddressedInput = { scopeKey: 'owner', speaker: { id: 'owner', name: 'ライ' }, humans: 1,
      owner: true, transcript: '明日の予定を教えてもらえる？' };
    const answer = (target: string, directed: number, needed: number) => (async () => new Response(JSON.stringify({ answers: {
      addressed_to_shannon: { type: 'noul', noul: directed }, target: { type: 'choice', choice: target },
      reply_needed: { type: 'noul', noul: needed },
    } }))) as unknown as typeof fetch;
    expect(await judgeWith(answer('shannon', 0.95, 0.95)).judge(input))
      .toMatchObject({ addressed: true, reason: 'asked_alone', source: 'jev' });
    expect((await judgeWith(answer('shannon', 0.7, 0.95)).judge(input)).addressed).toBe(false);
    const following = { ...input, transcript: '今日は何の日だっけ、いや違うか。',
      shannon: { spokeAgoMs: 1000, toSpeaker: true, line: 'ほかに聞きたいことはありますか？' } };
    expect(await judgeWith(answer('shannon', 0.95, 0.1)).judge(following))
      .toMatchObject({ addressed: false, reason: 'no_reply_needed' });
    expect((await judgeWith(answer('unclear', 0.99, 0.99)).judge(following)).addressed).toBe(false);
    expect((await judgeWith(null).judge(following)).addressed).toBe(false);
  });
});

describe('when Jev does not answer', () => {
  const item = (id: string) => ADDRESSED_CASES.find(candidate => candidate.id === id)!;

  it('decides by the local rules after the timeout, and says so', async () => {
    const judge = judgeWith(standInJev({ delayMilliseconds: 5_000 }), undefined, 60);
    const started = performance.now();
    const verdict = await judge.judge(inputOf(item('call-weather')));
    const elapsed = performance.now() - started;
    expect(verdict).toMatchObject({ addressed: false, reason: 'unconfirmed', source: 'fallback', asked: true });
    expect(elapsed).toBeLessThan(400);
    const about = await judge.judge(inputOf(item('about-topic')));
    expect(about).toMatchObject({ addressed: false, source: 'fallback' });
  });

  it('decides by the local rules for an error, an unusable answer, or no Jev key at all', async () => {
    const broken = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const empty = (async () => new Response(JSON.stringify({ answers: {} }))) as unknown as typeof fetch;
    for (const fetcher of [broken, empty, null]) {
      const judge = judgeWith(fetcher);
      expect(await judge.judge(inputOf(item('call-weather')))).toMatchObject({ addressed: false, source: 'fallback' });
      expect(await judge.judge(inputOf(item('about-voice')))).toMatchObject({ addressed: false, source: 'fallback' });
    }
    expect((await judgeWith(null).judge(inputOf(item('call-weather')))).asked).toBe(false);
  });

  it('Jevが使えない間は、名前があっても未確認の発話を通さない', () => {
    const base = { scopeKey: 'owner', speaker: { id: 'a', name: 'ア' }, humans: 1 };
    for (const transcript of ['シャノン、おはよう', '昨日シャノンがさ', '社の、これ見て', '今って何の日だっけ、違うか']) {
      const input = { ...base, transcript };
      expect(fallbackAddressed(input, nameMatch(transcript), true)).toEqual({ addressed: false, reason: 'unconfirmed' });
    }
  });

  it('モデルが使えない間は、一人の続き・質問・短い反応でも名前なしでは返事しない', () => {
    const base = { scopeKey: 'owner', speaker: { id: 'a', name: 'ア' } };
    const decide = (transcript: string, humans: number) => fallbackAddressed({ ...base, humans, transcript }, null, true).addressed;
    expect(decide('あー疲れた、今日は早く寝よう', 1)).toBe(false);
    expect(decide('それってどういう意味？', 3)).toBe(false);
    expect(decide('ありがとう、助かった', 3)).toBe(false);
    expect(decide('なるほどね', 3)).toBe(false);
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
    expect(ADDRESSED_CASES.filter(item => !item.to && !item.ask).every(item => !wrong.includes(item.id))).toBe(true);
    // Where Jev alone may say yes, silence is the local answer; after her own question (`answering`) the local answer is yes, so the chat in that window is the miss.
    const answering = (item: AddressedCase) => item.spoke?.asked === true;
    expect(ADDRESSED_CASES.filter(item => item.ask && !answering(item)).every(item => wrong.includes(item.id) === item.to)).toBe(true);
    expect(ADDRESSED_CASES.filter(item => item.ask && answering(item)).every(item => wrong.includes(item.id) === !item.to)).toBe(true);
  });
});

describe('stop words (止めて, 待って, ストップ...) without her name (owner 2026-10-21)', () => {
  const base = { scopeKey: 'owner', speaker: { id: 'o', name: 'ライ' }, humans: 1 };
  it('pass from the owner while she speaks or her body works, without asking Jev', async () => {
    const calls = { count: 0, bodies: [] as unknown[] };
    const judge = judgeWith(standInJev({ calls }));
    for (const transcript of ['止めて', 'ちょっと待って', 'ストップ！', 'やめて、危ない', '静かにして', 'とまって']) {
      expect(await judge.judge({ ...base, transcript, owner: true, shannonSpeaking: true }), transcript).toMatchObject({ addressed: true, reason: 'stop', source: 'rule', asked: false });
      expect(await judge.judge({ ...base, transcript, owner: true, bodyRunning: true }), transcript).toMatchObject({ addressed: true, reason: 'stop' });
    }
    expect(calls.count).toBe(0);
  });

  it('do not pass for a friend, when neither she speaks nor her body works, or for other words', async () => {
    const judge = judgeWith(standInJev());
    expect(await judge.judge({ ...base, transcript: '止めて', owner: false, shannonSpeaking: true, bodyRunning: true })).toMatchObject({ addressed: false, reason: 'no_name' });
    expect(await judge.judge({ ...base, transcript: '止めて', owner: true })).toMatchObject({ addressed: false, reason: 'no_name' });
    expect(await judge.judge({ ...base, transcript: '今日は疲れたな', owner: true, shannonSpeaking: true, bodyRunning: true })).toMatchObject({ addressed: false });
  });
});

describe('talk about the job inside the window after a line of her own commentary', () => {
  const answers = (to: number, job: number, target = 'other_person', reply = 0.1) => ({ addressed_to_shannon: { type: 'noul', noul: to }, target: { type: 'choice', choice: target }, about_the_job: { type: 'noul', noul: job }, reply_needed: { type: 'noul', noul: reply } });
  const spoke: AddressedInput = { scopeKey: 'owner', transcript: '牛乳はバケツが 3 つあれば足りるよ', speaker: { id: 'a', name: 'ライ' }, humans: 2, recent: [], owner: true,
    shannon: { spokeAgoMs: 2_000, toSpeaker: null, line: 'よーし、まずは小麦の種を集めちゃおっと。' }, work: { goal: 'ケーキを1個作る', list: [] } };
  it('marks the gate as working when she works and the words carry no name', () => {
    expect(addressedGate(spoke)).toMatchObject({ kind: 'ask', follows: true, working: true });
    expect(addressedGate({ ...spoke, work: undefined })).not.toHaveProperty('working');
    expect(addressedGate({ ...spoke, transcript: 'シャノン、牛乳はバケツが 3 つあれば足りるよ' })).not.toHaveProperty('working');
  });
  it('takes a tip about the job when the general question says no, and keeps the chat between people out', () => {
    expect(parsedAddressed(answers(0.27, 0.46), null, false, true)).toMatchObject({ addressed: true, reason: 'asked_while_working' });
    expect(parsedAddressed(answers(0.07, 0.02), null, false, true)).toMatchObject({ addressed: false });
  });
  it('changes nothing for her name, outside a job, or when the general question already says yes', () => {
    expect(parsedAddressed(answers(0.27, 0.9), null, false, false)).toMatchObject({ addressed: false });
    expect(parsedAddressed(answers(0.27, 0.9), { bare: false, tier: 'strong' } as never, false, true)).toMatchObject({ addressed: false });
    expect(parsedAddressed(answers(0.95, 0.1, 'shannon', 0.95), null, false, true)).toMatchObject({ addressed: true, reason: 'continuation' });
  });
});

describe('talk about the job inside the window of a question she asked', () => {
  const answers = (answer: number, job: number) => ({ answers_her_question: { type: 'noul', noul: answer }, about_the_job: { type: 'noul', noul: job } });
  it('is taken while she works when it is about the job, though it answers nothing she asked', () => {
    expect(parsedAddressed(answers(0.1, 0.95), null, 'answering', true)).toMatchObject({ addressed: true, reason: 'asked_while_working' });
    expect(parsedAddressed(answers(0.9, 0.05), null, 'answering', true)).toMatchObject({ addressed: true, reason: 'answer_to_question' });
    expect(parsedAddressed(answers(0.1, 0.1), null, 'answering', true)).toMatchObject({ addressed: false, reason: 'no_name' });
  });
  it('is decided by the answer alone when she is not working', () => {
    expect(parsedAddressed(answers(0.1, 0.95), null, 'answering', false)).toMatchObject({ addressed: false, reason: 'no_name' });
    expect(parsedAddressed(answers(0.9, 0.05), null, 'answering')).toMatchObject({ addressed: true });
  });
  it('marks the gate as working only when a job is under way', () => {
    const input: AddressedInput = { scopeKey: 'owner', transcript: '小麦は骨粉で早く成長させよう', speaker: { id: 'a', name: 'ユウ' }, humans: 3, recent: [],
      shannon: { spokeAgoMs: 11_000, toSpeaker: null, line: 'えっと、次は小麦の種がいるのかな？', asked: true } };
    expect(addressedGate(input)).toMatchObject({ kind: 'ask', unnamed: 'answering' });
    expect(addressedGate(input)).not.toHaveProperty('working');
    expect(addressedGate({ ...input, work: { goal: 'ケーキを1個作る', list: [] } })).toMatchObject({ kind: 'ask', unnamed: 'answering', working: true });
  });
});
