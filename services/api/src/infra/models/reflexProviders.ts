import type { ReflexEntrySelector, ReflexSelector } from '../../mind/action/reflex/reflexPorts.js';
import type { JevChooser } from './jev/jevChoice.js';
import { JevReflexEntrySelector, JevReflexSelector } from './jev/jevReflex.js';
import { OpenAIReflexSelector, type OpenAIReflexOptions } from './openAIReflexSelector.js';
import { ReflexProviderSerial } from './reflexContext.js';
export type { OpenAIReflexOptions, ReflexDecisionUsage } from './openAIReflexSelector.js';

/** Explicit wiring seam. Default OFF creates no client, image load, model call, or background loop. */
export function createReflexProviders(options: { enabled?: boolean; jev?: Pick<JevChooser, 'decide'> | null; decisions?: OpenAIReflexOptions }):
  { entry: ReflexEntrySelector | null; avatar: ReflexSelector | null; image: ReflexSelector | null } | null {
  if (options.enabled !== true) return null;
  const serial = new ReflexProviderSerial();
  return { entry: options.jev ? new JevReflexEntrySelector(options.jev, serial) : null,
    avatar: options.jev ? new JevReflexSelector(options.jev, serial) : null,
    image: options.decisions ? new OpenAIReflexSelector(options.decisions, serial) : null };
}
