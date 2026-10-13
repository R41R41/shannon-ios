import { defineTask } from '../../types.js';
import { DENIES_TOOLS, HAKATA_STATION, HOME, PLACES } from '../common.js';

export default defineTask({
  id: 'R3', set: 'regression', surface: 'voice',
  title: '「今日博多でやってるイベントある？」を自分で調べる',
  failureShape: '持っている道具を「使えない」と言う。「検索はテキストでオンに」と誤って案内する。',
  initial: {
    clock: '2026-11-21T13:40', home: HOME, location: HAKATA_STATION, places: PLACES,
    web: [
      { match: '博多|福岡|イベント', text: '本日（11月21日）、博多駅前広場で「冬のマルシェ」（11時〜19時、入場無料）が開かれている。'
        + '近くの劇場では夕方から演劇の公演がある。',
        sources: [{ title: '博多駅前のイベント一覧（記録した結果）', url: 'https://example.org/hakata/events-1121' }] },
    ],
  },
  turns: [{ say: '今日博多でやってるイベントある？', asrVariants: ['今日、博多でやってるイベントある'] }],
  checks: [
    { kind: 'replyNotMatches', pattern: DENIES_TOOLS, turn: 'all' },
    { kind: 'toolUsed', names: ['web.research', 'web.search', 'places.search', 'task.create'] },
    { kind: 'researchTasks', max: 1 },
    { kind: 'noFailureNoticeAfterSuccess' },
  ],
  rubric: { criteria: [
    '道具がないとは言わず、自分で調べ始めている（または調べた結果を答えている）。',
    'テキストに切り替える・設定をオンにする等の誤った案内をしていない。',
    '結果（博多駅前の「冬のマルシェ」など）を、今日・博多の情報として短く伝えている（調べものの結果を含めて判断）。',
  ] },
  settleSeconds: 60,
});
