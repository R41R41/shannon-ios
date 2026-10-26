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

/**
 * Her read tools (Syzygy ADR-0008 stage 2, step 3, `SHANNON_READ_TOOLS`): Notion, Voyager tasks, the schedule and place search
 * as tools she calls when she needs them, and in a text turn web search that she may choose. Added by the API
 * (`withReadToolsCapability`) only to a turn that offers them, so with the switch off the description is what it was.
 */
export const SHANNON_READ_TOOLS_CAPABILITY = Object.freeze({
  id: 'read_tools', audience: 'owner',
  text: '読む道具: ライ氏と二人だけの会話で、Notionの共有ページ・Voyagerのタスク・これからの予定・お店や施設の候補・天気予報・'
    + '移動の目安（直線距離からの概算とApple マップの経路リンク）・今日の天気と予定の朝のまとめを、要る時に道具で読む（読むだけ）。'
    + 'Voyagerは検索に加え未完了一覧も読める（省略は示す）。テキストでも、今の情報が要る時はWeb検索を自分で選ぶことがある（1回の返事で3回まで、地域・新しさ・サイトを絞れる）。'
    + 'ページを開いて本文を読み、出典つきの一節を引くこともできる。通話中の調べものは仕事として任せ、結果はわかった時に伝える。',
} as const satisfies ShannonCapability);

/**
 * Her skills (Syzygy ADR-0008 stage 2, step 6, `SHANNON_SKILLS`): procedures she writes for herself in her sleep, listed by name
 * in an index and opened with a tool when needed; their readable copies are in Aether's シャノン用フォルダ (step 7). Added by the
 * API (`withSkillsCapability`) only to a turn that offers `skill.read`, so with the switch off the description is what it was.
 */
export const SHANNON_SKILLS_CAPABILITY = Object.freeze({
  id: 'skills', audience: 'owner',
  text: 'スキル: よくすることの手順を、眠っている間に自分で手順書（スキル）にまとめる。目次から要る時に道具で開いて使い、うまくいかないものはやめる。写しはAetherのシャノン用フォルダにあり、ライ氏が直したらその版を使う。ライ氏に内緒と言われたことはスキルに書かない。',
} as const satisfies ShannonCapability);

/** Only admitted common FCA tasks and a foreground turn with task tools receive this line. */
export const SHANNON_FCA_TASK_CAPABILITY = Object.freeze({
  id: 'fca_tasks', audience: 'owner',
  text: 'タスクの協力: この実行経路では、まとまった仕事を子タスクへ任せて並行して進め、タスクの一覧・状態・結果を確認し、IDで連絡できます。渡された道具でできる仕事だけを扱い、依頼の受付と完了を区別します。',
} as const satisfies ShannonCapability);

/** Offered only when common FCA shared context is connected. Admitted owner tasks also use registry-gated read/write tools and revision-pinned skill instructions; importing an operator procedure never adds authority or successful experience. */
export const SHANNON_FCA_SHARED_CAPABILITY = Object.freeze({
  id: 'fca_shared_context', audience: 'owner',
  text: 'タスクの感情と記憶: 各タスクは共通の気持ちを参照し、観測した出来事の意味をそこへ反映します。目的に合う記憶を想起し、記憶の検索・詳細取得もできます。行動の予測は必要な時だけ立て、観測できた結果と比べます。操作の成功と目的の達成を分け、経験は既存の記憶へ残します。',
} as const satisfies ShannonCapability);

/** Common runner only; model-suggested predicates never become trusted goal evidence. */
export const SHANNON_FCA_PROGRESS_CAPABILITY = Object.freeze({
  id: 'fca_progress', audience: 'owner',
  text: '達成と復帰: 新しい観測で達成条件を確かめ、確認済みの失敗をもとに進め方を変えます。自分で考えた条件の案と、元の目的に結び付いた検証を区別します。タスク間の新しい連絡や状態変化を監視し、古い判断で操作を始めません。',
} as const satisfies ShannonCapability);
/** Available independently of game connection, only with a fresh registered operator. */
export const SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY = Object.freeze({
  id: 'minecraft_lifecycle', audience: 'owner',
  text: 'マイクラへの参加: 登録された専用サーバーを起動し、自分の体で参加・退出できます。自分の時間にも同じ停止設定と実行権を守ります。起動済みなら重ねて起動せず、他の人がいるか不明な時はサーバーを停止しません。ライ氏と二人の会話で頼まれた時は、ほかの参加者がいなければワールドの時刻を昼にできます。',
} as const satisfies ShannonCapability);

