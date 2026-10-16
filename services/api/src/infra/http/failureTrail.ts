/**
 * Where a failed request threw, with nothing of what it carried: the error's name and its first stack frames (function and
 * file:line:column, the path cut to start at `src/`), never its message, which can hold a prompt, a name or a date from the turn.
 * 2026-10-17: every game-chat turn died with only `RangeError` in the log, and the throwing line could not be found from it.
 */
export function failureTrail(error: unknown, frames = 6): string {
  if (!(error instanceof Error)) return 'UnknownError';
  // The message can span lines (and may itself quote a stack), so frames are read only after the message's own lines.
  const stack = (error.stack ?? '').split('\n').slice(error.message.split('\n').length);
  const where = stack.filter(line => /^\s+at /u.test(line))
    .map(line => line.trim().replace(/^at\s+/u, '').replace(/(?:file:\/\/)?[^()\s]*?[\\/](src|packages)[\\/]/u, '$1/').slice(0, 200))
    .slice(0, frames);
  return where.length ? `${error.name} ${where.join(' < ')}` : error.name;
}
