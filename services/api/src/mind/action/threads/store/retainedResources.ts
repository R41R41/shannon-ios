/**
 * The resources an action keeps excluding others from after its unknown slot is released (ADR-0009 §9, stage 1), until a
 * release proof: the original canonical report that closes the action, or a domain proof through `reconcileResource`.
 * - An anchor is held on its own: an Agent Host lock (`agent-host`) or the Minecraft body, also when it is a base resource.
 * - A companion is held only while an anchor of the same action is: the folder lock an Agent Host task takes with its host.
 *   The same folder lock taken by a folder tool alone has no proof and is released with the slot, as before.
 * Keys are the hashed `res:<sha256>` names of `actionResource`; this module only compares them.
 */
export interface RetainedResourcePolicy {
  readonly anchors: ReadonlySet<string>;
  readonly companions: ReadonlySet<string>;
}

export function retainedResource(policy: RetainedResourcePolicy, resource: string, resources: readonly string[]): boolean {
  if (policy.anchors.has(resource)) return true;
  if (!policy.companions.has(resource)) return false;
  return resources.some(key => policy.anchors.has(key));
}
