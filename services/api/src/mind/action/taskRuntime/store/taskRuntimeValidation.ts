export const taskRuntimeLimits = { depth: 8, children: 64, activeTasks: 256, text: 16_000, historyBytes: 1_000_000 };
export function bounded(value: string, maximum: number, code: string, empty = false): void {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum) throw new Error(`FCA_${code}`);
}
export function json(value: unknown): string {
  const result = JSON.stringify(value); if (result === undefined) throw new Error('FCA_JSON'); return result;
}
