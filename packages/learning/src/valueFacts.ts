import { type ValueCell } from './valueTable.js';

/**
 * The value facts of her thinking prompt (Syzygy ADR-0008 stage 1, step 7a; `docs/cognition-ledger-contract.md`). Core:
 * purpose. Pure.
 *
 * 「これまでの手応え」: for the choices offered in this thought, what the active version of the value table holds for the moment
 * she is in, as facts the server counted. At most eight lines, in a fixed order, only for cells with at least one settled
 * choice, never at the root or family level (that would not be about the choice). Each line: the choice and the moment the cell
 * covers, V and its spread, the count, and the means of the parts, the cost included (recorded, not subtracted: owner override
 * 2). Facts only: no advice, no word of the owner's, no "so do this".
 */
export const VALUE_FACTS_HEADER = '[これまでの手応え]（サーバーが数えた事実）';
export const VALUE_FACTS_MAXIMUM_LINES = 8;

const REASONS = Object.freeze({ share: '面白かったことを伝えたい', wonder: 'いま何をしているか気になった', upcoming: '近い予定が気になった', saw: '見たことを話したい' });

/** The fixed order of the lines, and how each choice is named. A tool is named by its registry name, after these. */
export const VALUE_FACT_CHOICES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ...Object.entries(REASONS).map(([reason, label]) => [`reach_out.${reason}`, `話しかける・${label}`] as const),
  ...Object.entries(REASONS).map(([reason, label]) => [`call.${reason}`, `電話をかける・${label}`] as const),
  ['follow_up', 'もう一度話しかける'],
  ['show', '物語を見せる'],
  ['draft', '物語の下書きを書く'],
  ['revise', '物語を直す'],
  ['read', '公開ページを読む'],
  ['notion', 'Notionを読む'],
  ['note', 'メモを書く'],
  ['look', '部屋を見る'],
  ['jot', '書き留める'],
  ['copy', 'フォルダに写す'],
  ['put_away', '作品をしまう'],
] as const);

const BAND = Object.freeze<Record<string, string>>({ night: '夜', morning: '朝', afternoon: '昼', evening: '夕方' });
const PRESENCE = Object.freeze<Record<string, string>>({ alone: 'ひとり', away: 'ライ氏は離席', unknown: '様子不明', others: 'ほかの人がいる' });

const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
const fixed = (value: number) => value.toFixed(2);

/** The moment a cell covers, in words: （夜・ひとり）, （夜）, or nothing for the choice as a whole. */
function moment(cell: ValueCell): string {
  if (cell.level === 'presence') {
    const [band, presence] = cell.context.split('.');
    return `（${BAND[band ?? ''] ?? band}・${PRESENCE[presence ?? ''] ?? presence}）`;
  }
  return cell.level === 'band' ? `（${BAND[cell.context] ?? cell.context}）` : '';
}

/** The most specific cell of a choice in a context with at least one settled choice, below the family level; null when none. */
export function valueFactCell(cells: readonly ValueCell[], choice: string, context: string): ValueCell | null {
  const band = context.split('.')[0] ?? '';
  for (const [level, wanted] of [['presence', context], ['band', band], ['choice', '']] as const) {
    const cell = cells.find(item => item.level === level && item.choice === choice && item.context === wanted);
    if (cell && cell.n >= 1) return cell;
  }
  return null;
}

/** One line of fact. */
export function valueFactLine(label: string, cell: ValueCell): string {
  return `- ${label}${moment(cell)}: ${signed(cell.mean)} ±${fixed(Math.sqrt(Math.max(0, cell.uncertainty)))}`
    + `（${cell.n}回。世界${fixed(cell.world)}／ライ氏${fixed(cell.serve)}／成長${fixed(cell.growth)}／費用${Math.round(cell.costYen)}円）`;
}

/** The section for the choices offered, in the fixed order, or null when there is no fact to give. */
export function valueFactsSection(cells: readonly ValueCell[], offered: readonly string[], context: string): string | null {
  const wanted = new Set(offered);
  const named = [
    ...VALUE_FACT_CHOICES.filter(([choice]) => wanted.has(choice)),
    ...[...wanted].filter(choice => choice.startsWith('tool.')).sort().map(choice => [choice, `道具「${choice.slice('tool.'.length)}」を使う`] as const),
  ];
  const lines: string[] = [];
  for (const [choice, label] of named) {
    if (lines.length >= VALUE_FACTS_MAXIMUM_LINES) break;
    const cell = valueFactCell(cells, choice, context);
    if (cell) lines.push(valueFactLine(label, cell));
  }
  return lines.length ? [VALUE_FACTS_HEADER, ...lines].join('\n') : null;
}
