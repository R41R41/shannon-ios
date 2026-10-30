import { PLAN_TREE_SCHEMA, PLAN_TREE_SCHEMA_V1 } from './planTreeTypes.js';
import type { PlanKind, PlanPrep, PlanNode, PlanTree } from './planTreeTypes.js';

/** The v1 tree: no kinds, no preparation states, no promises. */
export interface PlanTreeV1 {
  schema: typeof PLAN_TREE_SCHEMA_V1;
  revision: number;
  current: string | null;
  nodes: readonly PlanNode[];
}

export const OLD_SKIPPED = '準備を省いた';

/**
 * The one place where a title is read for its kind: a v1 tree held no kind, so each node gets the kind its title (and `doneWhen`) said to the code that
 * used to read them (chapter 7, table 1-15). The note `準備を省いた…` that the v1 head wrote becomes `prep.state: skipped`; a done preparation node
 * becomes `met`. The revision goes up by one. A tree that is already v2 is returned as it is.
 */
export function migratePlanTree(tree: PlanTreeV1 | PlanTree): PlanTree {
  if (tree.schema === PLAN_TREE_SCHEMA) return tree;
  const nodes = tree.nodes.map((node) => {
    const kind = kindFromV1(node);
    const skipped = node.state === 'done' && (node.note ?? '').startsWith(OLD_SKIPPED);
    const prep: PlanPrep | undefined = skipped
      ? { state: 'skipped' }
      : kind === 'prep_descent' && node.state === 'done'
        ? { state: 'met' }
        : undefined;
    return { ...node, kind, ...(prep ? { prep } : {}) } as PlanNode;
  });
  return { schema: PLAN_TREE_SCHEMA, revision: tree.revision + 1, current: tree.current, nodes, promises: [] };
}

export function kindFromV1(node: PlanNode): PlanKind {
  const title = node.title,
    done = node.doneWhen ?? '';
  const food = /food>=(\d{1,4})/u.exec(done.replace(/\s+/gu, '').toLowerCase())?.[1];
  const titleKind1 = V1_TITLE_KINDS_1.find(([pattern]) => pattern.test(title))?.[1];
  if (titleKind1) return titleKind1;
  if (/地下の準備|下る準備|下りる準備/u.test(title) || (food !== undefined && Number(food) >= 40 && Number(food) < 100))
    return 'prep_descent';
  const titleKind2 = V1_TITLE_KINDS_2.find(([pattern]) => pattern.test(title))?.[1];
  if (titleKind2) return titleKind2;
  if (/鉄/u.test(title) || /iron_ingot|raw_iron/u.test(done)) return 'iron';
  if (/食料|食べ物|狩|肉|ホグリン|パン/u.test(title) || food !== undefined) return 'food';
  const titleKind3 = V1_TITLE_KINDS_3.find(([pattern]) => pattern.test(title))?.[1];
  if (titleKind3) return titleKind3;
  return 'other';
}

const V1_TITLE_KINDS_1: readonly (readonly [RegExp, PlanKind])[] = [
  [/ドラゴン|エンドラ/u, 'dragon'],
  [/ストロングホールド/u, 'stronghold'],
  [/パール|アイ/u, 'pearl'],
  [/エンド(?!ウ)|三角|ポータルの部屋/u, 'end'],
];

const V1_TITLE_KINDS_2: readonly (readonly [RegExp, PlanKind])[] = [
  [/ゲート|ポータル|ネザーに入|金のブーツ/u, 'portal'],
  [/黒曜石|火打/u, 'obsidian'],
  [/要塞/u, 'fortress'],
  [/ブレイズ/u, 'blaze'],
  [/ネザー/u, 'nether'],
  [/ダイヤ/u, 'diamond'],
  [/鉄の防具|鉄装備/u, 'iron_armor'],
];

const V1_TITLE_KINDS_3: readonly (readonly [RegExp, PlanKind])[] = [
  [/箱|樽|チェスト|chest|barrel/iu, 'chest'],
  [/ベッド/u, 'bed'],
  [/村/u, 'village'],
  [/石のツルハシ|石の道具|石器/u, 'stone_tools'],
  [/溶岩/u, 'lava'],
  [/水/u, 'water'],
  [/原木|木/u, 'wood'],
];
