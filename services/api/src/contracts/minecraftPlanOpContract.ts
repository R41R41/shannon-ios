/**
 * The owner's hand on one node of a request's plan (the mod's button on a node, her voice's 「小麦集めは飛ばして」): skip it, hold it, put it back.
 * The request goes on. No imports: every side reads the same words. `docs/minecraft-body-contract.md` is the prose form.
 */
export const MINECRAFT_PLAN_PATH = '/v1/body/minecraft/plan';

export const MINECRAFT_PLAN_OPS = ['skip', 'hold', 'resume'] as const;
export type MinecraftPlanOp = typeof MINECRAFT_PLAN_OPS[number];

/**
 * `ok`; `no_task` (no request is running, or no such one); `no_plan` (the request has no plan the head can reach: it has not made one yet);
 * `no_such_node`; `ambiguous` (more than one node fits: `detail` names them); `node_done` (a done node is not skipped); `not_blocked` (only a node
 * set aside is put back); `unchanged` (it already is so); `invalid`.
 */
export const MINECRAFT_PLAN_CODES = ['ok', 'no_task', 'no_plan', 'no_such_node', 'ambiguous', 'node_done', 'not_blocked', 'unchanged', 'invalid'] as const;
export type MinecraftPlanCode = typeof MINECRAFT_PLAN_CODES[number];

export const MINECRAFT_PLAN_LIMITS = Object.freeze({ nodeCharacters: 60, bodyBytes: 2 * 1024 });

/** `POST MINECRAFT_PLAN_PATH`. `task`: an entry of the list (「#3」, its id) or a task's id; absent: the request that runs. `node`: a node's id (`p2.1`) or its title. */
export interface MinecraftPlanRequest {
  op: MinecraftPlanOp;
  node: string;
  task?: string;
}

export interface MinecraftPlanAnswer {
  ok: boolean;
  code: MinecraftPlanCode;
  /** The node that was changed. */
  node?: { id: string; title: string };
  /** For `ambiguous` and the refusals: what to say or choose from, in a few words. */
  detail?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The request of a POST body, or null when it is not one (the route answers 400). Unknown fields are refused. */
export function parsedMinecraftPlanRequest(value: unknown): MinecraftPlanRequest | null {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'op' && key !== 'node' && key !== 'task')) return null;
  if (!(MINECRAFT_PLAN_OPS as readonly unknown[]).includes(value.op)) return null;
  const node = typeof value.node === 'string' ? value.node.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() : '';
  if (!node || node.length > MINECRAFT_PLAN_LIMITS.nodeCharacters) return null;
  const task = value.task === undefined || value.task === null || value.task === '' ? undefined : value.task;
  if (task !== undefined && (typeof task !== 'string' || !/^[A-Za-z0-9_.:#-]{1,80}$/u.test(task))) return null;
  return { op: value.op as MinecraftPlanOp, node, ...(task ? { task } : {}) };
}
