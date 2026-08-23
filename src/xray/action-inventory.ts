export const XRY_01_ACTIONS = Object.freeze({
  "/TraceSegments": "PutTraceSegments",
  "/TraceSummaries": "GetTraceSummaries",
  "/Traces": "BatchGetTraces",
  "/ServiceGraph": "GetServiceGraph",
  "/TraceGraph": "GetTraceGraph",
} as const);

export type XRay01Operation = (typeof XRY_01_ACTIONS)[keyof typeof XRY_01_ACTIONS];

export function xrayOperation(pathname: string, method = "POST"): XRay01Operation | undefined {
  if (method !== "POST") return undefined;
  return XRY_01_ACTIONS[pathname as keyof typeof XRY_01_ACTIONS];
}

