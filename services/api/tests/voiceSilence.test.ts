import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { InMemoryOrganizeStore } from '../src/organize.js';
import {
  JevVoiceDecisionGateway, LocalVoiceDecisionGateway, OpenAIVoiceDecisionGateway, VOICE_SKILLS,
  type VoiceDecisionGateway, type VoiceDecisionInput, type VoiceTurnDecision,
} from '../src/voiceDecision.js';
import type { VoiceTurnFacts } from '../src/voiceDecisionContract.js';
import {
  VOICE_REPLY_DECISION_LINES, notHisWordsToHer, ownerTurnVerdict, ownerVoiceTurnFacts, settleOwnerVoiceTurn, voiceSilenceRules,
} from '../src/voiceSilence.js';

const START = '2026-10-02T09:00:00.000Z';
const alone: VoiceTurnFacts = { sheAsked: false, followsShannon: false, othersPresent: false, source: 'speech' };
const asked: VoiceTurnFacts = { ...alone, sheAsked: true, followsShannon: true, secondsSinceShannon: 4, shannonLastLine: '夜ごはんは何にしますか？' };
const withOthers: VoiceTurnFacts = { ...alone, othersPresent: true };

afterEach(() => vi.unstubAllEnvs());

describe('the local rules, one category at a time', () => {
  const quiet = (transcript: string, facts: VoiceTurnFacts = alone) => {
    const verdict = ownerTurnVerdict(transcript, facts);
    return verdict && !verdict.respond ? verdict.category : verdict ? `answer:${verdict.reason}` : null;
  };

  it('(a) is silent for self-talk and for words said to someone else or to the computer', () => {
    for (const transcript of ['よいしょ。', 'えーっと、なんだっけ。', 'あれ、おかしいな。', 'なんでだろう。', 'はーい、今行く。', 'もしもし、お世話になっております。', 'あー、固まった。', 'まあいいか。']) {
      expect(quiet(transcript), transcript).toBe('not_addressed');
    }
    // After her own question the same words answer her.
    for (const transcript of ['はーい', 'はいはーい', 'まあいいや', 'まあいいか', '今行く', 'どこだっけ']) {
      expect(quiet(transcript, asked), transcript).toBe('answer:answers_her_question');
    }
    // Alone with her, 「もしもし」 is a greeting to her; with someone else there it may be a phone.
    for (const transcript of ['もしもし', 'もしもし？', 'あ、もしもし。']) {
      expect(quiet(transcript), transcript).toBe('answer:greeting');
      expect(quiet(transcript, withOthers), transcript).toBe('not_addressed');
    }
    // Words that may as well be a request to her are not judged here.
    for (const transcript of ['動いて。', '落ちた。', '重いな。', 'なにこれ。']) expect(quiet(transcript), transcript).not.toBe('not_addressed');
    // The same words with her name, or as part of a request, are for her.
    expect(quiet('シャノン、なんでだろう。')).toBe('answer:named');
    expect(quiet('なんでだろう、教えて。')).toBe('answer:question');
  });

  it('(b) is silent for a backchannel or filler, and answers the same word after her own question', () => {
    for (const transcript of ['うん', 'そっか。', 'あれ?', 'え?', 'なるほど', 'へー、そうなんだ。', 'ああ、はいはい。', 'たしかに。', 'ん?', 'わかった。']) {
      expect(quiet(transcript), transcript).toBe('backchannel');
      expect(quiet(transcript, asked), transcript).toBe('answer:answers_her_question');
    }
    expect(quiet('カレーかな。', asked)).toBe('answer:answers_her_question');
  });

  it('(c) waits for the rest of an utterance that is cut, and does not take a short one for a fragment', () => {
    for (const transcript of ['あれ、ウェブコミに乗っ', '明日の会議の資料を', '昨日さ、会社で、', 'お茶を。', 'それっていうのは、つまり、']) {
      expect(quiet(transcript), transcript).toBe('unfinished');
    }
    // Short is not unfinished. These are the models' to judge, and the local tier answers them.
    for (const transcript of [
      '行こう', 'やろう', '次いこう', 'もう一回', '続き', '詳しく', '最初から', '大丈夫', 'いいよ', 'いらない', 'もういい', 'いや', 'ううん', 'いいえ', 'そう', 'そうそう',
      'そう思う', '知らない', 'たぶん', 'まだ', 'もっと', '任せる', 'あとで', '一番', '2番', '赤', '東京', '30分', 'ニュース', 'できる', '聞こえる', '起きてる', 'ほんと',
      '元気', 'だるい', 'ひま', 'カレー', '天気は', '今日の予定は', '他には', '理由は', '次は', '言われた。', '出るの。', '今日は', '本当に', '自由に',
    ]) expect(quiet(transcript), transcript).toBeNull();
    // A particle that can close a sentence is a cut only when nothing closes the segment.
    expect(quiet('昨日の夜の話なんだけどさ。')).toBeNull();
    expect(quiet('昨日の夜の話なんだけどさ')).toBe('unfinished');
    for (const transcript of ['お願いがあるんですが', 'ちょっと聞きたいんだが', 'ラーメンとか', '映画とか']) expect(quiet(transcript), transcript).toBeNull();
  });

  it('(d) says nothing to "wait a moment", and answers when it is an objection', () => {
    for (const transcript of ['ちょっと待って。', 'そっか、ちょっと待ってね。', 'あ、ごめん、ちょっと待ってて。', '少々お待ちください。', '待って待って。']) {
      expect(quiet(transcript), transcript).toBe('hold');
      expect(quiet(transcript, asked), transcript).toBe('hold');
    }
    expect(quiet('ちょっと待って、それは違うと思う。')).toBeNull();
  });

  it('(e) is silent for noise and for her own words coming back, but not when he repeats them as a question', () => {
    const after: VoiceTurnFacts = { ...alone, followsShannon: true, secondsSinceShannon: 3, shannonLastLine: '明日は雨が降るみたいです。傘を忘れないでくださいね。' };
    expect(quiet('。')).toBe('echo');
    expect(quiet('傘を忘れないでくださいね', after)).toBe('echo');
    expect(quiet('明日は雨が降るみたいです', after)).toBe('echo');
    // Not her line any more once time has passed, once he has spoken since, or when its time is not known.
    expect(quiet('明日は雨が降るみたいです', { ...after, secondsSinceShannon: 600 })).toBeNull();
    expect(quiet('明日は雨が降るみたいです', { ...after, followsShannon: false })).toBeNull();
    expect(quiet('明日は雨が降るみたいです', { ...after, secondsSinceShannon: undefined })).toBeNull();
    expect(quiet('明日は雨が降る?', after)).toBe('answer:question');
    // A short quote of her is his own sentence, and after her question quoting her is how he answers.
    expect(quiet('傘を忘れないで', after)).toBe('answer:request');
    const choice: VoiceTurnFacts = { ...after, sheAsked: true, shannonLastLine: 'コーヒーにしますか、それとも紅茶にしますか？' };
    expect(quiet('紅茶にします', choice)).toBe('answer:answers_her_question');
    expect(quiet('それとも紅茶にしますか', choice)).toBe('answer:answers_her_question');
  });

  it('reads a long or repetitive utterance in no time', () => {
    const started = performance.now();
    for (const transcript of [`${'あ'.repeat(34)}x`, `${'うん'.repeat(34)}だ`, `${'え'.repeat(34)}と思う`, `${'あ'.repeat(4_000)}x`, 'ちょっと'.repeat(2_000)]) {
      expect(quiet(transcript), transcript.slice(0, 12)).toBeNull();
    }
    expect(quiet('待って'.repeat(2_000))).toBe('answer:request');
    expect(quiet('あ'.repeat(30))).toBe('backchannel');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('answers what needs an answer however short it is', () => {
    const cases: [string, string][] = [
      ['シャノン', 'named'], ['今何時?', 'question'], ['なんで空は青いの', 'question'], ['これ読んで。', 'request'], ['音楽かけてくれる', 'request'],
      ['ただいま。', 'greeting'], ['ありがとう。', 'greeting'], ['ねえ', 'called'], ['君は', 'called'], ['違う。', 'correction'],
      ['眠い。', 'aimed_at_her'], ['疲れた。', 'aimed_at_her'], ['さすが。', 'aimed_at_her'], ['すごい。', 'greeting'],
    ];
    for (const [transcript, reason] of cases) expect(quiet(transcript), transcript).toBe(`answer:${reason}`);
    // Typed input is always for her.
    expect(quiet('うん', { ...alone, source: 'typed' })).toBe('answer:typed');
    // Wondering aloud is left to the model; a question mark makes it a question.
    expect(quiet('明日は晴れるかな。')).toBeNull();
    expect(quiet('明日は晴れるかな?')).toBe('answer:question');
  });

  it('with someone else present answers only when addressed, by the table rule of 「友人も一緒」', () => {
    expect(quiet('それ昨日買ったやつだよ。', withOthers)).toBe('not_addressed');
    expect(quiet('眠い。', withOthers)).toBe('not_addressed');
    expect(quiet('うん、そうそう。', withOthers)).toBe('not_addressed');
    expect(quiet('シャノン、どう思う?', withOthers)).toBe('answer:named');
    // A plain request is for her only right after her own utterance; otherwise it may be for the friend.
    expect(quiet('これ読んで。', withOthers)).toBe('not_addressed');
    expect(quiet('醤油とって', withOthers)).toBe('not_addressed');
    expect(quiet('これ読んで。', { ...withOthers, followsShannon: true, secondsSinceShannon: 5 })).toBe('answer:request');
    expect(quiet('その話、聞かせて。', withOthers)).toBe('answer:request');
    // Her open question is answered by a short reply only right after she asked.
    const stale = { ...withOthers, sheAsked: true, followsShannon: true, secondsSinceShannon: 100 };
    expect(quiet('醤油ある', stale)).toBe('not_addressed');
    expect(quiet('醤油とって', stale)).toBe('not_addressed');
    expect(quiet('うん。', stale)).toBe('backchannel');
    expect(quiet('醤油ある', { ...stale, secondsSinceShannon: 10 })).toBe('answer:answers_her_question');
    // A short remark right after her utterance continues the exchange with her; a long one, or a late one, is the people talking.
    const after = { ...withOthers, followsShannon: true, secondsSinceShannon: 5 };
    expect(quiet('へえ、面白いね。', after)).toBe('answer:reaction');
    expect(quiet('へえ、面白いね。', { ...after, secondsSinceShannon: 90 })).toBe('not_addressed');
    expect(quiet('うん。', { ...after, sheAsked: true })).toBe('answer:answers_her_question');
  });
});

describe('the facts of the moment', () => {
  const at = '2026-10-02T09:00:10.000Z';
  it('knows that she just asked, from the thread and its newest message', () => {
    const facts = ownerVoiceTurnFacts({
      history: [{ role: 'user', content: 'おはよう' }, { role: 'assistant', content: 'おはようございます。今日は何をしますか？' }],
      newest: { role: 'assistant', observedAt: START }, at, othersPresent: false, source: 'speech',
    });
    expect(facts).toEqual({ sheAsked: true, followsShannon: true, secondsSinceShannon: 10, shannonLastLine: 'おはようございます。今日は何をしますか？', othersPresent: false, source: 'speech' });
  });

  it('takes an utterance that answers her line to a touch as said to her', () => {
    const facts = ownerVoiceTurnFacts({ history: [], at, othersPresent: false, source: 'speech', answersHer: 'わっ、くすぐったいです。' });
    expect(facts).toMatchObject({ sheAsked: true, followsShannon: true, shannonLastLine: 'わっ、くすぐったいです。' });
    expect(ownerTurnVerdict('うん', facts)).toEqual({ respond: true, reason: 'answers_her_question' });
    // The microphone opened for his answer may hear her own line: that is still an echo, not an answer.
    const long = ownerVoiceTurnFacts({ history: [], at, othersPresent: false, source: 'speech', answersHer: 'わっ、くすぐったいです。もう、ライ氏ったら。' });
    expect(ownerTurnVerdict('くすぐったいです。もう、ライ氏ったら', long)).toEqual({ respond: false, category: 'echo' });
    expect(ownerTurnVerdict('ごめんごめん', long)).toEqual({ respond: true, reason: 'answers_her_question' });
    // Her whole line, or a part of four characters or more, is an echo...
    expect(ownerTurnVerdict('わっ、くすぐったいです', facts)).toEqual({ respond: false, category: 'echo' });
    expect(ownerTurnVerdict('くすぐったい', facts)).toEqual({ respond: false, category: 'echo' });
    // ...but a short reply or a backchannel that happens to be in her line is his answer.
    const yes = ownerVoiceTurnFacts({ history: [], at, othersPresent: false, source: 'speech', answersHer: 'はい？なんでしょう、ライ氏。' });
    for (const reply of ['はい', 'うん', 'ライ氏', 'なんでしょう?']) expect(ownerTurnVerdict(reply, yes)?.respond, reply).toBe(true);
    // A greeting or thanks that is half of her line is his own, not her echo.
    for (const [hers, his] of [['おはよう、ライ氏。', 'おはよう'], ['お疲れさまです。', 'お疲れさま'], ['ありがとう、ライ氏。', 'ありがとう']] as const) {
      const touched = ownerVoiceTurnFacts({ history: [], at, othersPresent: false, source: 'speech', answersHer: hers });
      expect(ownerTurnVerdict(his, touched)?.respond, his).toBe(true);
    }
    // Her whole short line coming back is an echo; a backchannel word is not.
    const what = ownerVoiceTurnFacts({ history: [], at, othersPresent: false, source: 'speech', answersHer: 'なに？' });
    expect(ownerTurnVerdict('なに？', what)).toEqual({ respond: false, category: 'echo' });
    const hai = ownerVoiceTurnFacts({ history: [], at, othersPresent: false, source: 'speech', answersHer: 'はい？' });
    expect(ownerTurnVerdict('はい', hai)).toEqual({ respond: true, reason: 'answers_her_question' });
    // A small part of her line is his own short reply.
    expect(ownerTurnVerdict('ライ氏ったら', long)?.respond).toBe(true);
  });

  it('finds her question anywhere in her line', () => {
    for (const content of ['何にしますか？決まったら教えてくださいね。', '散歩に行きましょうか。', 'どれがいいかな', 'コーヒーにしますか、それとも紅茶にしますか？']) {
      expect(ownerVoiceTurnFacts({ history: [{ role: 'assistant', content }], at, othersPresent: false }).sheAsked, content).toBe(true);
    }
    for (const content of ['わかりました。', 'カレーにしましょう。', '見てみますね。']) {
      expect(ownerVoiceTurnFacts({ history: [{ role: 'assistant', content }], at, othersPresent: false }).sheAsked, content).toBe(false);
    }
  });

  it('lets her question lapse after two minutes, and reads no question into a statement or into the owner\'s own words', () => {
    const history = [{ role: 'assistant' as const, content: '何にしますか？' }];
    expect(ownerVoiceTurnFacts({ history, newest: { role: 'assistant', observedAt: START }, at: '2026-10-02T09:02:01.000Z', othersPresent: false }).sheAsked).toBe(false);
    expect(ownerVoiceTurnFacts({ history: [{ role: 'assistant', content: 'わかりました。' }], at, othersPresent: false })).toMatchObject({ sheAsked: false, followsShannon: true });
    expect(ownerVoiceTurnFacts({ history: [...history, { role: 'user', content: 'ラーメン？' }], at, othersPresent: true }))
      .toEqual({ sheAsked: false, followsShannon: false, shannonLastLine: '何にしますか？', othersPresent: true });
    expect(ownerVoiceTurnFacts({ history: [], at, othersPresent: false })).toEqual({ sheAsked: false, followsShannon: false, othersPresent: false });
  });
});

describe('settling the router\'s answer against the rules', () => {
  const base = async (overrides: Partial<VoiceTurnDecision> = {}): Promise<VoiceTurnDecision> => ({
    ...await new LocalVoiceDecisionGateway().decide({ scopeKey: 'owner', transcript: '今日は外でご飯を食べてきたよ', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false }),
    source: 'jev', transcriptReliabilityProbability: 0.95, ...overrides,
  });
  const silentModel = { shouldRespond: false, conversationClass: 'no_response' as const, replyRequiredProbability: 0.05 };

  it('a rule for silence stands against a router that would answer', async () => {
    for (const [transcript, category] of [['え?', 'backchannel'], ['明日の会議の資料を', 'unfinished'], ['そっか、ちょっと待ってね。', 'hold'], ['あれ、おかしいな。', 'not_addressed']] as const) {
      const settled = settleOwnerVoiceTurn(await base(), { transcript, facts: alone, uncertain: true });
      expect(settled, transcript).toMatchObject({ shouldRespond: false, conversationClass: 'no_response', silence: category });
      expect(settled.waitingDirection, transcript).toBeUndefined();
    }
  });

  it('a rule for answering stands against a router that would stay silent', async () => {
    for (const transcript of ['シャノン', '今何時?', 'これ読んで。', 'ただいま。', '疲れた。']) {
      const settled = settleOwnerVoiceTurn(await base(silentModel), { transcript, facts: alone, uncertain: false });
      expect(settled, transcript).toMatchObject({ shouldRespond: true, conversationClass: 'direct' });
      expect(settled.silence, transcript).toBeUndefined();
    }
    const short = settleOwnerVoiceTurn(await base(silentModel), { transcript: 'うん。', facts: asked, uncertain: false });
    expect(short.shouldRespond).toBe(true);
  });

  it('where no rule speaks, the router\'s silence stands even when the transcript is unclear: she does not ask to repeat', async () => {
    const settled = settleOwnerVoiceTurn(await base({ ...silentModel, transcriptReliabilityProbability: 0.1 }),
      { transcript: 'あれ、ウェブコミに乗っ出るの。', facts: alone, uncertain: true });
    expect(settled).toMatchObject({ shouldRespond: false, silence: 'model' });
  });

  it('a short utterance the router could not trust is a fragment; a long one is still answered', async () => {
    const unsure = await base({ transcriptReliabilityProbability: 0.3, replyRequiredProbability: 0.3 });
    // What the router itself wants answered is not a fragment, however little it trusts the words.
    for (const transcript of ['火事だ', '倒れた', '救急車呼ぶ', '今日カレー']) {
      expect(settleOwnerVoiceTurn(await base({ transcriptReliabilityProbability: 0.4, replyRequiredProbability: 0.95 }), { transcript, facts: alone, uncertain: true }).shouldRespond, transcript).toBe(true);
    }
    expect(settleOwnerVoiceTurn(unsure, { transcript: 'あれ、ウェブコミに乗っ出るの。', facts: alone, uncertain: true })).toMatchObject({ shouldRespond: false, silence: 'unfinished' });
    expect(settleOwnerVoiceTurn(unsure, { transcript: '昨日さ、会社で部長にめちゃくちゃ言われたんだよね、もう参った。', facts: alone, uncertain: true }).shouldRespond).toBe(true);
    // Missing reliability (the local tier) is not low reliability.
    expect(settleOwnerVoiceTurn(await base({ transcriptReliabilityProbability: undefined }), { transcript: 'あれ、ウェブコミに乗っ出るの。', facts: alone, uncertain: true }).shouldRespond).toBe(true);
    expect(settleOwnerVoiceTurn(unsure, { transcript: 'あれ、ウェブコミに乗っ出るの。', facts: alone, uncertain: true }, { SHANNON_VOICE_FRAGMENT_CHARACTERS: '0' }).shouldRespond).toBe(true);
  });

  it('a router that is nearly sure no reply is needed is believed even when its class says otherwise', async () => {
    const doubtful = await base({ replyRequiredProbability: 0.05 });
    const turn = { transcript: 'うん、その件は明日折り返します。', facts: alone, uncertain: false };
    expect(settleOwnerVoiceTurn(doubtful, turn)).toMatchObject({ shouldRespond: false, silence: 'model' });
    expect(settleOwnerVoiceTurn(doubtful, turn, { SHANNON_VOICE_REPLY_SILENCE_BELOW: '0' }).shouldRespond).toBe(true);
    expect(settleOwnerVoiceTurn(await base({ replyRequiredProbability: 0.3 }), turn).shouldRespond).toBe(true);
  });

  it('SHANNON_VOICE_SILENCE_RULES=off restores the old decision; a list keeps only the named rules', async () => {
    expect([...voiceSilenceRules({})].sort()).toEqual(['backchannel', 'echo', 'hold', 'not_addressed', 'unfinished']);
    for (const off of ['off', 'OFF', 'false', '0', 'disabled']) expect(voiceSilenceRules({ SHANNON_VOICE_SILENCE_RULES: off }).size).toBe(0);
    expect([...voiceSilenceRules({ SHANNON_VOICE_SILENCE_RULES: 'backchannel, hold' })].sort()).toEqual(['backchannel', 'hold']);
    for (const on of ['on', 'true', '1', 'yes', 'all', ' ']) expect(voiceSilenceRules({ SHANNON_VOICE_SILENCE_RULES: on }).size).toBe(5);
    // 「no」 is off, and a misspelt name is ignored rather than read as "all".
    expect(voiceSilenceRules({ SHANNON_VOICE_SILENCE_RULES: 'no' }).size).toBe(0);
    expect(voiceSilenceRules({ SHANNON_VOICE_SILENCE_RULES: 'backchanel' }).size).toBe(0);
    expect([...voiceSilenceRules({ SHANNON_VOICE_SILENCE_RULES: 'backchanel,hold' })]).toEqual(['hold']);

    const off = { SHANNON_VOICE_SILENCE_RULES: 'off' };
    const answering = await base();
    expect(settleOwnerVoiceTurn(answering, { transcript: 'え?', facts: alone, uncertain: true }, off)).toBe(answering);
    // Before the rules an unclear transcript was always answered.
    expect(settleOwnerVoiceTurn(await base(silentModel), { transcript: '言われた。', facts: alone, uncertain: true }, off)).toMatchObject({ shouldRespond: true, conversationClass: 'direct' });
    expect(settleOwnerVoiceTurn(await base(silentModel), { transcript: '言われた。', facts: alone, uncertain: false }, off).shouldRespond).toBe(false);
    // A 「友人も一緒」 call brings no facts and keeps that behaviour: its own table rule decides.
    expect(settleOwnerVoiceTurn(await base(silentModel), { transcript: '言われた。', uncertain: true }).shouldRespond).toBe(true);

    const some = { SHANNON_VOICE_SILENCE_RULES: 'backchannel,hold' };
    expect(settleOwnerVoiceTurn(answering, { transcript: 'え?', facts: alone, uncertain: false }, some).silence).toBe('backchannel');
    expect(settleOwnerVoiceTurn(answering, { transcript: '明日の会議の資料を', facts: alone, uncertain: false }, some).shouldRespond).toBe(true);
  });
});

describe('what the two model tiers are told', () => {
  const input: VoiceDecisionInput = { scopeKey: 'owner', transcript: 'そっか。', participantMode: 'owner', requestedLocation: false, hasFreshLocation: false,
    context: [{ role: 'assistant', content: '夜ごはんは何にしますか？' }], turn: asked };
  const jevAnswers = { answers: {
    ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0 }])),
    reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0 }, transcript_reliable: { type: 'noul', noul: 0.9 },
    conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'neutral' },
    affect_intensity: { type: 'choice', choice: 'subtle' }, delivery: { type: 'choice', choice: 'conversational' },
    latency_class: { type: 'choice', choice: 'under_3s' },
  } };
  const categories = ['(a) the speech is not addressed to her', '(b) it is a backchannel or filler', '(c) the utterance is clearly unfinished', '(d) the speaker asks her to wait', '(e) it is noise, or an echo'];

  it('names the five reasons for silence, the answers she must give, the rule with others present, and when to ask to repeat', () => {
    const text = VOICE_REPLY_DECISION_LINES.join(' ');
    for (const category of categories) expect(text).toContain(category);
    expect(text).toContain('unless turn.she_just_asked is true');
    expect(text).toContain('Wait for the rest');
    expect(text).toContain('a direct question, it says her name (シャノン), it is a request, a greeting or thanks, an emotional remark aimed at her, an answer to her question');
    expect(text).toContain('When turn.others_present is true, speak only with evidence that she is addressed');
    expect(text).toContain('Asking the speaker to repeat is itself a reply. It is right only when she was evidently addressed and the content cannot be understood; otherwise stay silent.');
  });

  it('gives Jev the question and the facts, and nothing of her last line beyond the context it already had', async () => {
    let payload: Record<string, any> = {};
    const fetcher = async (_url: unknown, init?: RequestInit) => { payload = JSON.parse(String(init?.body)); return new Response(JSON.stringify(jevAnswers)); };
    const jev = new JevVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    await jev.decide(input);
    expect(payload.questions.reply_required.instructions).toBe(VOICE_REPLY_DECISION_LINES.join(' '));
    expect(payload.questions.reply_required.criteria.false).toContain('the speaker has not finished');
    expect(payload.state.turn).toEqual({ she_just_asked: true, follows_shannon: true, others_present: false, seconds_since_shannon_spoke: 4 });
    expect(JSON.stringify(payload.state.turn)).not.toContain('夜ごはん');
    expect(payload.state.recent_context).toEqual(input.context);

    // Without the facts (a 「友人も一緒」 call), and with the switch off, the payload is the one from before.
    await jev.decide({ ...input, turn: undefined });
    const legacy = payload;
    expect(legacy.questions.reply_required.instructions).toBe('Should Shannon produce a spoken reply to this utterance? False only for noise, a discarded fragment, or a conversational acknowledgement that naturally needs no response.');
    expect(legacy.state.turn).toBeUndefined();
    vi.stubEnv('SHANNON_VOICE_SILENCE_RULES', 'off');
    vi.stubEnv('SHANNON_VOICE_ROOM_LOOK', 'off');
    await jev.decide(input);
    expect(payload).toEqual(legacy);
  });

  it('gives the OpenAI fallback the same text and facts', async () => {
    let payload: Record<string, any> = {};
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        replyRequiredProbability: 0.1, solutionWantedProbability: 0.2, transcriptReliabilityProbability: 0.9, conversationClass: 'no_response',
        latencyClass: 'under_1s', affect: 'neutral', affectIntensity: 0.2, delivery: 'conversational', roomLookProbability: 0,
        skillScores: Object.fromEntries(VOICE_SKILLS.map(skill => [skill, 0])),
      }) }));
    };
    const openai = new OpenAIVoiceDecisionGateway({ apiKey: 'test-only', fetcher: fetcher as typeof fetch });
    const decision = await openai.decide(input);
    for (const line of VOICE_REPLY_DECISION_LINES) expect(payload.instructions).toContain(line);
    expect(JSON.parse(payload.input).turn).toEqual({ she_just_asked: true, follows_shannon: true, others_present: false, seconds_since_shannon_spoke: 4 });
    // The model said silence; she had just asked, so 「そっか。」 is an answer and the rule stands.
    expect(decision.shouldRespond).toBe(false);
    expect(settleOwnerVoiceTurn(decision, { transcript: input.transcript, facts: asked, uncertain: false }).shouldRespond).toBe(true);
    vi.stubEnv('SHANNON_VOICE_SILENCE_RULES', 'off');
    await openai.decide(input);
    expect(payload.instructions).toContain('Use no_response only for noise, abandoned fragments, or acknowledgements where silence is clearly natural.');
    expect(JSON.parse(payload.input).turn).toBeUndefined();
  });
});

