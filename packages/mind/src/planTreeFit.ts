import { PLAN_LIMITS,PLAN_KINDS,PREP_STATES } from './planTreeTypes.js';
import type { PlanPrep,PlanPromise } from './planTreeTypes.js';

export const isText = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !value.includes('\0');
export const optionalText = (value: unknown, limit: number) => value === undefined || isText(value, limit);

const PROMISE_ITEM = /^[a-z][a-z0-9_]{0,63}$/u;
export const kindFits = (value: unknown) => value === undefined || (PLAN_KINDS as readonly string[]).includes(String(value));
export const prepFits = (value: unknown) => value === undefined || (!!value && typeof value === 'object' && (
  PREP_STATES as readonly string[]).includes(String((value as PlanPrep).state))
  && optionalText((value as PlanPrep).why, PLAN_LIMITS.text) && optionalText((value as PlanPrep).at, 40));
/** What is wrong with the promises of a tree (the shape and bounds of each; the ledger is the head's), or null. */
export function promisesProblem(promises: unknown): string | null {
  if (!Array.isArray(promises) || promises.length > PLAN_LIMITS.promises) return 'promises';
  const ids = new Set<number>();
  for (const item of promises as PlanPromise[]) {
    if (invalidPromiseIdentity(item, ids)) return 'id';
    ids.add(item.id);
    if (!promiseItemFits(item.item) || !Number.isSafeInteger(item.count) || item.count < 1 || !isText(item.use, PLAN_LIMITS.promiseUse)) return 'fields';
    if (!['open', 'kept_by_instead', 'closed'].includes(item.state) || !Array.isArray(item.ledger)) return 'state';
    if (item.have !== undefined && !(typeof item.have === 'number' && Number.isFinite(item.have) && item.have >= 0)) return 'have';
  }
  return null;
}
/** A promise's item: `food` (food points) or a concrete item name (`oak_planks`; `planks` counts every kind, as
 * `have` reads it). */
export const promiseItemFits = (value: unknown): boolean => typeof value === 'string' && PROMISE_ITEM.test(value);

/** 約束の識別子・改訂番号・重複の確認。 */
function invalidPromiseIdentity(item: PlanPromise, ids: Set<number>): boolean {
  return !item || !Number.isSafeInteger(item.id) || item.id < 1 || ids.has(item.id) || !Number.isSafeInteger(item.rev) || item.rev < 1;
}

