/**
 * A count of the writes that change what an already-remembered id stands for without a companion-state version: a task's or a touch's
 * experience row rewritten in place (sources added, time moved), a knowledge document grown or retired, a voice summary replaced or
 * removed. The FCA source guard (`fcaConversationSources.ts`) records it with each walked base and uses the base only while it is
 * unchanged, so a base of 30 s never rests on provenance that was edited after its walk. One API process writes all of them.
 */
let edits = 0;
export function noteProvenanceEdit(): void { edits += 1; }
export function provenanceEdits(): number { return edits; }
