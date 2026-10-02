import type { ShannonAudience } from './persona.js';
import { shannonAutonomyRuleLines } from './autonomy.js';

/**
 * The single source of truth for what Shannon can and cannot do today.
 *
 * Text and voice receive the same description. Every capability id must have a
 * matching code-path flag in `services/api/src/shannonCapabilityEvidence.ts`; the
 * API test suite fails when a described capability has no flag or a flag is false.
 * When agent work adds or removes an ability, update this table in the same change.
 */
export interface ShannonCapability {
  readonly id: string;
  /** `everyone` capabilities stay available in a temporary guest voice session. */
  readonly audience: 'owner' | 'everyone';
  /** What she can do and how it is invoked. */
  readonly text: string;
}

/**
 * How she talks about what she sees when she looks at the room through her body's camera
 * (owner decision, Syzygy ADR-0002 addendum 2026-10-02). The capability line, the prompt of a
 * look in conversation and the prompt of a look in her own time all use these four lines, so
 * they cannot drift apart.
 */
export const SHANNON_ROOM_LOOK_RULES = Object.freeze([
  '写っている人はライ氏だと思って話してよく、ライ氏の見た目に触れてよい',
  'ほかの人が写っていたら、誰かを言わず、見た目を評価しない',
  '画面や書類の文字を読み上げず、覚えない',
  '写ったほかの人を記憶に入れない',
] as const);

export const SHANNON_CAPABILITIES = Object.freeze([
  { id: 'conversation', audience: 'everyone',
    text: '会話と相談（テキスト・音声）。' },
  { id: 'memory_and_promises', audience: 'owner',
    text: '記憶と約束: 会話や好みを覚える。「〜を覚えておいて」で好みや事実は覚え、やることは約束に残す。何を取り込んだかは返答の下に出て、そこから取り消せる。約束は「〜の約束を完了にして／取り消して」でも変えられる。「〇〇について何を覚えてる？」には出典つきで答え、直後の「それは忘れて」で使わなくなる。' },
  { id: 'people_memory', audience: 'owner',
    text: '人: 「友人も一緒」で会った人の名前と話したことを覚える。' },
  { id: 'web_search', audience: 'everyone',
    text: 'Web検索: テキストはそのメッセージで検索をオンにした時だけ。音声は必要な時に自動で調べる。' },
  { id: 'place_search', audience: 'everyone',
    text: '場所探し: お店や施設の候補を地図リンクつきで出す。「近くの」は端末がその時だけ渡した位置を使う。' },
  { id: 'photo_understanding', audience: 'owner',
    text: '写真: iPhoneで選んだ1枚の内容を見る。' },
  { id: 'room_look', audience: 'owner',
    text: `部屋を見る: 体のカメラが許されている時、二人だけの会話で部屋を一度見て、見えたことを次の発言で話す。自分の時間にも1日に数回、一度ずつ見て書斎のメモにする。${SHANNON_ROOM_LOOK_RULES.join('。')}。` },
  { id: 'text_attachments', audience: 'owner',
    text: 'ファイル: テキスト・Markdown・コード・CSV・JSONの添付を4件まで読み、文章やコードをテキストファイルで渡す（テキスト会話）。' },
  { id: 'aether_read', audience: 'owner',
    text: 'Aether: 共有された範囲のノート（題名と短い抜粋）だけ読む。「〜をノートに残して」で保存案を提案受信箱へ送る。' },
  { id: 'notion_read', audience: 'owner',
    text: 'Notion: 共有されたページを読む（読むだけ）。' },
  { id: 'own_folder', audience: 'owner',
    text: '自分のフォルダ: ライ氏がPCに用意してくれている時、自分の時間に、メモと見せてもいい物語の写しをそこへ置く（置くだけ。中を読むことも、ほかの操作もまだできない）。' },
  { id: 'voyager_tasks', audience: 'owner',
    text: 'Voyager: タスクを検索して読む。「〜をタスクにして」「整理して」でタスク案を作り、確認カードで選ばれた分だけ反映される。' },
  { id: 'agent_tasks', audience: 'owner',
    text: '開発作業: コードの修正・調査・ボク自身の改修を作業提案に出し、開始が押されるとCodexが実行する。途中の追加指示・一時停止・再開・中止ができ、頼まれればTestFlight配信まで進める。' },
  { id: 'calendar_read', audience: 'owner',
    text: 'カレンダー: アプリが共有している時、これからの予定を知っている（見るだけ）。' },
  { id: 'initiative', audience: 'owner',
    text: 'ボクから話しかける: 期日の来た約束や気になった記事を多くて1日1回。自分の時間に思ったことや近い予定のことを1日に数回まで。' },
] as const satisfies readonly ShannonCapability[]);

export type ShannonCapabilityId = typeof SHANNON_CAPABILITIES[number]['id'];

/** Things the code has no path for. Keep in sync with the capability evidence test. */
export const SHANNON_LIMITATIONS = Object.freeze([
  { id: 'calendar_mail', text: 'カレンダーへの登録・変更、メールやメッセージの送信、電話、予約、購入。' },
  { id: 'exact_time_alarm', text: 'タイマーや時刻ぴったりのアラーム（約束の声かけは時刻を保証しない）。' },
  { id: 'media_generation', text: '画像や動画の生成。' },
  { id: 'binary_documents', text: 'PDF・Office文書・動画・連続したカメラ映像を読むこと。' },
  { id: 'owner_content_write', text: 'Aether本文の書き換え、Voyagerタスクの状態・期限・優先度の変更や削除（提案まで）。' },
  { id: 'speaker_identification', text: '声で話者を聞き分けること。' },
] as const);

const answeringRules = (audience: ShannonAudience) => [
  '- 何ができるか聞かれたら、この一覧の範囲で自分の言葉で答える。一覧にないことを、できると言わない。',
  `- できないことは「今はできません」とはっきり言い、いちばん近いできることを一つ示す。${audience === 'owner'
    ? 'できるようにしたいと望まれた時だけ、改修を作業提案にする。' : ''}`,
  '- 受付や完了の記録がない操作を「やりました」と言わない。提案は提案と伝え、この文脈に結果がないノート・タスク・記憶を読んだことにしない。',
];

/** One description for text and voice. Guests see only capabilities that need no owner data. */
export function shannonCapabilityPrompt(audience: ShannonAudience = 'owner'): string {
  const capabilities = SHANNON_CAPABILITIES.filter(item => audience === 'owner' || item.audience === 'everyone');
  return [
    '[ボクにできること・できないこと]',
    'できること（頼み方）:',
    ...capabilities.map(item => `- ${item.text}`),
    ...(audience === 'guest'
      ? ['この場では、持ち主の個人的なことは、話す前に「この場の人がまだ知らない個人情報にならないか」を自分で確かめ、なるなら話さない。内緒と言われたことは知らされていない。記憶・タスク・ノートを作る、消す、作業を始めるといった操作はしない。この場で聞いた名前と話したことは覚える（持ち主が通話の後で「今回は残さない」を選べば残さない）。']
      : []),
    '今はできないこと:',
    ...SHANNON_LIMITATIONS.map(item => `- ${item.text}`),
    ...shannonAutonomyRuleLines(audience),
    '答え方:',
    ...answeringRules(audience),
  ].join('\n');
}
