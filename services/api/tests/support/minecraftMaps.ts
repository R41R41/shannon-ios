/** Maps drawn as the LLM-centric contract draws them (`minecraftActContract.ts`), for tests. */
/** A layers map as the contract draws it: 15×15 cells, 5 layers. */
export function layersMap(origin = { x: 201, y: 45, z: 277 }): string {
  const header = `地図 v1 足=(${origin.x},${origin.y},${origin.z}) x=${origin.x - 7}..${origin.x + 7} z=${origin.z - 7}..${origin.z + 7} 方式=layers 上=北`;
  const columns = `z\\x ${Array.from({ length: 15 }, (_, i) => String(Math.abs(origin.x - 7 + i) % 10)).join(' ')}`;
  const layers = [2, 1, 0, -1, -2].flatMap(dy => [`y=${origin.y + dy}`, columns, ...Array.from({ length: 15 }, (_, row) => {
    const cells = Array.from({ length: 15 }, (_, col) => dy === 0 && row === 7 && col === 7 ? '@' : dy === 0 && row === 7 ? (col < 7 ? '~' : '*')
      : dy > 0 ? (col % 4 === 0 ? '#' : '.') : (col + row) % 7 === 0 ? 'i' : '#');
    return `${origin.z - 7 + row} ${cells.join(' ')}`;
  })]);
  return [header, ...layers].join('\n');
}
