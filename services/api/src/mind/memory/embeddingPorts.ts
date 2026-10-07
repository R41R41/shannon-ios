/**
 * The embeddings window of the memory part (Syzygy ADR-0008 §6 and §10; stage 3, S2): the similarity of two embeddings, moved
 * out of the embeddings store, for recall. Kept apart from `memoryPorts.ts` so that recall loads nothing more than it did.
 */
export { cosineSimilarity } from './embeddingMath.js';
