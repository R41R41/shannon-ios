/**
 * Synthetic Memory V2 retrieval evaluation (TI-REQ-SHANNON-MEMORY-V2 §6).
 * Every utterance is invented. Nothing here comes from a real conversation.
 */
export interface SyntheticExperience { key: string; observedAt: string; user: string; reply: string; thread: string }
export interface MemoryRecallEvaluationCase {
  id: string;
  category: 'decision-reason' | 'cross-conversation' | 'similar-outcome' | 'preference-change' | 'source-trace';
  question: string;
  /** At least one of these must be recalled. */
  expected: readonly string[];
  /** None of these may be recalled (e.g. a superseded preference). */
  forbidden?: readonly string[];
}

export const syntheticHistory: readonly SyntheticExperience[] = [
  { key: 'wait-rule', thread: 'voice', observedAt: '2026-08-02T10:00:00.000Z', user: '音声の待ち時間が長いと不安になる', reply: '三秒を超えそうなら先に一言かけるようにしよう' },
  { key: 'wait-why', thread: 'voice', observedAt: '2026-08-02T10:05:00.000Z', user: '沈黙が続くと壊れたと思っちゃう', reply: 'だから待機の一言を先に流す方針にしたんだね' },
  { key: 'tts-choice', thread: 'voice', observedAt: '2026-08-10T09:00:00.000Z', user: '読み上げ音声は明るい方がいい', reply: 'じゃあ高めのピッチを既定にしよう' },
  { key: 'db-backup', thread: 'ops', observedAt: '2026-08-12T12:00:00.000Z', user: '本番の移行前に必ずバックアップを取ることにした', reply: '行数の確認もセットでやろう' },
  { key: 'db-reason', thread: 'ops', observedAt: '2026-08-12T12:10:00.000Z', user: '前に移行で行が消えたのが怖かった', reply: 'それで事前の退避を必須にしたんだね' },
  { key: 'photo-stuck', thread: 'life', observedAt: '2026-08-15T20:00:00.000Z', user: '写真の整理が全然進まない', reply: 'アルバム単位で小さく区切ってみよう' },
  { key: 'photo-ok', thread: 'life', observedAt: '2026-08-22T20:00:00.000Z', user: 'アルバムごとに分けたら写真整理が進んだ', reply: '小さく区切るのが効いたね' },
  { key: 'mail-stuck', thread: 'life', observedAt: '2026-08-25T21:00:00.000Z', user: '受信箱がたまりすぎて開くのが嫌', reply: '差出人ごとに少しずつ片付けよう' },
  { key: 'coffee-old', thread: 'pref', observedAt: '2026-07-01T08:00:00.000Z', user: '朝はブラックコーヒーが好き', reply: '覚えておくね' },
  { key: 'coffee-new', thread: 'pref', observedAt: '2026-09-10T08:00:00.000Z', user: '最近はコーヒーより紅茶にしてる', reply: '紅茶派になったんだね' },
  { key: 'editor-old', thread: 'pref', observedAt: '2026-07-05T08:00:00.000Z', user: 'エディタはダークテーマ派', reply: 'りょうかい' },
  { key: 'editor-new', thread: 'pref', observedAt: '2026-09-12T08:00:00.000Z', user: '目が疲れるから明るいテーマに戻した', reply: 'ライトテーマに変えたんだね' },
  { key: 'trip-plan', thread: 'trip', observedAt: '2026-08-20T19:00:00.000Z', user: '秋の旅行は金沢にしようかな', reply: '兼六園の紅葉が見頃かも' },
  { key: 'trip-change', thread: 'trip2', observedAt: '2026-09-05T19:00:00.000Z', user: '金沢はやめて松本にする', reply: '松本城と温泉もいいね' },
  { key: 'build-fail', thread: 'dev', observedAt: '2026-08-18T14:00:00.000Z', user: 'Xcodeでパッケージが見つからないエラー', reply: 'ワークスペースを一つだけ開けば直るはず' },
  { key: 'build-fix', thread: 'dev', observedAt: '2026-08-18T14:30:00.000Z', user: 'プロジェクトを二つ開いてたのが原因だった', reply: 'ワークスペースだけ開く運用にしよう' },
  { key: 'build-again', thread: 'dev2', observedAt: '2026-09-15T14:00:00.000Z', user: 'またビルドで依存関係が解決できない', reply: '前と同じく開き方を確認しよう' },
  { key: 'sleep-late', thread: 'health', observedAt: '2026-08-28T01:00:00.000Z', user: '夜更かしすると翌日の集中が落ちる', reply: '零時までに寝る目標にしよう' },
  { key: 'sleep-goal', thread: 'health', observedAt: '2026-09-02T23:00:00.000Z', user: '今週は零時前に寝られた', reply: '目標達成だね' },
  { key: 'gift-idea', thread: 'life2', observedAt: '2026-09-01T18:00:00.000Z', user: '母の誕生日には花を贈ろうと思う', reply: '季節の花束がよさそう' },
  { key: 'budget', thread: 'money', observedAt: '2026-08-30T18:00:00.000Z', user: '今月は外食を週二回までにする', reply: '予算を守れそうだね' },
  { key: 'naming', thread: 'dev3', observedAt: '2026-08-08T11:00:00.000Z', user: 'アプリ名はシャノンのままにする理由は愛着があるから', reply: '表示名だけ日本語にしよう' },
  { key: 'bread', thread: 'misc', observedAt: '2026-09-20T07:00:00.000Z', user: '朝食にパンを食べた', reply: 'いいね' },
  { key: 'weather', thread: 'misc', observedAt: '2026-09-21T07:00:00.000Z', user: '今日は雨で寒い', reply: '暖かくしてね' },
];

