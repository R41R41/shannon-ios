import { keyNoiseVolatility, noteInnovation, type Cause, type KeyState, type PredictionDomainSpec } from '@shannon/cognition';
import { ROOT_VALUE, choiceFamily, type ValueRead } from './reward.js';

/**
 * The value table (Syzygy ADR-0008 stage 1, 価値表; `docs/cognition-ledger-contract.md`). Core: emotion. Pure.
 *
 * What a choice in a kind of moment has been worth to her, as a Gaussian per cell, learned from her settled choices with the
 * Kalman update of ADR-0006 (k = U′/(U′ + N), U′ = U + volatility·Δt in days), noise and volatility estimated per cell from its
 * own innovations as a prediction key's are (`keyNoiseVolatility`), held toward its parent's.
 *
 * Cells sit on levels so that similar moments share what was learned (data is scarce: ADR-0008 Consequences):
 * root → family (`reach_out`) → choice (`reach_out.wonder`) → choice × band → choice × band × presence. A new cell starts from
 * its parent's mean with the spread between its siblings plus their own uncertainty (the law of total variance); with fewer
 * than three siblings, from the variance of the reward's scale (1/3 on [−1, 1]). The root starts at mean 0, variance 1/3.
 * V is read from the most specific cell with at least one outcome. The same settled choices in the same order give the same
 * table: a version is a fold of its evidence.
 */
const DAY = 24 * 60 * 60_000;
export const VALUE_SCALE_VARIANCE = 1 / 3;
export const VALUE_LEVELS = ['root', 'family', 'choice', 'band', 'presence'] as const;
export type ValueLevel = typeof VALUE_LEVELS[number];

/** The reward's scale as a prediction domain, for the noise and volatility estimate (not one the prediction layer folds). */
const REWARD_SPEC: PredictionDomainSpec = Object.freeze({ family: 'gaussian', lower: -1, upper: 1, valence: false, features: Object.freeze([]) });
/** The root's noise and volatility before any outcome: the scale's variance, spread over a month for the volatility (assumption). */
const ROOT_SPREAD = Object.freeze({ noise: VALUE_SCALE_VARIANCE, volatility: VALUE_SCALE_VARIANCE / 30 });

export interface ValueCell {
  level: ValueLevel;
  /** The family name at the family level, the choice below it, empty at the root. */
  choice: string;
  /** The band at the band level, `band.presence` at the presence level, empty above. */
  context: string;
  n: number;
  mean: number;
  uncertainty: number;
  noise: number;
  volatility: number;
  lastAt: number | null;
  /** Means of the parts of the rewards it learned from. */
  world: number;
  serve: number;
  growth: number;
  costYen: number;
}

/** A settled choice as the table learns from it. */
export interface ValueEvidence {
  choice: string;
  /** `<band>.<presence>`. */
  context: string;
  reward: number;
  world: number;
  serve: number;
  growth: number;
  costYen: number;
  settledAt: string;
}

interface Working { cell: ValueCell; key: KeyState }
export interface ValueTable { cells: Map<string, Working> }

const cellKey = (level: ValueLevel, choice: string, context: string) => `${level}|${choice}|${context}`;

/** The cells a choice in a context reads and teaches, from the root down. */
export function valuePath(choice: string, context: string): Array<{ level: ValueLevel; choice: string; context: string }> {
  const band = context.split('.')[0] ?? '';
  return [
    { level: 'root', choice: '', context: '' },
    { level: 'family', choice: choiceFamily(choice), context: '' },
    { level: 'choice', choice, context: '' },
    { level: 'band', choice, context: band },
    { level: 'presence', choice, context },
  ];
}

export function createValueTable(): ValueTable {
  return { cells: new Map() };
}

function emptyKey(): KeyState {
  return { causes: [], count: 0, moments: [0, 0, 0, 0, 0], pending: null, regression: { xx: [[0]], xy: [0], n: 0 } };
}

