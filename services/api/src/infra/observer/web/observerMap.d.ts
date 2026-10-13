import type { ObserverJson } from '../../../contracts/observerContract.js';
export type Role = 'input' | 'judgment' | 'action' | 'output' | 'memory' | 'own' | 'store';
export type BlockSpec = [id: string, label: string, process: string, role: Role];
export type ViewNodeSpec = [id: string, block: string, col: number, row: number, label: string, description: string, sources: string[], span?: number];
export type TargetNodeSpec = [id: string, block: string, col: number, row: number, label: string, description: string, input: string, output: string];
export type LinkSpec = [from: string, to: string, background?: boolean];
export const BLOCKS: BlockSpec[];
export const VIEW_NODES: ViewNodeSpec[];
export const VIEW_LINKS: LinkSpec[];
export const ROLES: Role[];
export const VIEW_INDEX: Map<string, ViewNodeSpec>;
export const BLOCK_INDEX: Map<string, BlockSpec>;
export function roleOf(id: string): Role;
export function viewNodeOf(node: string | undefined, input?: ObserverJson | unknown, output?: ObserverJson | unknown): string | null;
export function viewHandoff(event: { fromNode?: string; toNode?: string; input?: unknown; output?: unknown }): [string | null, string | null];
export const TARGET_BLOCKS: BlockSpec[];
export const TARGET_NODES: TargetNodeSpec[];
export const TARGET_LINKS: LinkSpec[];
export const TARGET_RUNS: { name: string; spans: [string, number, number, string?, [string, number, number][]?][] }[];
export interface Field { gloss: string; key: string; value: string }
export function dummyFields(text: string | undefined): Field[];
export function mergeFields(base: Field[], override: string | undefined): Field[];
export const NODE_W: number; export const NODE_H: number; export const PITCH_X: number; export const PITCH_Y: number; export const ORIGIN_X: number; export const ORIGIN_Y: number;
export interface Box { x: number; y: number; w: number; h: number }
export interface NodeBox extends Box { col: number; row: number; block: string }
export interface GridLayout { width: number; height: number; boxes: Map<string, NodeBox>; blocks: Map<string, Box> }
export function gridLayout(blocks: BlockSpec[], nodes: (ViewNodeSpec | TargetNodeSpec)[]): GridLayout;
export const CURRENT_LAYOUT: GridLayout;
export const TARGET_LAYOUT: GridLayout;
export type Curve = [[number, number], [number, number], [number, number], [number, number]];
export function edgeCurve(a: Box, b: Box, offset?: number): Curve;
export function bezierAt(points: Curve, t: number): [number, number];
export function curvePath(points: Curve): string;
export function routeTable(layout: GridLayout, links: LinkSpec[]): Map<string, { from: string; to: string; background: boolean; points: Curve }>;
export function blockRoutes(layout: GridLayout, links: LinkSpec[]): Map<string, { from: string; to: string; points: Curve }>;