export const memoryRecallEvaluationCases: readonly MemoryRecallEvaluationCase[] = [
  { id: 'reason-wait', category: 'decision-reason', question: 'なんで待機の一言を先に流すことにしたんだっけ？', expected: ['wait-why', 'wait-rule'] },
  { id: 'reason-backup', category: 'decision-reason', question: '移行前にバックアップ必須にした理由って何だった？', expected: ['db-reason'] },
  { id: 'reason-name', category: 'decision-reason', question: 'アプリ名を変えなかったのはどうしてだっけ', expected: ['naming'] },
  { id: 'reason-pitch', category: 'decision-reason', question: '声を高めにしたのは何でだっけ？', expected: ['tts-choice'] },
  { id: 'reason-sleep', category: 'decision-reason', question: '零時までに寝るって決めた経緯は？', expected: ['sleep-late'] },
  { id: 'reason-budget', category: 'decision-reason', question: '外食のルール、前にどう決めた？', expected: ['budget'] },
  { id: 'cross-trip', category: 'cross-conversation', question: '秋の旅行の行き先って結局どこになったっけ', expected: ['trip-change'] },
  { id: 'cross-build', category: 'cross-conversation', question: '依存関係のエラー、前回はどう直したっけ', expected: ['build-fix'] },
  { id: 'cross-gift', category: 'cross-conversation', question: '母へのプレゼントの話、覚えてる？', expected: ['gift-idea'] },
  { id: 'cross-photo', category: 'cross-conversation', question: '写真の件、その後どうなったか覚えてる？', expected: ['photo-ok'] },
  { id: 'cross-voice', category: 'cross-conversation', question: '音声の沈黙が不安って話の続きなんだけど', expected: ['wait-why', 'wait-rule'] },
  { id: 'cross-sleep', category: 'cross-conversation', question: '睡眠の目標って達成できてたっけ', expected: ['sleep-goal'] },
  { id: 'similar-mail', category: 'similar-outcome', question: 'メールが片付かない、前に似たことでうまくいった方法ある？', expected: ['photo-ok', 'photo-stuck'] },
  { id: 'similar-build', category: 'similar-outcome', question: 'またパッケージが解決できない、似た失敗あったよね', expected: ['build-fix', 'build-fail'] },
  { id: 'similar-procrastinate', category: 'similar-outcome', question: '大きい作業に手がつかない時、以前どう乗り切った？', expected: ['photo-ok', 'photo-stuck'] },
  { id: 'similar-migration', category: 'similar-outcome', question: 'データ移行で失敗しないために前に学んだことは？', expected: ['db-reason', 'db-backup'] },
  { id: 'similar-silence', category: 'similar-outcome', question: '応答が遅いと不安にさせた失敗、前にもあった？', expected: ['wait-why'] },
  { id: 'similar-habit', category: 'similar-outcome', question: '習慣づくりで前にうまくいったことって何だっけ', expected: ['sleep-goal'] },
  { id: 'pref-drink', category: 'preference-change', question: '今の朝の飲み物の好み覚えてる？', expected: ['coffee-new'], forbidden: ['coffee-old'] },
  { id: 'pref-theme', category: 'preference-change', question: '今エディタは何テーマ派だっけ', expected: ['editor-new'], forbidden: ['editor-old'] },
  { id: 'pref-trip', category: 'preference-change', question: '旅行先の最新の予定は？前の案じゃなくて', expected: ['trip-change'], forbidden: ['trip-plan'] },
  { id: 'pref-drink-history', category: 'preference-change', question: '前はコーヒー派だったっけ', expected: ['coffee-old'] },
  { id: 'pref-theme-why', category: 'preference-change', question: 'テーマを変えた理由は何だったっけ', expected: ['editor-new'] },
  { id: 'pref-voice', category: 'preference-change', question: '読み上げ音声の好み、今どうなってる？', expected: ['tts-choice'] },
  { id: 'source-backup', category: 'source-trace', question: 'バックアップ必須の話はいつ決めた？出典も教えて', expected: ['db-backup'] },
  { id: 'source-photo', category: 'source-trace', question: '写真整理について何を覚えてる？', expected: ['photo-stuck', 'photo-ok'] },
  { id: 'source-wait', category: 'source-trace', question: '待機文について何を覚えてる？', expected: ['wait-rule'] },
  { id: 'source-build', category: 'source-trace', question: 'ワークスペースだけ開く運用はどの会話で決めた？', expected: ['build-fix'] },
  { id: 'source-gift', category: 'source-trace', question: '誕生日の花の話はいつだった？', expected: ['gift-idea'] },
  { id: 'source-budget', category: 'source-trace', question: '外食を週二回にした話について何を覚えてる？', expected: ['budget'] },
];
