/**
 * The eval's clock port: the process wall clock shifted so that it reads the task's local time when a trial starts, and then
 * runs at real speed (deadlines, expiries and leases keep their meaning). Only `Date.now()`, `new Date()` and `Date()` move;
 * `performance.now()` and timers are untouched, so the latencies the graders read stay real.
 *
 * Installed once per eval process (`installEvalClock`), never in the server.
 */
const RealDate = Date;
let offsetMilliseconds = 0;
let installed = false;

export function installEvalClock(): void {
  if (installed) return;
  installed = true;
  const shifted = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [RealDate.now() + offsetMilliseconds], newTarget);
    },
    apply() { return new RealDate(RealDate.now() + offsetMilliseconds).toString(); },
    get(target, property, receiver) {
      if (property === 'now') return () => RealDate.now() + offsetMilliseconds;
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = shifted as DateConstructor;
}

/** `YYYY-MM-DDTHH:mm` in `timeZone` as an instant (whole minutes; the zones the suite uses have fixed offsets). */
export function localInstant(local: string, timeZone = 'Asia/Tokyo'): number {
  const guess = RealDate.parse(`${local.length === 10 ? `${local}T00:00` : local}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).formatToParts(new RealDate(guess));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const asLocal = RealDate.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (asLocal - guess);
}

/** Moves the clock so that it reads `local` now. */
export function setEvalClock(local: string, timeZone = 'Asia/Tokyo'): void {
  offsetMilliseconds = localInstant(local, timeZone) - RealDate.now();
}

export function resetEvalClock(): void { offsetMilliseconds = 0; }

/** Puts the real `Date` back (tests that install the clock inside a shared worker). */
export function uninstallEvalClock(): void {
  offsetMilliseconds = 0;
  if (!installed) return;
  globalThis.Date = RealDate;
  installed = false;
}

/** An instant as the owner's local `YYYY-MM-DDTHH:mm`. */
export function localOf(instant: string | number, timeZone = 'Asia/Tokyo'): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).formatToParts(new RealDate(instant));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
