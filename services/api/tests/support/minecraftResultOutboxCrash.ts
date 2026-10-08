import { MinecraftBodyRequests } from '../../src/surfaces/minecraft/minecraftBodyRequests.js';
import { SQLiteGameExperiences } from '../../src/mind/memory/store/gameExperiences.js';

// A credentialless child stages the two crash windows after the canonical request commit.
const [path, requestId, mode] = process.argv.slice(2);
if (!path || !requestId || !['before_write', 'after_write'].includes(mode ?? '')) throw new Error('INVALID_FIXTURE');
const experiences = new SQLiteGameExperiences(path);
const requests = new MinecraftBodyRequests(path, { deviceId: 'fixture-body', ownerScopeKey: 'owner' },
  () => '2026-10-08T00:00:00.000Z', {
    write(scope, experience) {
      if (mode === 'after_write') experiences.write(scope, experience);
      process.kill(process.pid, 'SIGKILL');
      throw new Error('UNREACHABLE');
    },
  });
requests.report('owner', 'fixture-body', requestId, { outcome: 'done', gained: [{ item: 'oak_log', count: 16 }] });
throw new Error('CRASH_WINDOW_NOT_REACHED');
