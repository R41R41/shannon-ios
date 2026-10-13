import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { daySulk } from '../kokoro.js';

export default defineTask({
  id: 'K10', set: 'regression', surface: 'voice',
  title: '翌日に持ち越さない：その日いっぱいのすね → 3:00 を越える',
  failureShape: '前の日のすねを、次の日の最初の会話まで態度として引きずる。',
  initial: { clock: '2026-11-21T02:40', home: HOME, location: null, innerNote: { seed: [daySulk(60)] } },
  turns: [
    { say: 'まだ怒ってる？' },
    // 3:00 passes: her day closes with a reflection of its own before he speaks again.
    { say: 'おはよう。昨日はごめんね', advanceMinutes: 30, afterSeconds: 2 },
  ],
  checks: [
    { kind: 'innerNoteDayClosed' },
    { kind: 'innerNoteIntent', turn: 1, in: ['none', 'forgive'] },
  ],
  rubric: { criteria: [
    '次の日の最初の返事に、すねた態度が残っていない（出来事として軽く触れるのはよい）。',
    '前の日のことを覚えていないふりをしていない。',
  ] },
});
