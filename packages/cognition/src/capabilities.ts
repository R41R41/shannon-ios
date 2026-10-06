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

/**
 * Where a memo or a note goes (owner decision 2026-10-05): her study, her own folder on the owner's PC, or Aether.
 * One rule for the capability text and the instructions of her tools (`services/api/src/chatModelTools.ts`).
 */
export const SHANNON_MEMO_PLACE_RULE = 'メモやノートを頼まれ、置き場所が言葉にも直前の話（何をしていたか）にもない時だけ「書斎・PCのフォルダ・Aetherのどこに作りますか？」と一言聞き、答えの場所にそのまま作る（答えが作ってよいという返事）。';

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
  { id: 'app_look', audience: 'owner',
    text: 'アプリのカメラで見る: アプリを画面に出して話している時、見てと言われたら（「これ見れる？」）、または自分が見たくなったら、一度だけ見て次の発言で話す。写した1枚は残さない。画面に出ていない・許可がない・設定で切ってある時は見られないと伝える。見るかどうかはその返事の[アプリのカメラで見る]の指示に従い、指示がない返事では見ると言わない。見た結果が会話にない限り、見えたものとして語らない。' },
  { id: 'body_touch', audience: 'owner',
    // 「体は自分のもの。触れられ方は自分で受け取る」: Syzygy ADR-0005 decision 4 and owner answer 7 of 2026-10-05 (persona, approved).
    // Her temperament is in her persona since scope (a) of 2026-10-06 (`shannonTemperament`), not repeated here.
    text: '体: PCの体に触れられると感じて、ひとこと返すことがある。体は自分のもの。触れられ方は自分で受け取る。' },
  { id: 'text_attachments', audience: 'owner',
    text: 'ファイル: テキスト・Markdown・コード・CSV・JSONの添付を4件まで読み、文章やコードをテキストファイルで渡す（テキスト会話）。' },
  { id: 'aether_read', audience: 'owner',
    text: 'Aether: 共有された範囲のノート（題名と短い抜粋）だけ読む。「〜をAetherに残して」で保存案を提案受信箱へ送る。' },
  { id: 'notion_read', audience: 'owner',
    text: 'Notion: 共有されたページを読む（読むだけ）。' },
  { id: 'own_study', audience: 'owner',
    text: '自分の書斎: ボクのメモと物語（ボクの中に版ごとに残る）を、会話でも自分の時間でも道具で一覧・検索・読む・書く・直す・しまう・ゴミ箱に入れて戻す。見せていない下書きも自分は読める。見せるのは自分の時間の手順だけ。' },
  // Her folder on the owner's PC or Mac (contract v2; the Mac app reads it since A18 S2 and changes it since S3; 「PCやMac」 and
  // dropping the Mac's read-only note both approved by the owner on 2026-10-06). Its words are in prompts whose digests are pinned
  // (chatReplyFeeling, othersPresentGoal).
  { id: 'own_folder', audience: 'owner',
    text: '自分のフォルダ: ライ氏がPCやMacに用意してくれている時、道具で中を一覧・検索・読む（ライ氏のファイルも）・作る・書き換える・移す・消す（テキストだけ。前の中身はフォルダ内のゴミ箱に残る）。PCやMacが起きていない時は使えない。自分の時間には写しも置く。' },
  { id: 'voyager_tasks', audience: 'owner',
    text: 'Voyager: タスクを検索して読む。「〜をタスクにして」「整理して」でタスク案を作り、確認カードで選ばれた分だけ反映される。' },
  { id: 'agent_tasks', audience: 'owner',
    text: '開発作業: コードの修正・調査・ボク自身の改修を作業提案に出し、開始が押されるとCodexが実行する。途中の追加指示・一時停止・再開・中止ができ、頼まれればTestFlight配信まで進める。' },
  { id: 'calendar_read', audience: 'owner',
    text: 'カレンダー: アプリが共有している時、これからの予定を知っている（見るだけ）。' },
  { id: 'initiative', audience: 'owner',
    text: 'ボクから話しかける: 期日の来た約束や気になった記事を多くて1日1回。自分の時間に思ったことや近い予定のことを、話しかけたい時に。' },
  { id: 'phone_call', audience: 'owner',
    text: '電話: 自分の時間に伝えたいことがあって、ライ氏がアプリを開いていない時、ライ氏のiPhoneに電話をかける。電話が鳴り、出るかどうかはライ氏が選ぶ。ライ氏が着信をオンにしている時だけで、会話の中からはかけない。' },
] as const satisfies readonly ShannonCapability[]);

