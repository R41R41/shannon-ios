/**
 * The eval process may reach only Anthropic's API (the live model, the judge, the simulator) and, while its key is set, Jev
 * (owner decision 2026-10-13; the origin of `SHANNON_JEV_ENDPOINT` or Jev's default). Every other host — the weather API, a real
 * web page, the owner's Aether, Voyager or Notion — is refused, so a trial can only read its recorded fixtures and can never
 * touch the owner's data. A request body that asks Anthropic for its own server-side web tools is counted: such a read bypasses
 * the fixtures, so the grader fails the trial for it unless the task allows it (`nativeWebSearch: 'allowed'`).
 */
const ALLOWED_ORIGINS = new Set(['https://api.anthropic.com']);
let installed = false;
export const networkLog = { refused: [] as string[], nativeWebRequests: 0 };

export function installNetworkGuard(extraOrigins: readonly string[] = []): void {
  if (installed) return;
  installed = true;
  for (const origin of extraOrigins) ALLOWED_ORIGINS.add(origin);
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!ALLOWED_ORIGINS.has(url.origin)) {
      networkLog.refused.push(url.origin);
      throw new TypeError(`EVAL_NETWORK_REFUSED ${url.origin}`);
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    if (/"type"\s*:\s*"web_(search|fetch)_\d+"/u.test(body)) networkLog.nativeWebRequests += 1;
    return real(input, init);
  }) as typeof fetch;
}