describe('an owner call, end to end', () => {
  const delegations = '/v1/voice/live/delegations';

  class VoiceModel implements ShannonChatModel {
    readonly mode = 'openai' as const;
    readonly model = 'test-model';
    readonly voiceRequests: ShannonVoiceModelRequest[] = [];
    async generate(request: ShannonChatModelRequest) { return { mode: this.mode, model: this.model, reply: `返答:${request.message}` }; }
    async generateVoice(request: ShannonVoiceModelRequest) { this.voiceRequests.push(request); return { mode: this.mode, model: this.model, reply: 'はい、ライ氏。' }; }
  }

  /**
   * A router like the one of 2026-10-02 in its class (it would answer everything), which trusts short fragments
   * little and, asked the new question, is no longer sure that they need a reply.
   */
  function eager(): VoiceDecisionGateway & { inputs: VoiceDecisionInput[] } {
    const local = new LocalVoiceDecisionGateway();
    const inputs: VoiceDecisionInput[] = [];
    return { mode: 'jev', model: 'test', inputs, decide: async input => {
      inputs.push(input);
      const decision = await local.decide({ ...input, turn: undefined });
      const short = Array.from(input.transcript).length <= 16;
      return { ...decision, source: 'jev', shouldRespond: true, conversationClass: 'direct', replyRequiredProbability: short ? 0.4 : 0.8,
        transcriptReliabilityProbability: short ? 0.3 : 0.95 };
    } };
  }

  function harness() {
    const voiceDecision = eager();
    const clock = { at: START };
    const model = new VoiceModel();
    const store = new InMemoryConversationStore();
    const organize = new InMemoryOrganizeStore();
    const api = createLocalApiKernel(() => clock.at, { chatModel: model, conversationStore: store, voiceDecision, organizeStore: organize });
    const advance = (seconds: number) => { clock.at = new Date(Date.parse(clock.at) + seconds * 1_000).toISOString(); };
    const say = async (transcript: string, context: Record<string, unknown> = {}) => {
      const response = await api.dispatch({ method: 'POST', path: delegations, body: {
        scopeKey: 'owner', threadId: 'call', transcript,
        deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
          userUtterance: { id: `u-${clock.at}-${transcript}`, text: transcript, source: 'speech', rawText: transcript }, ...context },
      } });
      expect(response.status).toBe(200);
      return response.body as { reply: string; companionPresent?: boolean; voicePlan: { shouldRespond: boolean; silenceCategory?: string; waitingPhrase?: string } };
    };
    /** The client stores a spoken turn after her reply, as it does today. */
    const stored = (userTranscript: string, shannonTranscript: string) => api.dispatch({ method: 'POST', path: '/v1/voice/realtime/turns',
      body: { scopeKey: 'owner', threadId: 'call', userTranscript, shannonTranscript } });
    return { api, model, store, organize, clock, advance, say, stored, routed: voiceDecision.inputs };
  }

  it('a turn left unanswered runs no command and writes no orchestration state', async () => {
    const command = '先週の旅行の写真整理をタスクにして';
    // Said to her, the words are a command and are carried out.
    const direct = harness();
    expect(await direct.say(command)).toHaveProperty('receipt');
    expect(direct.organize.list('owner', 'call')).toHaveLength(1);
    // The same words as an echo of her own line, heard by the microphone a few seconds later, do nothing.
    const h = harness();
    await h.stored('タスクの作り方を教えて', `「${command}」と言ってくれれば登録します。`);
    h.advance(5);
    const orchestration = (h.api as unknown as { conversationOrchestration: { read(scopeKey: string, threadId: string): unknown } }).conversationOrchestration;
    const before = JSON.stringify(orchestration.read('owner', 'call'));
    const body = await h.say(command);
    expect(body).toMatchObject({ reply: '', voicePlan: { shouldRespond: false, silenceCategory: 'echo' } });
    expect(body).not.toHaveProperty('receipt');
    expect(h.organize.list('owner', 'call')).toEqual([]);
    expect(JSON.stringify(orchestration.read('owner', 'call'))).toBe(before);
    expect(h.model.voiceRequests).toEqual([]);
    // 「待って」 and a silence only the router chose are still his words: commands such as pausing work run as before.
    const decision = { shouldRespond: false } as VoiceTurnDecision;
    expect(['echo', 'not_addressed', 'unfinished'].map(silence => notHisWordsToHer({ ...decision, silence: silence as never }))).toEqual([true, true, true]);
    expect(['hold', 'model', 'backchannel', undefined].map(silence => notHisWordsToHer({ ...decision, silence: silence as never }))).toEqual([false, false, false, false]);
  });

  it('leaves unanswered what she answered on 2026-10-02, without a model call and without storing anything', async () => {
    const h = harness();
    await h.stored('今日はウェブコミの話をしたい', 'いいですね、ライ氏。聞かせてください。');
    h.advance(20);
    const cases: [string, string][] = [
      ['言われた。', 'unfinished'], ['え?', 'backchannel'], ['あれ?', 'backchannel'], ['あれ、ウェブコミに乗っ', 'unfinished'], ['出るの。', 'unfinished'],
      ['あれ、ウェブコミに乗っ出るの。', 'unfinished'], ['そっか、ちょっと待ってね。', 'hold'],
    ];
    const before = h.store.conversationHistory('owner', 'call').length;
    for (const [transcript, category] of cases) {
      const body = await h.say(transcript);
      expect(body, transcript).toMatchObject({ reply: '', voicePlan: { shouldRespond: false, conversationClass: 'no_response', silenceCategory: category } });
      expect(body.voicePlan.waitingPhrase, transcript).toBeUndefined();
    }
    expect(h.model.voiceRequests).toEqual([]);
    expect(h.store.conversationHistory('owner', 'call')).toHaveLength(before);
    expect(h.store.experienceCandidates('owner')).toHaveLength(1);
  });

  it('still answers the clear cases in the same call, and asks to repeat only what was said to her', async () => {
    const h = harness();
    for (const transcript of ['シャノン', '今何時?', 'これ読んで。', 'ただいま。', '疲れた。', '昨日さ、会社で部長にめちゃくちゃ言われたんだよね、もう参った。']) {
      const body = await h.say(transcript);
      expect(body, transcript).toMatchObject({ reply: 'はい、ライ氏。', voicePlan: { shouldRespond: true } });
      expect(body.voicePlan.silenceCategory, transcript).toBeUndefined();
    }
    // Her name with words the router could not trust: she was addressed, so the interpretation block (which may ask once) is used.
    expect(h.model.voiceRequests[0]!.systemPrompt).toContain('[Contextual transcript interpretation required]');
    expect(h.model.voiceRequests.at(-1)!.systemPrompt).not.toContain('[Contextual transcript interpretation required]');
  });

  it('takes a short 「うん」 as the answer to her question, and as nothing otherwise', async () => {
    const h = harness();
    await h.stored('お腹すいた', '夜ごはんは何にしますか？');
    h.advance(5);
    expect((await h.say('うん。')).voicePlan.shouldRespond).toBe(true);
    expect(h.routed[0]!.turn).toMatchObject({ sheAsked: true, followsShannon: true, secondsSinceShannon: 5, othersPresent: false, source: 'speech' });
    await h.stored('うん。', 'カレーにしましょう。');
    h.advance(5);
    expect(await h.say('うん。')).toMatchObject({ reply: '', voicePlan: { shouldRespond: false, silenceCategory: 'backchannel' } });
  });

  it('with someone listening, answers when addressed, keeps quiet otherwise, and still tells the client that someone is there', async () => {
    const h = harness();
    const quiet = await h.say('それ昨日買ったやつだよ。', { companionPresent: true });
    expect(quiet).toMatchObject({ reply: '', companionPresent: true, voicePlan: { shouldRespond: false, silenceCategory: 'not_addressed' } });
    expect(await h.say('シャノン、どう思う?', { companionPresent: true })).toMatchObject({ reply: 'はい、ライ氏。', companionPresent: true });
    // The turn in which he says that a friend is there is said to her.
    expect(await h.say('いま友達が隣にいるんだ、紹介するね。')).toMatchObject({ reply: 'はい、ライ氏。', companionPresent: true });
  });

  it('with the switch off answers them all again, as before', async () => {
    vi.stubEnv('SHANNON_VOICE_SILENCE_RULES', 'off');
    const h = harness();
    for (const transcript of ['言われた。', 'え?', 'あれ?', 'そっか、ちょっと待ってね。']) {
      expect(await h.say(transcript), transcript).toMatchObject({ reply: 'はい、ライ氏。', voicePlan: { shouldRespond: true } });
    }
  });
});
