import { defineConfig } from 'vitest/config';

// Several tests run many store-backed cases in one test. On a loaded machine (the release
// verification, the small production VM) the default five seconds is not a statement about
// the code. A real hang still fails, only later.
export default defineConfig({ test: { testTimeout: 30_000 } });
