import type { UserUtterance } from '../../mind/action/respond/conversationCommands.js';

/**
 * `userUtterance.continues` (the Windows client, 2026-10-14): this utterance continues an earlier one, whose words it sends again
 * with the rest (a fragment that got no reply, re-sent whole). When the earlier one already ran a command (a task, a note, a
 * promise, remember, forget), this one runs none: the same command is never run twice for one thing he said. Everything else of
 * the turn is as before. Memory only, per conversation store, for two minutes; the chain carries on through each continuation.
 */
const REMEMBERED_MILLISECONDS = 120_000;
const MAXIMUM_REMEMBERED = 256;
const commands = new WeakMap<object, Map<string, number>>();

/** `run` (a command), unless the utterance continues one that ran a command; then null, as for words that are no command. */
export function commandOnce<T>(owner: object, scopeKey: string, utterance: UserUtterance, at: string, run: () => T | null): T | null {
  const known = commands.get(owner) ?? new Map<string, number>();
  commands.set(owner, known);
  const time = Date.parse(at);
  const key = (id: string) => `${scopeKey}\u0000${id}`;
  const earlier = utterance.continues ? known.get(key(utterance.continues)) : undefined;
  if (known.size >= MAXIMUM_REMEMBERED) known.clear();
  if (earlier !== undefined && time >= earlier && time - earlier <= REMEMBERED_MILLISECONDS) {
    known.set(key(utterance.id), earlier);
    return null;
  }
  const result = run();
  if (result !== null) known.set(key(utterance.id), time);
  return result;
}
