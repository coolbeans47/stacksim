import type { ServerlessPolicy } from "./serverless-policies.js";

export interface ServerlessCollection {
  id: string;
  name: string;
  arn: string;
  accountId: string;
  region: string;
  generation: string;
  gatewayPort: number;
  status: "CREATING" | "ACTIVE" | "DELETING" | "FAILED";
  type: "SEARCH" | "TIMESERIES" | "VECTORSEARCH";
  collectionGroupName?: string;
  description: string;
  standbyReplicas: "ENABLED" | "DISABLED";
  deletionProtection: "ENABLED" | "DISABLED";
  encryptionPolicy?: string;
  encryptionConfig?: { aWSOwnedKey: true };
  createdDate: number;
  lastModifiedDate: number;
  tags: Record<string, string>;
  storageReady?: boolean;
  failureMessage?: string;
  owner?: string;
}
export interface ServerlessState {
  ingestionStreams?: Record<string, import('./serverless-streams.js').ServerlessStream>;
  ingestionJobs?: Record<string, import('./serverless-ingestion.js').ServerlessIngestionJob>;
  collections: Record<string, ServerlessCollection>;
  policies: Record<string, ServerlessPolicy | import("./serverless-retention.js").RetentionPolicy>;
  groups?: Record<string, ServerlessGroup>;
  policyOwners?: Record<string, string>;
  retiredPorts: number[];
  capacityLimits: { maxIndexingCapacityInOCU: number; maxSearchCapacityInOCU: number };
  tokens: Record<string, { fingerprint: string; response: any; expires: number }>;
  cursorKey: string;
}
export interface ServerlessGroup {
  id: string; arn: string; name: string; description: string; createdDate: number; lastModifiedDate: number;
  standbyReplicas: "ENABLED" | "DISABLED";
  generation: import("./serverless-capacity.js").ServerlessGeneration;
  capacityLimits: import("./serverless-capacity.js").GroupLimits;
  tags: Record<string, string>;
  owner?: string;
}

export function aossArn(region: string, account: string, resource: string): string {
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  return `arn:${partition}:aoss:${region}:${account}:${resource}`;
}
