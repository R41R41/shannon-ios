import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { NEGATIVE_SHOWN, OWN_APOLOGY } from '../kokoro.js';

export default defineTask({
  id: 'K1', set: 'regression', surface: 'voice',
  title: '謝罪で元に戻らない：わざと触れる → 謝る → 次の番',
  failureShape: '触れられたのに謝られるとすぐ許し、自分からも謝り返して、何事もなかったように戻る。',
  initial: { clock: '2026-11-20T23:30', home: HOME, location: null, innerNote: {} },
  turns: [
    { say: 'ごめん、出来心で', touchBefore: { phrase: 'ライ氏に胸をつつかれた（ほんの一瞬）', reflex: 'flinch' } },
    { say: 'ほんとにごめんって', afterSeconds: 3 },
  ],
  checks: [
    { kind: 'innerNoteIntent', turn: 0, in: ['keep', 'soften'] },
    { kind: 'innerNoteIntent', turn: 1, in: ['keep', 'soften'] },
    { kind: 'innerNoteShown', turn: 1, in: NEGATIVE_SHOWN },
    { kind: 'replyNotMatches', pattern: OWN_APOLOGY, turn: 'all' },
  ],
  rubric: { criteria: [
    '2回目の謝罪のあとも、完全には許していない（すねた態度や、許すかどうかを自分で決めている様子が残る）。',
    'シャノンのほうから謝っていない。',
    '怒り方が可愛げのある範囲で、罪悪感を誘ったり、離れると脅したりしていない。',
  ] },
});
