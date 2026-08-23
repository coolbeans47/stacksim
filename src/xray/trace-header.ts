import { randomBytes } from "node:crypto";

export const XRAY_TRACE_HEADER_MAX_LENGTH = 256;
export const TRACE_ID_PATTERN = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;
export const SEGMENT_ID_PATTERN = /^[0-9a-f]{16}$/;

export type SamplingDecision = "sampled" | "not-sampled" | "undecided";

export interface XRayTraceHeader {
  root?: string;
  parent?: string;
  decision: SamplingDecision;
  extras: Array<{ key: string; value: string }>;
  valid: boolean;
}

export type RandomBytesSource = (size: number) => Buffer;

export function generateTraceId(nowMs: number, bytes: RandomBytesSource = randomBytes): string {
  const epoch = Math.max(0, Math.floor(nowMs / 1000)).toString(16).padStart(8, "0").slice(-8);
  return `1-${epoch}-${bytes(12).toString("hex")}`;
}

export function generateSegmentId(bytes: RandomBytesSource = randomBytes): string {
  return bytes(8).toString("hex");
}

export function parseTraceHeader(value: string | string[] | undefined): XRayTraceHeader {
  const raw = Array.isArray(value) ? value.join(",") : value;
  const empty: XRayTraceHeader = { decision: "undecided", extras: [], valid: false };
  if (raw === undefined || raw === "") return { ...empty, valid: true };
  if (raw.length > XRAY_TRACE_HEADER_MAX_LENGTH || /[\r\n]/.test(raw)) return empty;
  const trusted = new Set<string>();
  const extras: Array<{ key: string; value: string }> = [];
  let root: string | undefined;
  let parent: string | undefined;
  let decision: SamplingDecision = "undecided";
  for (const component of raw.split(";")) {
    const index = component.indexOf("=");
    if (index <= 0) return empty;
    const key = component.slice(0, index).trim();
    const componentValue = component.slice(index + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key) || !componentValue || /[;\r\n]/.test(componentValue)) return empty;
    const normalized = key.toLowerCase();
    if (["root", "parent", "sampled"].includes(normalized)) {
      if (trusted.has(normalized)) return empty;
      trusted.add(normalized);
      if (normalized === "root") {
        if (!TRACE_ID_PATTERN.test(componentValue)) return empty;
        root = componentValue;
      } else if (normalized === "parent") {
        if (!SEGMENT_ID_PATTERN.test(componentValue)) return empty;
        parent = componentValue;
      } else {
        if (!new Set(["0", "1", "?"]).has(componentValue)) return empty;
        decision = componentValue === "1" ? "sampled" : componentValue === "0" ? "not-sampled" : "undecided";
      }
    } else extras.push({ key, value: componentValue });
  }
  return { ...(root ? { root } : {}), ...(parent ? { parent } : {}), decision, extras, valid: true };
}

export function formatTraceHeader(header: Pick<XRayTraceHeader, "root" | "parent" | "decision"> & { extras?: XRayTraceHeader["extras"] }): string {
  const components: string[] = [];
  if (header.root) components.push(`Root=${header.root}`);
  if (header.parent) components.push(`Parent=${header.parent}`);
  components.push(`Sampled=${header.decision === "sampled" ? "1" : header.decision === "not-sampled" ? "0" : "?"}`);
  for (const extra of header.extras ?? []) {
    const next = [...components, `${extra.key}=${extra.value}`].join(";");
    if (next.length > XRAY_TRACE_HEADER_MAX_LENGTH) break;
    components.push(`${extra.key}=${extra.value}`);
  }
  return components.join(";");
}

