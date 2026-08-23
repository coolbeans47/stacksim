export type XRayRepositoryHealthStatus = "ready" | "degraded" | "corrupt" | "key-unavailable" | "migration-required" | "capacity-limited";

export interface XRayRepositoryHealth {
  status: XRayRepositoryHealthStatus;
  traceCount: number;
  segmentCount: number;
  rejectedCount: number;
  oldestTraceTime?: number;
  newestTraceTime?: number;
  lastCleanupAt?: number;
  errors: string[];
}

export interface CanonicalSegment {
  traceId: string;
  segmentId: string;
  parentId?: string;
  kind: "segment" | "subsegment";
  name: string;
  startTime: number;
  endTime?: number;
  inProgress: boolean;
  origin?: string;
  resourceArn?: string;
  responseStatus?: number;
  error: boolean;
  fault: boolean;
  throttle: boolean;
  annotations: Record<string, string | number | boolean>;
  edges: Array<{ sourceId: string; destinationId: string }>;
  document: string;
  canonicalHash: string;
}

export interface StoredTraceSummary {
  traceId: string;
  startTime: number;
  endTime: number;
  duration: number;
  rootService: string;
  responseStatus?: number;
  error: boolean;
  fault: boolean;
  throttle: boolean;
  annotations: Record<string, Array<{ AnnotationValue: { StringValue?: string; NumberValue?: number; BooleanValue?: boolean }; ServiceIds: Array<{ Name: string; Type?: string; AccountId?: string }> }>>;
}

export interface StoredTrace {
  id: string;
  duration: number;
  limitExceeded: boolean;
  segments: Array<{ id: string; document: string }>;
}

export interface XRayPage<T> {
  items: T[];
  nextPosition?: number;
}

export interface XRayStoreOptions {
  retentionMs?: number;
  maximumTraces?: number;
  maximumSegments?: number;
  maximumDocumentBytes?: number;
  cleanupBatchSize?: number;
}

