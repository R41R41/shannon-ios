import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The file the deployment writes in the working directory, holding the deployed revision. */
export const DEPLOYED_REVISION_FILE = 'DEPLOYED_REVISION';
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u;

/** The first word of the file the deployment writes, when it looks like a revision; otherwise null. */
export function deployedRevision(path = resolve(process.cwd(), DEPLOYED_REVISION_FILE)): string | null {
  try {
    const word = readFileSync(path, 'utf8').trim().split(/\s+/u)[0] ?? '';
    return REVISION.test(word) ? word : null;
  } catch {
    return null;
  }
}
