import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';

/** Resolves an absolute path to where it really points, or null when that cannot be established. */
export type AutonomyPathResolver = (path: string) => string | null;

/**
 * Physical resolution for the policy gate: every existing component is replaced by its
 * real location, so a symbolic link inside Shannon's folder that points elsewhere is
 * judged by its target, and `..` is applied to the real parent rather than the spelled
 * one. Components that do not exist yet cannot be links and are appended as written.
 * A relative path, an empty path, or one containing NUL is not resolvable.
 */
export const resolvePhysicalPath: AutonomyPathResolver = (path) => {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) return null;
  const { root } = parse(path);
  let current = root;
  // A backslash separates components only where the platform says so; elsewhere it is part of a name.
  for (const segment of path.slice(root.length).split(sep === '\\' ? /[\\/]+/u : /\/+/u)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, segment);
    try {
      // Checked for every component: after `missing/..` the walk is back among real entries.
      lstatSync(candidate);
    } catch {
      current = candidate;
      continue;
    }
    try {
      current = realpathSync.native(candidate);
    } catch {
      // A dangling link or an unreadable component: where it leads is unknown.
      return null;
    }
  }
  return current;
};

/** True when `path` is `root` or lies below it. Both must already be resolved. */
export function isInsideResolvedRoot(root: string, path: string, options: { ignoreCase?: boolean } = {}): boolean {
  const base = options.ignoreCase ? root.toLowerCase() : root;
  const target = options.ignoreCase ? path.toLowerCase() : path;
  if (target === base) return true;
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/** The path of `path` relative to `root`, with `/` separators, or null when it is outside. */
export function relativeToResolvedRoot(root: string, path: string): string | null {
  if (!isInsideResolvedRoot(root, path, { ignoreCase: true })) return null;
  return path.slice(root.length).split(sep).filter(Boolean).join('/');
}

