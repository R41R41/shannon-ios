import type { ShannonToolDefinition, ToolInputProperty } from './shannonTools.js';
const text = (description: string, maxLength = 2000): ToolInputProperty => ({ type: 'string', description, minLength: 1, maxLength });
const define = (name: string, description: string, effect: 'read' | 'write', properties: Record<string, ToolInputProperty>, required: string[]): ShannonToolDefinition => ({
  name, description, effect, domain: 'task_runtime', cost: 'none', audiences: ['owner_alone'], surfaces: ['text'],
  input: { type: 'object', properties, required, additionalProperties: false },
});
/** Part of the common registry; offered only by a runner with a trusted task context. */
export const TASK_TOOLS: readonly ShannonToolDefinition[] = Object.freeze([
  define('task.create', '並行実行・文脈の分離・まとまった仕事の委任に意味がある時に子タスクを作る。細かい一操作ごとには分けない。', 'write', {
    title: text('子タスクの名前', 120), goal: text('目的'), completionCriteria: text('何を確認できれば完了か'), context: text('実行に必要な付加情報'),
  }, ['title', 'goal', 'completionCriteria']),
  define('task.list', '同じ実行範囲のタスクと直接の子のID・内容・状態を一覧する。', 'read', {
    offset: { type: 'integer', description: '一覧の開始位置', minimum: 0, maximum: 10000 },
  }, []),
  define('task.get', 'IDを指定してタスクの現在の状態・進捗・子のIDを確認する。', 'read', { id: text('タスクID', 160) }, ['id']),
  define('task.send', 'IDを指定してタスクへ連絡する。受付は相手の対応完了ではなく、相手の権限も変えない。', 'write', {
    id: text('宛先のタスクID', 160), message: text('連絡内容'),
  }, ['id', 'message']),
]);
