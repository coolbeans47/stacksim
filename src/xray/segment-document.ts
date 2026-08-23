import { createHash } from "node:crypto";
import { AwsError } from "../errors.js";
import type { CanonicalSegment } from "./model.js";
import { SEGMENT_ID_PATTERN, TRACE_ID_PATTERN } from "./trace-header.js";

export const MAX_SEGMENT_DOCUMENT_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const MAX_VALUES = 10_000;
const MAX_ANNOTATIONS = 50;

function invalid(message: string): never { throw new AwsError("InvalidRequestException", message, 400); }

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stable((value as any)[key])}`).join(",")}}`;
}

function inspectBounds(value: unknown, depth = 0, counter = { values: 0 }): void {
  if (++counter.values > MAX_VALUES) invalid("Segment document contains too many values");
  if (depth > MAX_DEPTH) invalid("Segment document nesting exceeds 32 levels");
  if (typeof value === "string" && Buffer.byteLength(value) > MAX_SEGMENT_DOCUMENT_BYTES) invalid("Segment document contains an overlong string");
  if (typeof value === "number" && !Number.isFinite(value)) invalid("Segment document numbers must be finite");
  if (Array.isArray(value)) for (const item of value) inspectBounds(item, depth + 1, counter);
  else if (value && typeof value === "object") for (const item of Object.values(value)) inspectBounds(item, depth + 1, counter);
}

function scalarAnnotations(input: unknown): Record<string, string | number | boolean> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("annotations must be an object");
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_ANNOTATIONS) break;
    if (!key || key.length > 500 || !["string", "number", "boolean"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) invalid("annotations must contain finite scalar values");
    output[key] = value as string | number | boolean;
  }
  return output;
}

function validateEmbeddedSubsegments(value: unknown, parentId: string, traceId: string, edges: CanonicalSegment["edges"]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) invalid("subsegments must be an array");
  for (const subsegment of value) {
    if (!subsegment || typeof subsegment !== "object" || Array.isArray(subsegment)) invalid("subsegment must be an object");
    if (!SEGMENT_ID_PATTERN.test(String((subsegment as any).id ?? ""))) invalid("subsegment id must contain 16 lowercase hexadecimal characters");
    if (typeof (subsegment as any).name !== "string" || !(subsegment as any).name) invalid("subsegment name is required");
    const start = Number((subsegment as any).start_time); const end = Number((subsegment as any).end_time);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end < start) invalid("subsegment timestamps are invalid");
    edges.push({ sourceId: parentId, destinationId: (subsegment as any).id });
    validateEmbeddedSubsegments((subsegment as any).subsegments, (subsegment as any).id, traceId, edges);
  }
}

export function validateSegmentDocument(document: string): CanonicalSegment {
  if (typeof document !== "string") invalid("TraceSegmentDocuments entries must be strings");
  const size = Buffer.byteLength(document);
  if (!size || size > MAX_SEGMENT_DOCUMENT_BYTES) invalid("Segment document must be between 1 byte and 64 KiB");
  let input: any;
  try { input = JSON.parse(document); } catch { invalid("Segment document is not valid JSON"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Segment document must be a JSON object");
  inspectBounds(input);
  if (!TRACE_ID_PATTERN.test(String(input.trace_id ?? ""))) invalid("trace_id must use the canonical X-Ray format");
  if (!SEGMENT_ID_PATTERN.test(String(input.id ?? ""))) invalid("id must contain 16 lowercase hexadecimal characters");
  if (typeof input.name !== "string" || !input.name || input.name.length > 200) invalid("name is required and must not exceed 200 characters");
  const startTime = Number(input.start_time);
  if (!Number.isFinite(startTime) || startTime < 0) invalid("start_time must be a non-negative finite number");
  const inProgress = input.in_progress === true;
  const endTime = input.end_time === undefined ? undefined : Number(input.end_time);
  if (!inProgress && endTime === undefined) invalid("A completed segment requires end_time");
  if (endTime !== undefined && (!Number.isFinite(endTime) || endTime < startTime)) invalid("end_time must be finite and no earlier than start_time");
  const kind = input.type === "subsegment" ? "subsegment" : "segment";
  const parentId = input.parent_id === undefined ? undefined : String(input.parent_id);
  if (kind === "subsegment" && !SEGMENT_ID_PATTERN.test(parentId ?? "")) invalid("An independent subsegment requires a valid parent_id");
  if (input.type !== undefined && input.type !== "subsegment") invalid("type must be subsegment when supplied");
  const responseStatus = input.http?.response?.status === undefined ? undefined : Number(input.http.response.status);
  if (responseStatus !== undefined && (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599)) invalid("HTTP response status is invalid");
  const edges: CanonicalSegment["edges"] = [];
  if (parentId) edges.push({ sourceId: parentId, destinationId: input.id });
  validateEmbeddedSubsegments(input.subsegments, input.id, input.trace_id, edges);
  const canonical = stable(input);
  return {
    traceId: input.trace_id, segmentId: input.id, ...(parentId ? { parentId } : {}), kind, name: input.name,
    startTime, ...(endTime === undefined ? {} : { endTime }), inProgress, origin: typeof input.origin === "string" ? input.origin : undefined,
    resourceArn: typeof input.resource_arn === "string" ? input.resource_arn : undefined, ...(responseStatus === undefined ? {} : { responseStatus }),
    error: input.error === true || responseStatus !== undefined && responseStatus >= 400 && responseStatus < 500,
    fault: input.fault === true || responseStatus !== undefined && responseStatus >= 500,
    throttle: input.throttle === true || responseStatus === 429,
    annotations: scalarAnnotations(input.annotations), edges, document,
    canonicalHash: createHash("sha256").update(canonical).digest("hex"),
  };
}

