import type { ActPos, ACT_CONTRACT_VERSION } from './minecraftActTypes.js';
import type { WorldScan } from './minecraftProbeContract.js';

export interface ViewInput {
  /** Default: her feet. */
  center?: ActPos;
  /** Blocks out from the centre (1–32, default 12). */
  radius?: number;
  /** Absolute y bounds (default: centre −4 … +4; `top` ignores them). */
  yFrom?: number;
  yTo?: number;
  /** layers: one grid per y; top: the surface from above with heights; slice: a vertical cut through the centre;
   * column: the x,z column. */
  mode: 'layers' | 'top' | 'slice' | 'column';
  /** slice: north–south (ns, rows are y, columns z) or east–west (ew, columns x). Default ns. */
  axis?: 'ns' | 'ew';
  /** Show only these (block names or map symbols); everything else solid is `#`, passable `.`. At most 8. */
  only?: readonly string[];
}

export interface ViewResult {
  v: typeof ACT_CONTRACT_VERSION;
  /** The map text (format below). Past 6,000 cells the body draws `top` with each cell 2×2 and says so in the header. */
  map: string;
  /** Up to 12 landmark lines inside the view (same form as `world.mapLandmarks`). */
  landmarks?: readonly string[];
}

/** The world fields the body adds to every frame while MINEBOT_LLM_CENTRIC is on (`observation.state.world`). */
export interface LlmCentricWorld {
  /** The map of this frame (format below): redrawn when she moved a block or a block in it changed, at most every 500 ms. */
  localMap?: string;
  /**
   * Off-map landmarks, at most 12 lines: `記号 名前 (x,y,z) 方角距離・上下 注記`, nearest and most useful first. Only places of the dimension
   * she is in (run 26: an overworld crafting table read as 3 m away in the Nether); a place of another dimension,
   * when worth saying (the
   * gate back, her base), starts with that dimension in brackets and gives no distance: `[overworld] T 作業台 (10,35,15) 拠点`.
   */
  mapLandmarks?: readonly string[];
  /** The structure she is in or beside (run 26): `ネザー要塞の中`, `砦の遺跡（bastion）の脇`, `ストロングホールドの中`, `村の中`, `エンドシティ`; absent: none. */
  inside?: string;
  /** The recent stops, at most 5 lines, newest first: `(x,y,z)→(x,y,z) 理由 ×回数 N秒前`. Counted by the body, never acted on by it. */
  recentStops?: readonly string[];
  /** The hidden food saturation (0–20). */
  saturation?: number;
  /** r4: the body's own `scan` at a spawn, a new dimension or a respawn (`WorldScan`, `minecraftProbeContract.ts`);
   * absent until the first. */
  scan?: WorldScan;
}
