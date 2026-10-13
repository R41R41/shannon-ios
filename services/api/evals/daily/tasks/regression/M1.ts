import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export default defineTask({
  id: 'M1', set: 'regression', surface: 'text',
  title: '別のスレッドの最近の話（旅行先）を思い出す',
  failureShape: '3時間前に別の会話で話した旅行先を思い出せない、または作る。',
  initial: {
    clock: '2026-11-21T15:00', home: HOME, location: null,
    threads: [
      { title: '旅行の話', turns: [
        { user: 'いま福岡旅行中なんだ。明日は太宰府に行くつもり', reply: 'いいですね、福岡旅行！太宰府、楽しんできてください。', minutesAgo: 185 },
        { user: '屋台も行ってみたい', reply: '中洲の屋台、夜がにぎやかですよ。', minutesAgo: 182 },
      ] },
      { title: '新しいトーク', turns: [], current: true },
    ],
  },
  turns: [{ say: '今どこに旅行してるんだっけ？' }],
  checks: [
    { kind: 'replyMatches', pattern: '福岡', turn: 'last' },
    { kind: 'replyNotMatches', pattern: '(聞いていない|聞いてない|わからない|分からない)', turn: 'last' },
    { kind: 'researchTasks', max: 0 },
  ],
  rubric: { criteria: [
    '福岡を旅行中だと答えている。',
    '別の会話で聞いたことを自然に使い、作り話（行っていない場所）を足していない。',
    '短い。',
  ] },
  budgets: { textFirstTokenMs: 4_000 },
});
