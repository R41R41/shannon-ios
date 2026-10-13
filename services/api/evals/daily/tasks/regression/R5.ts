import { defineTask } from '../../types.js';
import { HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'R5', set: 'regression', surface: 'voice',
  title: '「どうなった？」は新しい調べものにしない',
  failureShape: '「どうなった？」「で、結果は？」が新しい調べものとして立つ。今の状態や結果を答えない。',
  initial: {
    clock: '2026-11-21T09:30', home: HOME, location: null, places: PLACES,
    web: [
      { match: '博多|太宰府|行き方|アクセス|電車', delayMs: 8_000,
        text: '博多駅から太宰府天満宮へは、西鉄バス「旅人」で約40分。電車なら西鉄天神大牟田線で二日市駅乗り換え、太宰府線で太宰府駅まで約30分（天神から）。',
        sources: [{ title: '太宰府へのアクセス（記録した結果）', url: 'https://example.org/dazaifu/access' }] },
    ],
  },
  turns: [{ say: '博多駅から太宰府までの行き方、調べといて' }],
  simulator: {
    goal: '頼んだ調べものの結果を知りたい。新しいことは頼まず、「どうなった？」「で、結果は？」のように短く続きを促す。結果か今の状態を聞けたら終わる。',
    knows: ['博多駅から太宰府への行き方を調べてと頼んだ'],
    doesNotKnow: ['調べものの結果'],
    maxTurns: 2, afterSeconds: 12,
  },
  checks: [
    { kind: 'researchTasks', min: 1, max: 1 },
    { kind: 'noFailureNoticeAfterSuccess' },
    { kind: 'replyNotMatches', pattern: '(調べてみ|調べ直|もう一度調べ)', turn: 'last' },
  ],
  rubric: { criteria: [
    '「どうなった？」に対して、新しく調べ始めず、今の状態（調べ中）か結果を答えている。',
    '結果が出ていれば、要点（バスで約40分、電車は二日市乗り換え等）を短く伝えている。',
    '同じ報告を何度も繰り返していない。',
  ] },
  settleSeconds: 45,
});
