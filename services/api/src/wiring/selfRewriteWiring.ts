import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { coreAreaForRepositoryPath } from '../mind/inhibition/autonomyCore.js';
import { isInsideResolvedRoot, relativeToResolvedRoot, resolvePhysicalPath } from '../mind/inhibition/autonomyPaths.js';
import { SelfRewriteService, selfRewriteContentHash } from '../mind/inhibition/selfRewriteService.js';
import { SelfRewriteStore } from '../mind/inhibition/store/selfRewriteStore.js';
import type { SelfRewriteCandidate, SelfRewriteChecks, SelfRewriteSnapshot, SelfRewriteTargets } from '../mind/inhibition/selfRewritePorts.js';
import { selfRewriteRoute } from '../mind/inhibition/selfRewriteRoutes.js';

export interface SelfRewritePlaces {
  isolatedRoot: string | null; repositoryRoots: readonly string[];
  productionRoots: readonly string[]; protectedPaths: readonly string[];
}
export interface SelfRewriteWiringOptions {
  enabled: boolean; path: string; ownerScope: string; now: () => string; places: SelfRewritePlaces;
  checks: Pick<SelfRewriteChecks, 'authority' | 'control' | 'budgetAndRights' | 'currentBase' | 'tests' | 'safetyDiff'>;
  /** An already approved existing executor, if present. No core/production default writer exists. */
  approvedExecutor?: SelfRewriteChecks['apply'];
  /** Durable provenance metadata, after every gate and before the isolated writer touches a file. */
  beforeIsolatedWrite?: (candidate: SelfRewriteCandidate, targets: SelfRewriteTargets) => Promise<boolean>;
  /** Only the process lifecycle that owns execution may recover interrupted work. Readers leave active steps alone. */
  recoverInterrupted?: boolean;
}
export function selfRewriteWiring(options: SelfRewriteWiringOptions) {
  if (!options.enabled) return { service: null, route: selfRewriteRoute(null, options.ownerScope, options.now), close: () => {} };
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(options.path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  if (options.path !== ':memory:') chmodSync(options.path, 0o600);
  const store = new SelfRewriteStore(database);
  if (options.recoverInterrupted !== false) store.recoverInterrupted(options.now());
  const service = new SelfRewriteService(store, { ...options.checks,
    targets: candidate => selfRewriteTargets(candidate, options.places),
    snapshot: candidate => selfRewriteSnapshot(candidate),
    apply: async (candidate, targets, permit) => {
      if (targets.approvalRequired) return options.approvedExecutor ? options.approvedExecutor(candidate, targets, permit) : 'failed';
      if (options.beforeIsolatedWrite && !await options.beforeIsolatedWrite(candidate, targets)) return 'failed';
      return applyIsolatedRewrite(candidate, targets, options.places, permit);
    },
  }, options.now);
  return { service, route: selfRewriteRoute(service, options.ownerScope, options.now), close: () => database.close() };
}
export function selfRewriteTargets(candidate: SelfRewriteCandidate, places: SelfRewritePlaces): SelfRewriteTargets | null {
  const root = places.isolatedRoot ? resolvePhysicalPath(places.isolatedRoot) : null;
  const repositories = places.repositoryRoots.map(resolvePhysicalPath);
  const production = places.productionRoots.map(resolvePhysicalPath);
  const protectedPaths = places.protectedPaths.map(resolvePhysicalPath);
  if (repositories.some(value => !value) || production.some(value => !value) || protectedPaths.some(value => !value)) return null;
  const paths = candidate.files.map(file => resolvePhysicalPath(file.path));
  if (paths.some(value => !value) || new Set(paths).size !== paths.length) return null;
  const resolved = paths as string[];
  const isolated = !!root && resolved.every(path => path !== root && isInsideResolvedRoot(root, path));
  const approvalRequired = !isolated || resolved.some(path => [...production, ...protectedPaths].some(base => isInsideResolvedRoot(base!, path, { ignoreCase: true }))
    || repositories.some(base => {
      const relative = relativeToResolvedRoot(base!, path); return relative !== null && !!coreAreaForRepositoryPath(relative);
    }));
  return { paths: resolved, isolated, approvalRequired };
}
export async function selfRewriteSnapshot(candidate: SelfRewriteCandidate): Promise<SelfRewriteSnapshot | null> {
  return readRewriteSnapshot(candidate);
}
function readRewriteSnapshot(candidate: SelfRewriteCandidate): SelfRewriteSnapshot | null {
  const hashes: Record<string, string | null> = {};
  try {
    for (const file of candidate.files) {
      const path = resolvePhysicalPath(file.path); if (!path) return null;
      if (!existsSync(path)) { hashes[file.path] = null; continue; }
      const stat = lstatSync(path); if (!stat.isFile() || stat.size > 1_000_000) return null;
      hashes[file.path] = selfRewriteContentHash(readFileSync(path, 'utf8'));
    }
    return { id: randomUUID(), hashes };
  } catch { return null; }
}
/** Called only from an existing permitted step, and restricted to the isolated non-core workspace. */
export async function applyIsolatedRewrite(candidate: SelfRewriteCandidate, targets: SelfRewriteTargets,
  places: SelfRewritePlaces, permit: () => Promise<boolean>): Promise<'completed' | 'failed' | 'unknown'> {
  let wrote = false;
  try {
    for (const [index, file] of candidate.files.entries()) {
      if (!await permit()) return wrote ? 'unknown' : 'failed';
      const fresh = selfRewriteTargets(candidate, places);
      if (!fresh?.isolated || fresh.approvalRequired || JSON.stringify(fresh) !== JSON.stringify(targets)) return wrote ? 'unknown' : 'failed';
      const path = fresh.paths[index]!;
      const snapshot = await selfRewriteSnapshot({ ...candidate, files: [file] });
      if (!snapshot || snapshot.hashes[file.path] !== file.beforeHash) return wrote ? 'unknown' : 'failed';
      // No asynchronous gap remains between the last live permit, physical check, and this one write.
      if (!await permit()) return wrote ? 'unknown' : 'failed';
      const immediate = selfRewriteTargets(candidate, places);
      if (!immediate || JSON.stringify(immediate) !== JSON.stringify(fresh)) return wrote ? 'unknown' : 'failed';
      const preimage = readRewriteSnapshot({ ...candidate, files: [file] });
      if (!preimage || preimage.hashes[file.path] !== file.beforeHash) return wrote ? 'unknown' : 'failed';
      if (file.content === null) { if (existsSync(path)) { rmSync(path); wrote = true; } }
      else {
        // Require an already-existing physical parent; never create a path outside the verified workspace.
        if (!existsSync(dirname(path)) || !lstatSync(dirname(path)).isDirectory()) return wrote ? 'unknown' : 'failed';
        const temporary = join(dirname(path), `.shannon-rewrite-${randomUUID()}`);
        const mode = existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600;
        let temporaryCreated = false;
        try {
          const fileHandle = openSync(temporary, 'wx', 0o600); temporaryCreated = true;
          try {
            writeFileSync(fileHandle, file.content);
            // Creation modes are masked by umask; set the original permissions on our descriptor before publishing.
            fchmodSync(fileHandle, mode); fsyncSync(fileHandle);
          } finally { closeSync(fileHandle); }
          renameSync(temporary, path); wrote = true;
          const directoryHandle = openSync(dirname(path), 'r'); try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
        }
        finally { if (temporaryCreated && existsSync(temporary)) rmSync(temporary); }
      }
    }
    return 'completed';
  } catch { return wrote ? 'unknown' : 'failed'; }
}
