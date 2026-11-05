export interface DefinitionState { name: string; state: Record<string, any>; path: string }
export interface DefinitionScope { path: string; label: string; kind: string; slot?: number; startAt?: string; states: DefinitionState[] }
export interface StudioStateType { type: string; label: string; hint: string; glyph: string }
export interface StudioFlowNode { name: string; type: string; start: boolean; end: boolean; summary: string; state: Record<string, any> }
export interface StudioFlowEdge { from: string; to: string; label?: string }
export function cloudFormationOrigin(tags?: Array<{ key: string; value: string }>): { stackId: string; stackName: string; logicalId: string; href: string } | null;
export function executionRoleLink(roleArn: unknown): string | null;
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
export function addStudioState(definition: unknown, type: string, options?: { afterName?: string; preferredName?: string; state?: Record<string, any> }): { definition: Record<string, any>; name: string };
export function removeStudioState(definition: unknown, name: string): Record<string, any>;
export function renameStudioState(definition: unknown, from: string, to: string): Record<string, any>;
export function updateStudioState(definition: unknown, name: string, patch?: Record<string, any>): Record<string, any>;
export function setStudioStartAt(definition: unknown, name: string): Record<string, any>;
export function studioFlow(definition: unknown): { startAt: string | null; nodes: StudioFlowNode[]; edges: StudioFlowEdge[]; orphans: string[] };
export interface StudioAction { id: string; group: string; label: string; name: string; hint: string; glyph: string; state: () => Record<string, any> }
export interface StateVisit { enteredId: number; enteredAt?: number; exitedId?: number; exitedAt?: number; input: ReturnType<typeof payloadField>; output: ReturnType<typeof payloadField>; lastOutcome: "failure" | "success" | null; error?: string; cause?: string }
export interface StateResult { name: string; type: string; state: Record<string, any>; scopePath: string; scopeLabel: string; resource: string; events: any[]; visits: StateVisit[]; status: "NOT_STARTED" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CAUGHT_ERROR" | "CANCELLED"; waitingForCallback: boolean; startedAfter?: number; duration?: number; error?: string; cause?: string }
export interface Tag { key: string; value: string }
export function resourceNameProblem(name: unknown, label?: string): string | null;
export function stateNameProblem(name: unknown): string | null;
export function epochMilliseconds(value: unknown): number | undefined;
export function formatElapsed(milliseconds: number | undefined | null): string;
export function formatDuration(start: unknown, stop?: unknown, now?: number): string;
export function formatTimestamp(value: unknown): string;
export function displayLabel(value: unknown): string;
export function statusVariant(value: unknown): "error" | "pending" | "success" | "inactive";
export function stateResourceLabel(state: Record<string, any> | undefined): string;
export function stateResults(model: ReturnType<typeof executionPresentation>, execution?: { status?: string; startDate?: unknown; stopDate?: unknown }): Map<string, StateResult>;
export function stateTransitionCount(model: ReturnType<typeof executionPresentation>): number;
export const STUDIO_ACTIONS: StudioAction[];
export const STUDIO_FLOW_TYPES: StudioStateType[];
export const BLANK_DEFINITION: Record<string, any>;
export const HELLO_WORLD_DEFINITION: Record<string, any>;
export const HELLO_WORLD_INPUT: Record<string, any>;
export function executionRoleStatements(definition: unknown): Array<{ Effect: "Allow"; Action: string[]; Resource: string[] }>;
export function executionRoleTrustPolicy(): { Version: string; Statement: Array<Record<string, any>> };
export function generatedRoleName(machineName: unknown, suffix?: string): string;
export function tagsToRows(tags?: Tag[]): Tag[];
export function rowsToTags(rows?: Array<Partial<Tag>>): { tags?: Tag[]; problem?: string };
export function tagChanges(current?: Tag[], next?: Tag[]): { changed: Tag[]; removed: string[] };