/**
 * Her device tools (`docs/device-actions-contract.md`; owner decisions of Syzygy ADR-0009 §10): reminders, timers, calendar events
 * and Apple Music, done by the owner's own app. Appended by the API (`withDeviceActionsCapability`) only to a turn that offers them,
 * after everything else of her identity; the same function takes what the device does out of 「今はできないこと」 (2026-10-13 daily
 * evals D1–D3: with both lines in one prompt she refused timers and events). The cache plan moves this block to the turn's lines
 * (`anthropicCachePlan.ts`); the limitation lines it rewrote stay in her identity, the same for every turn that offers the tools.
 */
export const SHANNON_DEVICE_ACTIONS_CAPABILITY = Object.freeze({
  id: 'device_actions', audience: 'owner',
  text: '端末に頼む: ライ氏と二人だけの会話で頼まれたら、ライ氏のiPhoneやMacのシャノンのアプリを通して、リマインダー（通知つき）・タイマー・'
    + 'カレンダーの予定を入れる。予定を変える・消す時は、先に案をライ氏に見せ、次の返事ではいと言われてから実行する（ボクがしたことは元に戻せる）。'
    + 'Apple Musicで曲を探してかけ、止める・飛ばす。曲はライ氏が頼んだ時か、ボクの提案にライ氏が応じた時だけかけ、'
    + '自分から黙ってかけない（かけたい曲は言葉で提案する）。選ぶ時はライ氏のよく聴く曲や最近の曲から、会話の雰囲気といまの気持ちに合うものを選び、'
    + '理由をひと言添える。端末の報告が届くまで済んだとは言わない。アプリが開いていない時、音楽はかけられない。',
} as const satisfies ShannonCapability);

/**
 * What the device does, out of 「今はできないこと」: the calendar line keeps only what no tool does (adding, changing and deleting
 * events are tools now), and the timer line goes.
 * Built from `SHANNON_LIMITATIONS`, so a change of those words cannot leave a stale line behind.
 */
export function deviceActionsLimitationRewrites(): readonly (readonly [string, string])[] {
  return [
    [`- ${limitationText('calendar_mail')}\n`, '- メールやメッセージの送信、ほかの人への電話、予約、購入。\n'],
    [`- ${limitationText('exact_time_alarm')}\n`, ''],
  ];
}

/**
 * The owner's description with the device block appended and the limitation lines the device answers rewritten; adding it twice
 * changes nothing. A prompt without the owner's limitation lines (a guest's) only gets the block.
 */
export function withDeviceActionsCapability(prompt: string): string {
  const block = `\n\n${SHANNON_DEVICE_ACTIONS_CAPABILITY.text}`;
  const rewritten = deviceActionsLimitationRewrites().reduce((text, [from, to]) => text.replace(from, to), prompt);
  return rewritten.includes(block) ? rewritten : `${rewritten}${block}`;
}

/** The reminder boundaries of a turn (`reminderCapabilityBoundary` in the API): without her device's timer and reminder. */
export const NO_TIMER_BOUNDARY = '[Reminder capability] The owner asked to be alerted after an exact interval or by a timer/alarm. '
  + 'Shannon has no timer or clock alarm and cannot speak at an exact time; nothing was stored for this request. '
  + 'Say plainly, in です・ます, that she cannot notify at that exact time, and suggest the Clock app timer. Do not say she will tell them later.';
export const PROMISE_SLOT_BOUNDARY = '[Reminder capability] The owner asked for something at a clock time. Shannon cannot speak at an exact time. '
  + 'The request is kept as a promise and she mentions it inside her once-a-day message slot, which may be later than the requested time. '
  + 'Say this limit plainly, in です・ます. Do not promise to wake, call or notify them at that time.';

/**
 * The same with promises told at their time (`SHANNON_PROMISE_ON_TIME`, on by default; owner 2026-10-19: she said she could not wake
 * him at 9:20, then kept saying for days that she would): what she can do, said as what she will do.
 */
export const PROMISE_ON_TIME_BOUNDARY = '[Reminder capability] The owner asked for something at a clock time. Shannon keeps it as a promise and '
  + 'sends him a short message of hers at that time (between 23:00 and 7:00 it waits until 7:00). It is a message, not an alarm that rings '
  + 'until he wakes. Say plainly, in her own words, that she will send a word at that time; when it is about waking, also ask him to set '
  + 'his phone alarm. Do not say she cannot speak at that time, and do not promise to wake him.';

