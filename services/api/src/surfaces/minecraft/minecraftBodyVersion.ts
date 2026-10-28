import { createHash } from 'node:crypto';
import type { MadeIn } from '../../contracts/continueContract.js';
import type { MinecraftControl } from './minecraftControl.js';
import { bodyRunOf, lifeViewOf } from './minecraftMadeIn.js';

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
 * Continue contract 8: the body says its own version in the poll (`bodyVersion`: its revision and the hash of its catalog); that is what the record names, and the head's own
 * hash of the catalog is kept beside it only for a body that does not send one. `observed` is not a version: it names the frame the request stands on (the frame the
 * decision read, `read`, else the newest one: its life, number and time) and the recorder takes it out to number the request's row (`TraceIds`).
 */
export function minecraftBodyVersion(control: Pick<MinecraftControl, 'frame'>, bodyId: string, read?: MadeIn | null): Record<string, unknown> {
  const poll = control.frame(bodyId)?.poll;
  if (!poll) return { bodyId, connected: false };
  const skills = poll.skills ?? [], found: Record<string, string | number> = {};
  reported(poll.observation.state, 'state', 0, found);
  reported(poll.observation.facts, 'facts', 0, found);
  const own = poll.bodyVersion, observation = poll.observation, life = lifeViewOf(observation), run = bodyRunOf(observation);
  const sameFrame = !read || read.obsSeq === observation.sequence;
  const observed = read ? { life: read.life, obsSeq: read.obsSeq, bodyBoot: read.bodyBoot, headBoot: read.headBoot, ...(sameFrame ? { obsAt: observation.stateAt } : {}) }
    : life ? { life: life.life, obsSeq: observation.sequence, ...(run ? { bodyBoot: run.bodyBoot } : {}), obsAt: observation.stateAt } : undefined;
  return { bodyId, connected: true, serverId: poll.serverId, connectionId: poll.connectionId, pollSchema: poll.schemaVersion,
    ...(own ? { revision: own.revision, catalogHash: own.catalogHash } : {}),
    catalog: own?.catalogHash ?? (skills.length ? createHash('sha256').update(JSON.stringify(skills)).digest('hex').slice(0, 12) : null), catalogSource: own ? 'body' : 'head',
    skills: skills.map(skill => skill.name).sort(), reported: found, ...(observed ? { observed } : {}) };
}
