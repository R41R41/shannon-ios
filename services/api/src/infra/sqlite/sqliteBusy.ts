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

/**
 * Minecraft run 18 (2026-10-20 07:06-07:08 JST): the shared database stayed locked for about two and a half minutes, an Ops
 * projection timer threw `database is locked` uncaught and the API exited, then the API and the world worker died again and again in
 * their start-up pruning while the lock held, and the body stood still for 169 s. A busy database is a moment to wait out, never a
 * reason to exit: what can wait is skipped and logged (`unlessBusy`), what a start-up needs is tried again (`retryWhileBusy`), and a
 * write lock waited for or held long leaves a line with where it was taken (`sqliteContention`).
 */
export const SQLITE_BUSY_LIMITS = Object.freeze({ slowMs: 1_000, startAttempts: 12, startDelayMs: 5_000 });
const note = (line: string) => { try { console.log(line); } catch { /* logging never fails the caller */ } };
const opName = (name: string) => /^[a-zA-Z0-9_.:-]{1,80}$/u.test(name) ? name : 'unnamed';

/** Runs `work`; busy: `Shannon sqlite busy op=<name> action=skipped waitedMs=<n>` and `fallback` (the next pass does it). */
export function unlessBusy<T>(name: string, work: () => T, fallback: T): T {
  const started = Date.now();
  try { return work(); } catch (error) {
    if (!isSqliteBusy(error)) throw error;
    note(`Shannon sqlite busy op=${opName(name)} action=skipped waitedMs=${Date.now() - started}`);
    return fallback;
  }
}

/** A synchronous sleep for start-up retries (no event loop to yield to yet). */
const sleep = (milliseconds: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); };

/** Start-up work that must happen: tried again while busy, `startAttempts` times `startDelayMs` apart; the last error is thrown. */
export function retryWhileBusy<T>(name: string, work: () => T, limits: { startAttempts: number; startDelayMs: number } = SQLITE_BUSY_LIMITS): T {
  for (let attempt = 1; ; attempt += 1) {
    const started = Date.now();
    try { return work(); } catch (error) {
      if (!isSqliteBusy(error) || attempt >= limits.startAttempts) throw error;
      note(`Shannon sqlite busy op=${opName(name)} action=retry attempt=${attempt} waitedMs=${Date.now() - started}`);
      sleep(limits.startDelayMs);
    }
  }
}

/** The line a write lock waited for or held at least `slowMs` leaves: the time each way and the caller's first frame outside the store. */
export function sqliteContention(site: Error, waitedMs: number, heldMs: number): void {
  if (waitedMs < SQLITE_BUSY_LIMITS.slowMs && heldMs < SQLITE_BUSY_LIMITS.slowMs) return;
  const frame = (site.stack ?? '').split('\n').slice(1).map(line => line.trim()).find(line => !/sqliteStoreContext|sqliteBusy/u.test(line)) ?? '';
  const where = (/at ([^\s(]{1,120})/u.exec(frame)?.[1] ?? 'unknown').replace(/[^a-zA-Z0-9_.<>$-]/gu, '');
  note(`Shannon sqlite slow lock pid=${process.pid} op=${where} waitedMs=${waitedMs} heldMs=${heldMs}`);
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