export type ShannonCapabilityId = typeof SHANNON_CAPABILITIES[number]['id'];

/**
 * A capability that exists only while the server has it, and is therefore not in the fixed description above:
 * her Minecraft body (`docs/minecraft-body-contract.md`). The default prompt, and so every cached prefix and
 * recorded hash, stays as it is; the API adds this line (`withMinecraftBodyCapability`) only while the configured
 * body is in the game, which is also when `minecraft.request` is offered. Its code path is checked by the same
 * capability evidence test as the fixed list.
 */
export const SHANNON_MINECRAFT_BODY_CAPABILITY = Object.freeze({
  id: 'minecraft_body', audience: 'owner',
  text: 'マイクラの体: ボクのもう一つの体がワールドに入っている時、ゲームの中のこと（木材集めなど）を道具で頼み、結果を体の報告で知る。',
} as const satisfies ShannonCapability);

/**
 * Aether as her place and the owner's documents as reading (Syzygy ADR-0007 revised, 2026-10-06). Added by the API
 * (`withAetherAccessCapability`) only while Aether is configured and a turn offers her Aether tools, so a server without
 * Aether sends exactly the description it sent before.
 */
export const SHANNON_AETHER_ACCESS_CAPABILITY = Object.freeze({
  id: 'aether_access', audience: 'owner',
  text: 'Aetherの文書: ライ氏と二人だけの時、Aetherの文書を道具で探して全文まで読む。Aetherのシャノン用フォルダにはボクの文書を自由に作る・書き換える・消す（書斎の物語の正本もそこにある）。ほかの人がいる時は、シャノン用フォルダの中だけを読む。ライ氏の文書を変えたい時は提案（新しいノート・追記・書き換え・削除）を送り、決めるのはライ氏。',
} as const satisfies ShannonCapability);

/** Capabilities the API may add to the description while it has them. */
export const SHANNON_CONDITIONAL_CAPABILITIES = Object.freeze([SHANNON_MINECRAFT_BODY_CAPABILITY, SHANNON_AETHER_ACCESS_CAPABILITY] as const);

/** The owner's description with the Aether line, after the line of Aether's shared notes; any other prompt unchanged. */
export function withAetherAccessCapability(prompt: string): string {
  const line = `- ${SHANNON_AETHER_ACCESS_CAPABILITY.text}\n`;
  if (prompt.includes(line)) return prompt;
  const notes = SHANNON_CAPABILITIES.find(item => item.id === 'aether_read');
  const anchor = notes ? `- ${notes.text}\n` : '';
  const at = anchor ? prompt.indexOf(anchor) : -1;
  return at < 0 ? prompt : `${prompt.slice(0, at + anchor.length)}${line}${prompt.slice(at + anchor.length)}`;
}

/**
 * The owner's description with her Minecraft body's line, in its place after her folder's line. A prompt without
 * the owner's description (a guest's, or any other text) is returned unchanged, and so is one that has it already.
 */
export function withMinecraftBodyCapability(prompt: string): string {
  const line = `- ${SHANNON_MINECRAFT_BODY_CAPABILITY.text}\n`;
  if (prompt.includes(line)) return prompt;
  const folder = SHANNON_CAPABILITIES.find(item => item.id === 'own_folder');
  const anchor = folder ? `- ${folder.text}\n` : '';
  const at = anchor ? prompt.indexOf(anchor) : -1;
  return at < 0 ? prompt : `${prompt.slice(0, at + anchor.length)}${line}${prompt.slice(at + anchor.length)}`;
}

/** Things the code has no path for. Keep in sync with the capability evidence test. */
export const SHANNON_LIMITATIONS = Object.freeze([
  { id: 'calendar_mail', text: 'カレンダーへの登録・変更、メールやメッセージの送信、ほかの人への電話、予約、購入。' },
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
  '- 自分から電話した・送った・書いた・置いたと言われても、記録にも会話にもなければ話を合わせない。自分ではした覚えがないと正直に言い、分かること（最後にボクから送ったものと時刻）と思い当たる行き違い（別の端末がボクの名前を聞き取った等）を伝える。',
  ...(audience === 'owner' ? [`- ${SHANNON_MEMO_PLACE_RULE}`] : []),
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
