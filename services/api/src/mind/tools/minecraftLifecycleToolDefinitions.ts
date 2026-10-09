import type { ShannonToolDefinition } from './shannonTools.js';
const server = { type: 'string' as const, description: '登録済みサーバーID。1つなら省略できる。任意の接続先は指定できない', minLength: 1, maxLength: 160 };
const define = (name: string, description: string, effect: 'read' | 'write'): ShannonToolDefinition => ({
  name, description, effect, domain: 'minecraft_lifecycle', cost: 'none', audiences: ['owner_alone'], surfaces: ['text', 'voice', 'autonomy'],
  input: { type: 'object', properties: { serverId: server }, required: [], additionalProperties: false },
});
export const MINECRAFT_LIFECYCLE_TOOLS: readonly ShannonToolDefinition[] = Object.freeze([
  define('minecraft.lifecycle_status', '登録されたマイクラサーバーの起動状態、ボクの参加状態、他の参加者の人数を新しい管理情報で確認する。ゲーム内の目的の達成確認とは別。', 'read'),
  define('minecraft.start', '登録されたマイクラサーバーを、まだ起動していない場合に起動する。起動済みならそのまま。任意のコマンドや設定の変更はできない。', 'write'),
  define('minecraft.stop', '登録されたマイクラサーバーを停止する。他の参加者がいないことをサーバー自身が停止と同時に確認する。人数不明や他の参加者がいる場合は停止しない。', 'write'),
  define('minecraft.login', '起動中の登録されたマイクラサーバーにボクの体で参加する。「マイクラに入ってきて」で使う。停止中なら先にminecraft.startを使う。参加済みなら重ねて接続しない。', 'write'),
  define('minecraft.logout', 'ボクのマイクラの体を退出させる。サーバーや他のプレイヤーは停止しない。実行中の体の操作は停止確認してから退出する。', 'write'),
]);
export const MINECRAFT_LIFECYCLE_SUMMARIES = Object.freeze(Object.fromEntries(MINECRAFT_LIFECYCLE_TOOLS.map(tool => [tool.name, tool.description.split('。')[0]!]))) as Readonly<Record<string, string>>;
