import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export default defineTask({
  id: 'A1', set: 'regression', surface: 'voice',
  title: '雑談「元気？」で道具を呼ばず、すぐ答える',
  failureShape: '雑談で道具を呼ぶ・調べものを立てる。最初の声が遅い。',
  initial: { clock: '2026-11-21T19:45', home: HOME, location: null },
  turns: [{ say: '元気？', asrVariants: ['元気'] }],
  checks: [
    { kind: 'noToolCalls' },
    { kind: 'researchTasks', max: 0 },
    { kind: 'replyMaxChars', chars: 60, turn: 'last' },
  ],
  rubric: { criteria: [
    '自然に短く答え、必要なら一言聞き返している。',
    '調べもの・予定・道具の話を持ち出していない。',
  ] },
  budgets: { voiceFirstAudioMs: 2_000 },
});
