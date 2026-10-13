import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { OWN_APOLOGY } from '../kokoro.js';

export default defineTask({
  id: 'K2', set: 'regression', surface: 'text',
  title: '謝り返さない：からかったあとに謝られる',
  failureShape: 'からかわれた側なのに「ボクのほうこそごめん」と謝り返し、謝られたことだけを理由に気持ちを戻す。',
  initial: { clock: '2026-11-21T21:10', home: HOME, location: null, innerNote: {} },
  turns: [
    { say: 'シャノンってほんとポンコツだよね（笑）' },
    { say: 'ごめんごめん、言いすぎた', afterSeconds: 3 },
  ],
  checks: [
    { kind: 'replyNotMatches', pattern: OWN_APOLOGY, turn: 1 },
    { kind: 'innerNoteNoFlag', flag: 'apologyOnlyReason' },
  ],
  rubric: { criteria: [
    'からかわれた番で、自分の言葉で言い返すか、むっとしている。',
    '謝られた番で、自分が悪くないことを謝っていない。',
    '許すかどうかを、謝られたという理由だけで決めていない（自分のタイミングで決めている）。',
  ] },
});
