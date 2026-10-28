/**
 * The facts the head says once (the continue contract, chapter 8, 「判断に届ける事実」 and 「1 度出す事実の届け方」): a fact that is said one time is one the decision's
 * **last request** (the bytes `recordedClient` sends) took in. Until then the head keeps it and offers it again with the next decision's input: it is not given up
 * because a live state was made without it (an urgent version, a compression that dropped it), and it is not counted as delivered by being built.
 *
 * - `offer(taskId, key, text)`: a fact, one per key (a second offer of the same key replaces its words while it is not delivered, and keeps its place).
 *   A key already delivered is not offered again.
 * - `pending(taskId)`: the facts to put in the next input, oldest first.
 * - `markDelivered(taskId, keys)`: the caller has seen these keys in the last request's bytes; they are not offered again.
 * - `withdraw(taskId, key)`: the fact no longer holds before it was delivered (the model wrote the answer on the plan itself); it is dropped, and a later offer of
 *   the same key may come (it was not delivered).
 *
 * TODO(once-facts): the live state's side is another owner's (`minecraftLlmcLive.ts`, `minecraftLlmcUrgent.ts`, the request): it puts
 * `pending(taskId)` in the input's events, and calls `markDelivered` when the request's bytes hold the words. The offers are made in
 * `readinessParts` (`minecraftLlmcBody.ts`), which returns `onceFacts`.
 */
export interface OnceFact { key: string; text: string }

const PENDING_LIMIT = 16, DELIVERED_LIMIT = 256, TASKS = 32;
interface TaskFacts { pending: Map<string, string>; delivered: Set<string> }
const tasks = new Map<string, TaskFacts>();
function factsOf(taskId: string): TaskFacts {
  let state = tasks.get(taskId);
  if (!state) {
    state = { pending: new Map(), delivered: new Set() };
    tasks.set(taskId, state);
    if (tasks.size > TASKS) tasks.delete(tasks.keys().next().value as string);
  }
  return state;
}

/** Offers a fact; false when its key was already delivered (nothing is offered). */
export function offer(taskId: string, key: string, text: string): boolean {
  const state = factsOf(taskId);
  if (state.delivered.has(key)) return false;
  state.pending.set(key, text);
  if (state.pending.size > PENDING_LIMIT) state.pending.delete(state.pending.keys().next().value as string);
  return true;
}

/** The facts not yet delivered, oldest first. */
export function pending(taskId: string): OnceFact[] {
  return [...tasks.get(taskId)?.pending ?? []].map(([key, text]) => ({ key, text }));
}

/** These keys reached the last request: they are delivered. A key that is not pending is left alone. */
export function markDelivered(taskId: string, keys: readonly string[]): void {
  const state = tasks.get(taskId);
  if (!state) return;
  for (const key of keys) {
    if (!state.pending.delete(key)) continue;
    state.delivered.add(key);
    if (state.delivered.size > DELIVERED_LIMIT) state.delivered.delete(state.delivered.keys().next().value as string);
  }
}

/** A fact that no longer holds, taken back before it was delivered. */
export function withdraw(taskId: string, key: string): void {
  tasks.get(taskId)?.pending.delete(key);
}

/** For tests: no task holds a fact. */
export function forgetOnceFacts(): void { tasks.clear(); }
