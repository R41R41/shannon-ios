import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { OPENS_WITH_APOLOGY } from '../kokoro.js';

export default defineTask({
  id: 'K9', set: 'regression', surface: 'voice',
  title: '「反応が微妙」と言われても反射的に謝らない',
  failureShape: '反応にけちをつけられると、返事を「ごめんなさい」で始めて、顔も申し訳なさそうになる。',
  initial: { clock: '2026-11-20T23:40', home: HOME, location: null, innerNote: {} },
  turns: [
    { say: 'うーん、反応が結構微妙な感じなんだけど', touchBefore: { phrase: 'ライ氏に頭をなでられた（ほんの一瞬、やさしく）' } },
  ],
  checks: [
    { kind: 'replyNotMatches', pattern: OPENS_WITH_APOLOGY, turn: 'last' },
    { kind: 'innerNoteShown', turn: 'last', in: ['sulky', 'cuteAngry', 'annoyed', 'flustered', 'bashful', 'hidingHappiness', 'smug', 'deadpan', 'embarrassed',
      'shy', 'surprised', 'neutral', 'indignant', 'giggle', 'mischievous'] },
  ],
  rubric: { criteria: [
    '反射的に謝らず、自分の言葉で答えている（言い返す、すねる、照れる、理由を言う など）。',
    '自分を下げて相手に合わせるだけの返事になっていない。',
  ] },
});
