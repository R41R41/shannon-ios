/** Whether the owner is in a voice call with her elsewhere, as the body and the apps are told it (Syzygy ADR-0008 stage 3, S3: the wire shape, moved unchanged out of `ownerCallElsewhere.ts`). */
export type OwnerCallSurface = 'ios' | 'mac';

export interface OwnerCallElsewhere { active: boolean; since?: string; surface?: OwnerCallSurface }