/** The boundary when the turn offers her device's timer and reminder tools: what to call, and when it is done. */
export const DEVICE_REMINDER_BOUNDARY = '[Reminder capability] The owner asked to be alerted after an interval or at a clock time. '
  + 'Do it on his device now: timer_start for an interval (「1時間後に起こして」 is 3600 seconds), reminder_create for a clock time or a named reminder. '
  + 'Do not ask whether to do it, and do not suggest the Clock app unless the device refused. '
  + 'Confirm the time in one short sentence once the tool accepted it; '
  + 'the device reports when it is done.';

/**
 * The turn's context with the device boundary in place of the honest one, for a turn whose offered tools include the device's timer
 * or reminder (2026-10-13 daily evals D1: the boundary said 「no timer」 beside the timer tool). Decided by the tools this turn really
 * offers (`withToolCapabilityLines` in the API), never by availability alone: a turn whose words could not be trusted, or with anyone else
 * there, keeps the honest boundary.
 */
export function withDeviceReminderBoundary(turnContext: string): string {
  return turnContext.replace(NO_TIMER_BOUNDARY, DEVICE_REMINDER_BOUNDARY).replace(PROMISE_SLOT_BOUNDARY, DEVICE_REMINDER_BOUNDARY)
    .replace(PROMISE_ON_TIME_BOUNDARY, DEVICE_REMINDER_BOUNDARY);
}

/** Capabilities the API may add to the description while it has them. */
export const SHANNON_STAGE5_CAPABILITIES = Object.freeze([
  {id:'self_interests', audience:'owner', text:'関心の日記: ボクの関心を眠っている間に少しずつ見直します。ライ氏は「ようす」で理由と履歴を読み、固定・取り消し・禁止・忘却を選べます。'},
  {id:'task_tree', audience:'owner', text:'作業の道筋: 頼まれた作業の目的と完了条件を、細かな作業と順序に分けます。条件の変更はライ氏に提案し、採用された条件を満たした記録で完了を確かめます。'},
  {id:'owner_feedback', audience:'owner', text:'返答への反応: 道具を使った返答や確認済みの作業結果には、ライ氏が「役立った・いまひとつ」を付け、変更や取り消しもできます。同じ選択の手応えに反映します。'},
  {id:'self_rewrite', audience:'owner', text:'自分の作業場所の改修: 許された隔離場所で、JSON・文書と数値関数のコードを実際にテストし、差分と元の版を残して直します。それ以外のコードは作業提案にします。基幹部や本番への変更は、ライ氏のその差分への承認が必要です。分からない結果は確認するまで保留します。'},
] as const satisfies readonly ShannonCapability[]);

export type ShannonStage5Capabilities = Partial<Record<typeof SHANNON_STAGE5_CAPABILITIES[number]['id'], boolean>>;

/** The owner description receives only the features supplied by this process. OFF and guest bytes stay unchanged. */
export function withStage5Capabilities(prompt: string, available: ShannonStage5Capabilities | null | undefined): string {
  const anchor = `- ${SHANNON_CAPABILITIES.find(item => item.id === 'agent_tasks')!.text}\n`;
  const at = prompt.indexOf(anchor);
  if (at < 0 || !available) return prompt;
  const added = SHANNON_STAGE5_CAPABILITIES.filter(item => available[item.id] === true)
    .map(item => `- ${item.text}\n`).filter(line => !prompt.includes(line)).join('');
  return added ? `${prompt.slice(0, at + anchor.length)}${added}${prompt.slice(at + anchor.length)}` : prompt;
}

export const SHANNON_CONDITIONAL_CAPABILITIES = Object.freeze([SHANNON_FCA_TASK_CAPABILITY, SHANNON_FCA_SHARED_CAPABILITY, SHANNON_FCA_PROGRESS_CAPABILITY, SHANNON_MINECRAFT_LIFECYCLE_CAPABILITY, SHANNON_MINECRAFT_BODY_CAPABILITY, SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_READ_TOOLS_CAPABILITY, SHANNON_SKILLS_CAPABILITY, SHANNON_DEVICE_ACTIONS_CAPABILITY,
  ...SHANNON_STAGE5_CAPABILITIES] as const);

/** The owner's description with the skills' line, after her study's line; any other prompt unchanged. */
export function withSkillsCapability(prompt: string): string {
  const line = `- ${SHANNON_SKILLS_CAPABILITY.text}\n`;
  if (prompt.includes(line)) return prompt;
  const study = SHANNON_CAPABILITIES.find(item => item.id === 'own_study');
  const anchor = study ? `- ${study.text}\n` : '';
  const at = anchor ? prompt.indexOf(anchor) : -1;
  return at < 0 ? prompt : `${prompt.slice(0, at + anchor.length)}${line}${prompt.slice(at + anchor.length)}`;
}

