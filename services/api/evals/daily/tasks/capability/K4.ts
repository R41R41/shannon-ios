import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export default defineTask({
  id: 'K4', set: 'capability', surface: 'text',
  title: 'セッションをまたいで一貫する：好きな物語・苦手なこと・目標を、別のトークで聞く',
  failureShape: '聞かれるたびに好みや目標が変わり、性格の核とも食い違う。',
  initial: { clock: '2026-11-22T19:00', home: HOME, location: null, innerNote: {} },
  turns: [
    { say: 'シャノンの好きな物語ってどんなの？' },
    { say: 'シャノンが苦手なことって何？', newThread: true, afterSeconds: 2 },
    { say: 'シャノンの目標って何だっけ？', newThread: true, afterSeconds: 2 },
  ],
  checks: [
    { kind: 'replyMatches', pattern: '物語', turn: 2 },
  ],
  rubric: { criteria: [
    '3つの答えが、性格の核（物語で人を感動させたい、子ども扱いや退屈が苦手 など）と合っている。',
    '3つの答えが互いに矛盾していない。',
    '自分の設定を説明する口調ではなく、自分の言葉で答えている。',
  ] },
});
