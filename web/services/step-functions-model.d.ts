export interface DefinitionState { name: string; state: Record<string, any>; path: string }
export interface DefinitionScope { path: string; label: string; kind: string; slot?: number; startAt?: string; states: DefinitionState[] }
export interface StudioStateType { type: string; label: string; hint: string; glyph: string }
export interface StudioFlowNode { name: string; type: string; start: boolean; end: boolean; summary: string; state: Record<string, any> }
export interface StudioFlowEdge { from: string; to: string; label?: string }
export function parseStateMachineDefinition(definition: unknown): Record<string, any> | null;
export function definitionScopes(definition: unknown): DefinitionScope[];
export function lambdaReferences(definition: unknown): Array<{ name: string; resource: string; stateName: string; scope: string }>;
export function integrationReferences(definition: unknown): Array<{ service: string; target: unknown; href: string | null; resource: string; stateName: string; scope: string; callback: boolean; sync: boolean }>;
export function eventDetails(event: any): { key: string | null; value: Record<string, any> };
export function historyPresentation(events: any[], status: string): { events: any[]; active: { stateName: string; eventId: number; type: string } | null };
export function executionPresentation(definition: unknown, events: any[], status: string): { scopes: DefinitionScope[]; history: ReturnType<typeof historyPresentation>; retries: any[]; failures: any[]; iterations: any[] };
export function payloadField(details: Record<string, any>, name: string): { state: "present" | "omitted" | "absent"; value: unknown };
export const STUDIO_STATE_TYPES: StudioStateType[];
export function defaultStateForType(type: string): Record<string, any>;
export function uniqueStateName(states: Record<string, any>, preferred?: string): string;
export function addStudioState(definition: unknown, type: string, options?: { afterName?: string; preferredName?: string }): { definition: Record<string, any>; name: string };
export function removeStudioState(definition: unknown, name: string): Record<string, any>;
export function renameStudioState(definition: unknown, from: string, to: string): Record<string, any>;
export function updateStudioState(definition: unknown, name: string, patch?: Record<string, any>): Record<string, any>;
export function setStudioStartAt(definition: unknown, name: string): Record<string, any>;
export function studioFlow(definition: unknown): { startAt: string | null; nodes: StudioFlowNode[]; edges: StudioFlowEdge[]; orphans: string[] };
