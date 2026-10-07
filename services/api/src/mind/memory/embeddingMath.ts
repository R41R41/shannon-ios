/** The similarity of two embeddings (Syzygy ADR-0008 stage 3, S2: moved unchanged out of the embeddings store). */

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return Number.isFinite(dot) ? dot : 0;
}
