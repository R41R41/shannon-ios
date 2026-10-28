import { createHash } from 'node:crypto';
import type { MinecraftControl } from './minecraftControl.js';

const VERSION_KEY = /version|revision|build|commit|dist|release/iu;

/** The fields of a body's state whose names say they are a version (a string or a number, short), by their path; two levels deep at most. */
function reported(value: unknown, path: string, depth: number, found: Record<string, string | number>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return;
  for (const [key, item] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    if (VERSION_KEY.test(key) && key !== 'schemaVersion' && (typeof item === 'number' || typeof item === 'string' && item.length <= 80)) found[where] = item;
    else reported(item, where, depth + 1, found);
  }
}

/**
 * What the head can see of the body's version, for the decision records: which connection and server it is, a hash of its skill catalog (it
 * changes whenever the deployed body's tools change), and any field of its observation that names itself a version, revision, build or commit.
 * The head is told no commit by the body; this is the part of it that can be read.
 */
export function minecraftBodyVersion(control: Pick<MinecraftControl, 'frame'>, bodyId: string): Record<string, unknown> {
  const poll = control.frame(bodyId)?.poll;
  if (!poll) return { bodyId, connected: false };
  const skills = poll.skills ?? [], found: Record<string, string | number> = {};
  reported(poll.observation.state, 'state', 0, found);
  reported(poll.observation.facts, 'facts', 0, found);
  return { bodyId, connected: true, serverId: poll.serverId, connectionId: poll.connectionId, pollSchema: poll.schemaVersion,
    catalog: skills.length ? createHash('sha256').update(JSON.stringify(skills)).digest('hex').slice(0, 12) : null,
    skills: skills.map(skill => skill.name).sort(), reported: found };
}
