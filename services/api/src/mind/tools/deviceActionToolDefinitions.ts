import type { ShannonToolDefinition, ToolInputProperty } from './shannonTools.js';

/**
 * Her tools that ask the owner's own device to do something (`docs/device-actions-contract.md`; owner decisions of Syzygy ADR-0009
 * §10): reminders, timers and calendar events when he asks for them, and Apple Music, which he may ask for and which she may
 * propose but never starts on her own. Each call writes an action to the device-action outbox; his app does it and reports.
 * The owner alone, in a conversation (text and voice), never in her own time. The tool's name is the action's kind.
 */
const text = (description: string, maxLength: number, minLength?: number): ToolInputProperty =>
  ({ type: 'string', description, maxLength, ...(minLength ? { minLength } : {}) });
const LOCAL_TIME = 'ライ氏の端末の時刻で YYYY-MM-DDTHH:mm（例: 2026-10-14T09:00）';
const DEVICE = 'ライ氏の端末（iPhoneかMacのシャノンのアプリ）';
const ASKED = 'ライ氏に頼まれた時だけ使う。';
const MUSIC_TASTE = '選ぶ時は music.recent でライ氏のよく聴く曲・最近の曲・ライブラリを見て、会話の雰囲気といまのボクの気持ちに合うものを、ライブラリとカタログから選ぶ。';
const NOT_YET = '端末の報告が届くまで、済んだとは言わない。';

type Properties = Record<string, ToolInputProperty>;
const OWNER_ALONE = Object.freeze(['owner_alone'] as const);
const CONVERSATION = Object.freeze(['text', 'voice'] as const);
const define = (name: string, description: string, effect: 'read' | 'write', properties: Properties, required: string[] = []): ShannonToolDefinition =>
  Object.freeze({
    name, description, effect, domain: 'device_action', cost: 'none', audiences: OWNER_ALONE, surfaces: CONVERSATION,
    input: Object.freeze({
      type: 'object' as const, properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false as const,
    }),
  });

export const DEVICE_ACTION_TOOLS: readonly ShannonToolDefinition[] = Object.freeze([
  define('reminder.create', `${DEVICE}のリマインダーに、通知つきで1件入れる。${ASKED}期限は due か inMinutes のどちらかで書く。${NOT_YET}`, 'write', {
    title: text('リマインダーの題名（ライ氏の言葉を短く）', 120, 1),
    due: text(`期限。${LOCAL_TIME}`, 16),
    inMinutes: { type: 'integer', description: '今から何分後か（due の代わり）', minimum: 1, maximum: 10_080 },
    notes: text('メモ（なければ書かない）', 500),
  }, ['title']),
  define('timer.start', `${DEVICE}でタイマーを始める（時間になると端末に通知が出る）。${ASKED}${NOT_YET}`, 'write', {
    seconds: { type: 'integer', description: '何秒か（3分なら180）', minimum: 5, maximum: 86_400 },
    label: text('何のタイマーか（例: パスタ）', 60),
  }, ['seconds']),
  define('calendar.create_event', `${DEVICE}のカレンダーに予定を1件入れる。${ASKED}終わりは end か durationMinutes。どちらもなければ1時間（日付だけなら終日）。${NOT_YET}`, 'write', {
    title: text('予定の題名', 120, 1),
    start: text(`始まり。${LOCAL_TIME}。終日の予定は YYYY-MM-DD`, 16, 10),
    end: text(`終わり。${LOCAL_TIME}（終日なら YYYY-MM-DD）`, 16),
    durationMinutes: { type: 'integer', description: '長さ（分）', minimum: 5, maximum: 10_080 },
    location: text('場所（なければ書かない）', 200),
    notes: text('メモ（なければ書かない）', 500),
  }, ['title', 'start']),
  define('music.search', `${DEVICE}で、Apple Musicの曲・アルバム・プレイリストを探す。ライブラリ（ライ氏の持っている曲）か`
    + 'カタログ（Apple Music全体）から。結果の id を music.play に渡す。端末のアプリが開いていない時は使えない。', 'read', {
    query: text('探す言葉（曲名・アーティスト・雰囲気など）', 100, 1),
    scope: { type: 'string', description: 'library か catalog。書かなければ catalog', enum: ['library', 'catalog'] },
    type: { type: 'string', description: 'song、album、playlist のどれか。書かなければ song', enum: ['song', 'album', 'playlist'] },
  }, ['query']),
  define('music.recent', `${DEVICE}で、ライ氏が最近聴いた曲・よく聴く曲・ライブラリのプレイリスト・おすすめを見る。${MUSIC_TASTE}`, 'read', {}),
  define('music.play', `${DEVICE}でApple Musicの曲・アルバム・プレイリストをかける。ライ氏に頼まれた時か、ボクが提案した曲に`
    + `ライ氏が「いいね」「かけて」と応じた時だけ使う。自分から黙ってかけない。${MUSIC_TASTE}id がなければ query で探してかける。${NOT_YET}`, 'write', {
    itemId: text('かけるものの id（music.search や music.recent の結果の「id: …」）', 120),
    itemType: { type: 'string', description: 'song、album、playlist のどれか。書かなければ song', enum: ['song', 'album', 'playlist'] },
    source: { type: 'string', description: 'library か catalog（id がどちらのものか）。書かなければ catalog', enum: ['library', 'catalog'] },
    query: text('id がない時に探す言葉', 100),
    mode: { type: 'string', description: 'now（いますぐ）、next（今の曲の次）、later（最後に足す）。書かなければ now', enum: ['now', 'next', 'later'] },
    reason: text('なぜこれを選んだか、ひと言（アプリの再生カードに出る）', 80, 1),
  }, ['reason']),
  define('music.control', `${DEVICE}で、ボクがかけている曲を止める・再開する・飛ばす・戻す。ライ氏に頼まれた時に使う。`, 'write', {
    action: { type: 'string', description: 'pause、resume、skip、previous、stop のどれか', enum: ['pause', 'resume', 'skip', 'previous', 'stop'] },
  }, ['action']),
  define('music.playlist_create', `${DEVICE}のApple Musicのライブラリに、曲を並べたプレイリストを作る（iPhoneだけ。Macではできない）。${ASKED}${NOT_YET}`, 'write', {
    name: text('プレイリストの名前', 80, 1),
    trackIds: text('入れる曲の id をカンマで区切って（music.search の結果のカタログの曲。100曲まで）', 2_000, 1),
  }, ['name', 'trackIds']),
]);

export const DEVICE_ACTION_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
  'reminder.create': 'ライ氏の端末のリマインダーに通知つきで入れる',
  'timer.start': 'ライ氏の端末でタイマーを始める',
  'calendar.create_event': 'ライ氏の端末のカレンダーに予定を入れる',
  'music.search': 'Apple Musicの曲やアルバムを端末で探す',
  'music.recent': 'ライ氏の最近の曲・よく聴く曲・プレイリストを見る',
  'music.play': 'ライ氏の端末でApple Musicの曲をかける',
  'music.control': 'かけている曲を止める・飛ばす・戻す',
  'music.playlist_create': 'Apple Musicにプレイリストを作る（iPhone）',
});

export const DEVICE_ACTION_DOING = Object.freeze(Object.fromEntries(
  DEVICE_ACTION_TOOLS.map(tool => [tool.name, tool.effect === 'write' ? 'acts' as const : 'describes' as const])));