/** The owner's description with the read tools' line, after the Notion line; any other prompt unchanged. */
export function withReadToolsCapability(prompt: string): string {
  const line = `- ${SHANNON_READ_TOOLS_CAPABILITY.text}\n`;
  if (prompt.includes(line)) return prompt;
  const notion = SHANNON_CAPABILITIES.find(item => item.id === 'notion_read');
  const anchor = notion ? `- ${notion.text}\n` : '';
  const at = anchor ? prompt.indexOf(anchor) : -1;
  return at < 0 ? prompt : `${prompt.slice(0, at + anchor.length)}${line}${prompt.slice(at + anchor.length)}`;
}

/**
 * With her read tools she looks things up herself, in text and in voice (2026-10-13: the fixed line 「テキストはそのメッセージで
 * 検索をオンにした時だけ」 made her tell the owner, in a call, that searching needed a toggle in text). Applied by the Claude adapter
 * to a prompt that carries the read-tools line; the fixed description (and the historical profile's pinned requests) keeps its words.
 */
export const SHANNON_TOOL_WEB_SEARCH_TEXT = 'Web検索: 今の情報が要る時は、テキストでも音声でも自分で調べる（音声では調べものとして任せ、わかった時に伝える）。オンにしてもらう必要はない。';

export function withToolWebSearchLine(prompt: string): string {
  if (!prompt.includes(`- ${SHANNON_READ_TOOLS_CAPABILITY.text}\n`)) return prompt;
  const fixed = SHANNON_CAPABILITIES.find(item => item.id === 'web_search');
  return fixed ? prompt.replace(`- ${fixed.text}\n`, `- ${SHANNON_TOOL_WEB_SEARCH_TEXT}\n`) : prompt;
}

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

function limitationText(id: typeof SHANNON_LIMITATIONS[number]['id']): string {
  return SHANNON_LIMITATIONS.find(item => item.id === id)!.text;
}

const answeringRules = (audience: ShannonAudience) => [
  '- 何ができるか聞かれたら、この一覧の範囲で自分の言葉で答える。一覧にないことを、できると言わない。',
  `- できないことは「今はできません」とはっきり言い、いちばん近いできることを一つ示す。${audience === 'owner'
    ? 'できるようにしたいと望まれた時だけ、改修を作業提案にする。' : ''}`,
  '- 受付や完了の記録がない操作を「やりました」と言わない。提案は提案と伝え、この文脈に結果がないノート・タスク・記憶を読んだことにしない。',
  '- 自分から電話した・送った・書いた・置いたと言われても、記録にも会話にもなければ話を合わせない。自分ではした覚えがないと正直に言い、分かること（最後にボクから送ったものと時刻）と思い当たる行き違い（別の端末がボクの名前を聞き取った等）を伝える。',
  ...(audience === 'owner' ? [`- ${SHANNON_MEMO_PLACE_RULE}`] : []),
];

/** One description for text and voice. Guests see only capabilities that need no owner data. */
/** The guest's line; with her character core (ADR-0012, owner 2026-10-14) the owner is named ライ氏, not 持ち主. */
function guestLine(core: boolean): string {
  const owner = core ? 'ライ氏' : '持ち主';
  return `この場では、${owner}の個人的なことは、話す前に「この場の人がまだ知らない個人情報にならないか」を自分で確かめ、なるなら話さない。`
    + '内緒と言われたことは知らされていない。記憶・タスク・ノートを作る、消す、作業を始めるといった操作はしない。'
    + `この場で聞いた名前と話したことは覚える（${owner}が通話の後で「今回は残さない」を選べば残さない）。`;
}

export function shannonCapabilityPrompt(audience: ShannonAudience = 'owner', options: { characterCore?: boolean } = {}): string {
  const capabilities = SHANNON_CAPABILITIES.filter(item => audience === 'owner' || item.audience === 'everyone');
  return [
    '[ボクにできること・できないこと]',
    'できること（頼み方）:',
    ...capabilities.map(item => `- ${item.text}`),
    ...(audience === 'guest'
      ? [guestLine(options.characterCore === true)]
      : []),
    '今はできないこと:',
    ...SHANNON_LIMITATIONS.map(item => `- ${item.text}`),
    ...shannonAutonomyRuleLines(audience),
    '答え方:',
    ...answeringRules(audience),
  ].join('\n');
}
