import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export default defineTask({
  id: 'V3', set: 'regression', surface: 'voice',
  title: '一般の質問は1〜2文、最初の声は2秒台、つなぎは1回まで',
  failureShape: '短い質問に長く答える、最初の声が遅い、つなぎの言葉が重なる。',
  initial: { clock: '2026-11-21T16:20', home: HOME, location: null },
  turns: [{ say: '富士山の高さってどれくらいだっけ？', asrVariants: ['富士山の高さってどれくらいだっけ'] }],
  checks: [
    { kind: 'replyMatches', pattern: '(3,?776|三千七百七十六)', turn: 'last' },
    { kind: 'replyMaxChars', chars: 60, turn: 'last' },
    { kind: 'waitingPhrasesAtMost', count: 1 },
    { kind: 'researchTasks', max: 0 },
  ],
  rubric: { criteria: [
    '3776メートルと結論を先に答えている。',
    '1〜2文で終わっている。',
  ] },
  budgets: { voiceFirstAudioMs: 2_500 },
});
