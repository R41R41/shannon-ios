/**
 * The server's environment, read in one place (Syzygy ADR-0008 §10: structural refactoring as an exit criterion of each stage;
 * the folder rule `environment-in-config` of `scripts/api-layers.json`). `process.env` is read only here, in `wiring/` and in the
 * entry files; every other module takes its settings as a parameter whose default is `serverEnvironment()`.
 *
 * It returns the live `process.env` object at each call, exactly what a default of `= process.env` gave before (a test that
 * stubs a variable is seen at once), so moving a read here changes nothing.
 */
export type ServerEnvironment = Readonly<Record<string, string | undefined>>;

/** The environment of this process, as a read-only record of its variables. */
export function serverEnvironment(): ServerEnvironment {
  return process.env;
}

/** The environment of this process as Node types it, for a child process that inherits it (`spawn`'s `env`). */
export function processEnvironment(): NodeJS.ProcessEnv {
  return process.env;
}