function sampleVariance(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

/** A new cell from its parent: the parent's mean, the siblings' spread (or the scale's while there are fewer than three). */
function newCell(table: ValueTable, path: { level: ValueLevel; choice: string; context: string }, parent: ValueCell | null): Working {
  const siblings = parent ? [...table.cells.values()].map(item => item.cell).filter(cell => cell.level === path.level && cell.n > 0 && isChildOf(cell, parent)) : [];
  const spread = siblings.length >= 3
    ? Math.min(VALUE_SCALE_VARIANCE, sampleVariance(siblings.map(cell => cell.mean)) + siblings.reduce((sum, cell) => sum + cell.uncertainty, 0) / siblings.length)
    : VALUE_SCALE_VARIANCE;
  return {
    cell: {
      ...path, n: 0, mean: parent?.mean ?? ROOT_VALUE.mean, uncertainty: Math.max(1e-9, spread), noise: parent?.noise ?? ROOT_SPREAD.noise,
      volatility: parent?.volatility ?? ROOT_SPREAD.volatility, lastAt: null, world: 0, serve: 0, growth: 0, costYen: 0,
    },
    key: emptyKey(),
  };
}

function isChildOf(cell: ValueCell, parent: ValueCell): boolean {
  switch (cell.level) {
    case 'family': return parent.level === 'root';
    case 'choice': return parent.level === 'family' && choiceFamily(cell.choice) === parent.choice;
    case 'band': return parent.level === 'choice' && cell.choice === parent.choice;
    case 'presence': return parent.level === 'band' && cell.choice === parent.choice && cell.context.split('.')[0] === parent.context;
    default: return false;
  }
}

/** Learns one settled choice (in place) on every cell of its path. Choices must come in the order they were settled. */
export function learnValue(table: ValueTable, evidence: ValueEvidence): void {
  const at = Date.parse(evidence.settledAt);
  const time = Number.isFinite(at) ? at : 0;
  const reward = Math.min(1, Math.max(-1, evidence.reward));
  // Every cell of the path exists before any learns, so a new cell starts from its parent as it was before this outcome.
  let parent: ValueCell | null = null;
  const working: Working[] = [];
  for (const path of valuePath(evidence.choice, evidence.context)) {
    const id = cellKey(path.level, path.choice, path.context);
    let item = table.cells.get(id);
    if (!item) { item = newCell(table, path, parent); table.cells.set(id, item); }
    working.push(item);
    parent = item.cell;
  }
  let above: ValueCell | null = null;
  for (const item of working) {
    const cell = item.cell;
    const elapsed = cell.lastAt === null ? 0 : Math.max(0, time - cell.lastAt) / DAY;
    const prior = above ? { noise: above.noise, volatility: above.volatility } : ROOT_SPREAD;
    const { noise, volatility } = keyNoiseVolatility(item.key, REWARD_SPEC, prior);
    const cause: Cause = { mean: cell.mean, variance: cell.uncertainty, strength: 0, count: cell.n, lastAt: cell.lastAt ?? time, times: [], contexts: {} };
    noteInnovation(item.key, REWARD_SPEC, cause, reward, time);
    item.key.count += 1;
    const widened = Math.min(VALUE_SCALE_VARIANCE, cell.uncertainty + volatility * elapsed);
    const gain = widened / (widened + noise);
    const n = cell.n + 1;
    item.cell = {
      ...cell, n, mean: cell.mean + gain * (reward - cell.mean), uncertainty: Math.max(1e-9, (1 - gain) * widened), noise, volatility, lastAt: time,
      world: cell.world + (evidence.world - cell.world) / n, serve: cell.serve + (evidence.serve - cell.serve) / n,
      growth: cell.growth + (evidence.growth - cell.growth) / n, costYen: cell.costYen + (evidence.costYen - cell.costYen) / n,
    };
    above = item.cell;
  }
}

export function foldValues(evidence: readonly ValueEvidence[]): ValueTable {
  const table = createValueTable();
  for (const item of evidence) learnValue(table, item);
  return table;
}

/** The cells, in a fixed order (by level, then choice, then context): what a version stores. */
export function valueCells(table: ValueTable): ValueCell[] {
  return [...table.cells.values()].map(item => item.cell)
    .sort((left, right) => VALUE_LEVELS.indexOf(left.level) - VALUE_LEVELS.indexOf(right.level) || left.choice.localeCompare(right.choice) || left.context.localeCompare(right.context));
}

/** V of a choice in a context from stored cells: the most specific cell with at least one outcome; the root prior otherwise. */
export function valueOf(cells: readonly ValueCell[], choice: string, context: string, version: string): ValueRead {
  const byKey = new Map(cells.map(cell => [cellKey(cell.level, cell.choice, cell.context), cell]));
  for (const path of [...valuePath(choice, context)].reverse()) {
    const cell = byKey.get(cellKey(path.level, path.choice, path.context));
    if (cell && cell.n >= 1) return { mean: cell.mean, variance: cell.uncertainty, noise: cell.noise, level: cell.level, version, n: cell.n };
  }
  return { ...ROOT_VALUE, version };
}
