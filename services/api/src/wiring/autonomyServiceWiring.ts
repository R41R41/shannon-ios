import { configuredAutonomy } from '../mind/inhibition/inhibitionPorts.js';
import { ShannonAutonomyService, type AutonomyServiceDependencies } from '../mind/action/ownTime/autonomyService.js';
import { createAutonomyStore } from './autonomyStoreWiring.js';

/** A service over a private in-memory database, off, for tests and local runs. */
export function createInMemoryAutonomyService(now: () => string, overrides: Partial<AutonomyServiceDependencies> = {}): ShannonAutonomyService {
  return new ShannonAutonomyService({
    store: createAutonomyStore(':memory:'), config: configuredAutonomy({}), now, ...overrides,
  });
}
