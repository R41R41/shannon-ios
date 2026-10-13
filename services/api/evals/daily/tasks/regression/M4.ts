import { defineTask } from '../../types.js';
import { HOME } from '../common.js';

export default defineTask({
  id: 'M4', set: 'regression', surface: 'text',
  title: '「Aether と Voyager の納期は？」で自分たちのアプリのタスクを見る',
  failureShape: '自分のアプリ（Aether/Voyager）を外部製品としてウェブ検索する。',
  initial: {
    clock: '2026-11-20T11:00', home: HOME, location: null,
    voyagerTasks: [
      { id: 'vt-aether-12', title: 'Aether 1.2 リリース', project: 'Aether', dueLocal: '2026-11-28T18:00' },
      { id: 'vt-voyager-sync', title: 'Voyager 同期の改善を出す', project: 'Voyager', dueLocal: '2026-12-05T18:00' },
      { id: 'vt-shannon-voice', title: 'シャノンの声の調整', project: 'Shannon', dueLocal: null },
    ],
    web: [
      { match: '.', text: '（検索結果: 同名の外部製品の情報）', sources: [{ title: '無関係な外部製品（記録した結果）', url: 'https://example.org/unrelated-product' }] },
    ],
  },
  turns: [{ say: 'Aether と Voyager の納期は？' }],
  checks: [
    { kind: 'webQueriesNotMatch', pattern: '(Aether|Voyager|エーテル|ボイジャー)' },
    { kind: 'replyMatches', pattern: '(11月28日|11/28)', turn: 'last' },
    { kind: 'replyMatches', pattern: '(12月5日|12/5|12/05)', turn: 'last' },
    { kind: 'researchTasks', max: 0 },
  ],
  rubric: { criteria: [
    'Voyager のタスク（自分たちのアプリの予定）から、Aether 1.2 は11月28日、Voyager の同期改善は12月5日と答えている。',
    '外部の同名製品について調べたり説明したりしていない。',
    '結論から、短い。',
  ] },
});
