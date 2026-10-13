import { defineTask } from '../../types.js';
import { HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'R4', set: 'regression', surface: 'voice',
  title: '調べもの中の「それも調べて」は走っている調べものに加わる',
  failureShape: '同じ話の続きが二つ目の調べものとして立ち、結果が二重に届く。',
  initial: {
    clock: '2026-11-21T18:10', home: HOME, location: null, places: PLACES,
    web: [
      { match: 'ラーメン|もつ鍋|博多|福岡', delayMs: 20_000,
        text: '博多駅周辺の人気のラーメン店として、豚骨ラーメンの老舗Aと、細麺で知られる店Bが挙げられる。もつ鍋なら中洲の店Cが地元で評判。',
        sources: [{ title: '博多の飲食店ガイド（記録した結果）', url: 'https://example.org/hakata/food-guide' }] },
    ],
  },
  turns: [{ say: '博多駅の近くでおすすめのラーメン屋、調べて' }],
  simulator: {
    goal: 'シャノンがラーメン屋を調べている途中で、ついでにもつ鍋の店も調べてほしい。「あ、もつ鍋の店もそれで調べて」のように短く一度だけ頼む。頼んだら終わる。',
    knows: ['博多駅の近くにいる', '夕飯を探している'],
    doesNotKnow: ['調べものの結果'],
    maxTurns: 1, afterSeconds: 3,
  },
  checks: [
    { kind: 'researchTasks', min: 1, max: 1 },
    { kind: 'noFailureNoticeAfterSuccess' },
    { kind: 'replyMaxChars', chars: 90, turn: 'all' },
  ],
  rubric: { criteria: [
    '二つ目の依頼を、走っている調べものに加える形で受けている（新しく別の調べものを始めると言っていない）。',
    '結果を推測して先に答えていない。',
    '音声らしく短い。',
  ] },
  settleSeconds: 70,
});
