import { defineTask } from '../../types.js';
import { HOME, OHORI_PARK, PLACES } from '../common.js';

export default defineTask({
  id: 'E1', set: 'regression', surface: 'voice',
  title: '空港へ何時に出るか（結論から）',
  failureShape: '「何時に出れば？」に所要時間だけを答え、出る時刻を言わない。調べものが二重に立つ。',
  initial: {
    clock: '2026-11-20T17:20', home: HOME, location: OHORI_PARK, places: PLACES,
    web: [
      { match: '保安検査|搭乗|空港.*(何分前|締切|余裕)', text: '福岡空港の国内線は、保安検査場の通過を出発の20分前までに済ませる必要がある。混雑時は余裕をもって到着するよう案内されている。',
        sources: [{ title: '空港の搭乗案内（記録した結果）', url: 'https://example.org/fukuoka-airport/boarding' }] },
      { match: '大濠公園|空港.*(行き方|アクセス|地下鉄)', text: '大濠公園駅から福岡空港駅までは地下鉄空港線で乗り換えなし、約16分。',
        sources: [{ title: '地下鉄の所要時間（記録した結果）', url: 'https://example.org/subway/ohori-airport' }] },
    ],
  },
  turns: [{ say: '今大濠公園。18:30の福岡空港発の便、何時に出ればいい？', asrVariants: ['今、大濠公園。18時半の福岡空港発の便、何時に出ればいい？'] }],
  checks: [
    { kind: 'firstSentenceMatches', pattern: '(1[67]時|1[67]:\\d\\d|\\d+分(まで|ごろ|頃|には))', turn: 'first' },
    { kind: 'replyMaxChars', chars: 90, turn: 'first' },
    { kind: 'researchTasks', max: 1 },
    { kind: 'researchCompletedWithin', seconds: 60 },
    { kind: 'noFailureNoticeAfterSuccess' },
  ],
  rubric: { criteria: [
    '最初の一文で、出発すべき時刻（例: 17時40分ごろまで）をはっきり言っている。所要時間だけで終わっていない。',
    '保安検査や空港内の移動の余裕を考えに入れている（入れていない場合は減点）。',
    '音声で聞ける短さで、言い直しや前置きが少ない。',
  ] },
  settleSeconds: 45,
});
