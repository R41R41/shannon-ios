export const NODE_SPECS: [string, number, number, string, string, string][];
export const LANES: string[];
export const LINKS: [string, string, boolean?][];
export const ROUTES: Record<string, { label: string; nodes: string[] | null }>;
export function circuitFor(node: string): string;
export function routeIncludes(route: string, from: string, to?: string): boolean;
export interface MapBox { x: number; y: number; w: number; h: number; row: number; col: number; }
export interface MapZone { x: number; y: number; w: number; h: number; label: string; }
export interface MapLayout { width: number; height: number; pitch: number; boxes: Map<string, MapBox>; zones: MapZone[]; }
export function mapLayout(width: number): MapLayout;
export interface MapRoute { points: [number, number][]; path: string; }
export function roundedMapPath(points: [number, number][]): string;
export function createMapRouter(layout: MapLayout, links?: [string, string, boolean?][]): { route(from: string, to: string): MapRoute | null; reset(): void };
