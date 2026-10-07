import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The install's secret salt (review, low): kept beside the database on the server (`.shannon-install-salt`, mode 0600), never in
 * the repository. It salts the digest of a Jev input in the decision traces (`h`), so a turn's words cannot be confirmed by
 * hashing guesses. A salt that cannot be read or written is one for this process (digests then link within a run only).
 */
export function installSalt(databasePath: string | null): string {
  if (!databasePath || databasePath === ':memory:') return randomBytes(16).toString('hex');
  const path = join(dirname(databasePath), '.shannon-install-salt');
  try {
    if (existsSync(path)) {
      const salt = readFileSync(path, 'utf8').trim();
      if (/^[0-9a-f]{32,}$/u.test(salt)) return salt;
    }
    const salt = randomBytes(32).toString('hex');
    writeFileSync(path, `${salt}\n`, { mode: 0o600, flag: 'w' });
    chmodSync(path, 0o600);
    return salt;
  } catch { return randomBytes(16).toString('hex'); }
}
