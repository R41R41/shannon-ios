import { InMemoryCompanionStateStore, type CompanionClock, type CompanionStateStore } from '@shannon/cognition';
import { emotionTiming } from '../mind/emotion/emotionTiming.js';
import { ShannonApiKernel as Kernel, type ShannonApiKernelOptions } from '../infra/http/apiKernel.js';
import { createInMemoryAutonomyService } from './autonomyServiceWiring.js';
export type { ShannonApiKernelOptions } from '../infra/http/apiKernel.js';

/** Kernel construction supplies the default autonomy stores; the request kernel only receives their interface. */
export class ShannonApiKernel extends Kernel {
  constructor(stateStore: CompanionStateStore, now: CompanionClock, options: ShannonApiKernelOptions = {}) {
    super(stateStore,now,{ createAutonomy: createInMemoryAutonomyService, ...options });
  }
}
export function createLocalApiKernel(now: CompanionClock = () => new Date().toISOString(), options: ShannonApiKernelOptions = {}): ShannonApiKernel {
  return new ShannonApiKernel(options.stateStore ?? new InMemoryCompanionStateStore(now, emotionTiming()), now, options);
}
