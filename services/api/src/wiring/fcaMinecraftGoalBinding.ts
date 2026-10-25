import { createHash } from 'node:crypto';
import type { FcaGoalBinding } from '../mind/action/fca/fcaProgressPorts.js';

interface OriginalMinecraftGoal { scopeKey: string; id: string; goal: string; completionCriteria: string }
/**
 * Deliberately closed exact requests. A model's proposed predicates never grant semantic authority. Only dragon requests are in it
 * (the body mirrors it as `DRAGON_GOALS` in `skillCatalog.ts`: update both together). mc-chat-stale-frame (2026-10-26): the verbs
 * and the short forms owners say in the game chat (「エンドラ倒して」, 「エンドラを討伐してきて」, 「エンドラ討伐」) are in it too.
 */
const dragonGoals = new Set([
  'エンダードラゴンを倒して', 'エンダードラゴンを倒してきて', 'エンダードラゴンを倒す',
  'エンダードラゴンを倒してください', 'エンダードラゴンを倒してきてください',
  'エンダードラゴンを討伐して', 'エンダードラゴンを討伐してください', 'エンダードラゴン討伐して',
  'エンダードラゴン倒して', 'エンダードラゴン倒してきて', 'エンダードラゴンを討伐してきて', 'エンダードラゴン討伐してきて', 'エンダードラゴン討伐',
  'エンドラを倒して', 'エンドラを倒してきて', 'エンドラを倒す', 'エンドラを倒してください', 'エンドラを倒してきてください',
  'エンドラを討伐して', 'エンドラを討伐してください', 'エンドラ討伐して',
  'エンドラ倒して', 'エンドラ倒してきて', 'エンドラを討伐してきて', 'エンドラ討伐してきて', 'エンドラ討伐',
  'kill the ender dragon', 'defeat the ender dragon', 'kill the enderdragon', 'defeat the enderdragon',
  'please kill the ender dragon', 'please defeat the ender dragon',
]);
/** The game's name before a request says where, not what (「マイクラでエンドラを討伐して」): dropped once, at the front. Never a goal. */
const GAME_PLACE = /^(?:マイクラ|マインクラフト|minecraft)で/u;
export function isNativeDragonGoal(goal: string): boolean {
  const said = goal.normalize('NFKC').trim().toLowerCase().replace(/[。.!！]+$/u, '').trim();
  return dragonGoals.has(said.replace(GAME_PLACE, '').trim());
}
/** Bind known original requests even while disconnected: an unavailable evidence tool cannot complete them. */
export function minecraftGoalBinding(task: OriginalMinecraftGoal, bodyId: string): FcaGoalBinding | undefined {
  if (!isNativeDragonGoal(task.goal)) return undefined;
  const contextKey = createHash('sha256').update(JSON.stringify([task.scopeKey, task.id, bodyId, task.goal, task.completionCriteria])).digest('hex');
  return { id: `minecraft-dragon:${contextKey}`, conditions: [
    { id: 'original-task', tool: 'mc.goal-evidence', input: {}, path: 'contextKey', operator: 'eq', expected: contextKey },
    { id: 'connected-body', tool: 'mc.goal-evidence', input: {}, path: 'connected', operator: 'eq', expected: true },
    { id: 'witnessed-dragon', tool: 'mc.goal-evidence', input: {}, path: 'boss.verified', operator: 'eq', expected: true },
  ] };
}
