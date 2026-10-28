import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deployedRevision } from '../ops/deployedRevision.js';

/** The version of the running head: the revision the deployment wrote (`DEPLOYED_REVISION`), else the commit of the git checkout it runs from, else null. */
export interface HeadVersion { revision: string | null; source: 'DEPLOYED_REVISION' | 'git' | null; node: string }

/** The commit a checkout's HEAD names, read from the files (no process is started); null when there is none to read. */
export function gitHeadCommit(start: string): string | null {
  try {
    let directory = resolve(start);
    for (let depth = 0; depth < 6; depth += 1, directory = dirname(directory)) {
      const dot = join(directory, '.git');
      if (!existsSync(dot)) continue;
      const git = statSync(dot).isFile() ? readFileSync(dot, 'utf8').replace(/^gitdir:\s*/u, '').trim() : dot;
      const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40}$/u.test(head)) return head;
      const ref = head.replace(/^ref:\s*/u, '');
      const common = existsSync(join(git, 'commondir')) ? resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()) : git;
      for (const base of [git, common]) {
        if (existsSync(join(base, ref))) return readFileSync(join(base, ref), 'utf8').trim();
      }
      const packed = existsSync(join(common, 'packed-refs')) ? readFileSync(join(common, 'packed-refs'), 'utf8') : '';
      return packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
    }
  } catch { /* a version that cannot be read is null */ }
  return null;
}

export function headVersion(directory = process.cwd()): HeadVersion {
  const deployed = deployedRevision(join(directory, 'DEPLOYED_REVISION'));
  if (deployed) return { revision: deployed, source: 'DEPLOYED_REVISION', node: process.version };
  const commit = gitHeadCommit(directory);
  return { revision: commit, source: commit ? 'git' : null, node: process.version };
}

/** The first 12 hex digits of the SHA-256 of a text: the hash a prompt part is named by in a record's version. */
export function partHash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 12); }

const toolName = (tool: unknown, index: number) => String((tool as { name?: unknown } | null)?.name ?? `#${index}`);

/** The hashes of the parts of a request's prompt: each system block, the tools as a whole and each tool's definition. */
export function promptVersion(system: unknown, tools: unknown): { system: string[]; tools: string | null; toolDefinitions: Record<string, string> } {
  const blocks = Array.isArray(system) ? system : typeof system === 'string' ? [system] : [];
  const text = (block: unknown) => typeof block === 'string' ? block : (block as { text?: unknown } | null)?.text;
  const list = Array.isArray(tools) ? tools : [];
  return { system: blocks.map(block => partHash(typeof text(block) === 'string' ? String(text(block)) : JSON.stringify(block))),
    tools: list.length ? partHash(JSON.stringify(list)) : null,
    toolDefinitions: Object.fromEntries(list.map((tool, index) => [toolName(tool, index), partHash(JSON.stringify(tool))])) };
}
