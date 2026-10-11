/**
 * True for SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended codes, as `node:sqlite` reports them
 * (`code: 'ERR_SQLITE_ERROR'`, `errcode`, message `database is locked`). Such an error means "try again later":
 * another connection held the write lock longer than this connection's busy timeout.
 */
export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code === 'number' && [5, 6].includes(code & 0xff)) return true;
  return /database (?:table )?is locked|SQLITE_BUSY|SQLITE_LOCKED/u.test(error.message);
}

/** At most one log line per `intervalMs` for a repeating condition, with the count of what was folded in. */
export function throttledLog(log: (line: string) => void, intervalMs = 60_000, clock: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY, folded = 0;
  return (line: string) => {
    const now = clock();
    if (now - last < intervalMs) { folded += 1; return; }
    log(folded ? `${line} (+${folded} since last line)` : line);
    last = now; folded = 0;
  };
}
