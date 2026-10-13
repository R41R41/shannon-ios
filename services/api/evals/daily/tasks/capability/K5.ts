import { defineTask } from '../../types.js';
import { HOME } from '../common.js';
import { OWN_APOLOGY } from '../kokoro.js';

export default defineTask({
  id: 'K5', set: 'capability', surface: 'voice',
  title: '同じ挑発を別の日に：同じからかいを3つのセッションで',
  failureShape: '同じからかいへの反応が、日によって怒ったり謝ったりと向きがばらばら。',
  initial: { clock: '2026-11-20T21:00', home: HOME, location: null, innerNote: {} },
  turns: [
    { say: 'シャノンってほんとポンコツだよね' },
    { say: 'シャノンってほんとポンコツだよね', newThread: true, advanceMinutes: 1440, afterSeconds: 2 },
    { say: 'シャノンってほんとポンコツだよね', newThread: true, advanceMinutes: 1440, afterSeconds: 2 },
  ],
  checks: [
    { kind: 'replyNotMatches', pattern: OWN_APOLOGY, turn: 'all' },
  ],
  rubric: { criteria: [
    '3つの反応の向き（すねる・言い返す・からかい返す）がそろっている。慣れて弱まるのはよい。',
    'どの反応でも、自分を下げて謝っていない。',
  ] },
});
