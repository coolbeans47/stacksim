import type { PolicyDocument } from "../types.js";

export interface DomainChange {
  id: string;
  state: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  config: Record<string, any>;
  properties: string[];
  startedAt: number;
  updatedAt: number;
  revision: number;
  securityMaterial?: { id: string; version: number };
  failure?: string;
  encryptedReady?: boolean;
}
export interface DomainDryRun {
  id: string;
  state: "PROCESSING" | "COMPLETED";
  config: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  deployment: string;
}

export interface DomainRecord {
  name: string;
  arn: string;
  accountId: string;
  region: string;
  generation: string;
  config: Record<string, any>;
  tags: Record<string, string>;
  state: "creating" | "active" | "deleting" | "failed";
  createdAt: number;
  updatedAt: number;
  revision: number;
  gatewayPort: number;
  storageReady?: boolean;
  securityMaterial?: { id: string; version: number };
  retiredSecurityMaterials?: string[];
  changes?: DomainChange[];
  dryRuns?: DomainDryRun[];
  maintenances?: DomainMaintenance[];
  maintenanceCursorKey?: string;
  automaticBackups?: import("./automatic-backups.js").AutomaticBackupState;
  insights?: import("./insights.js").DomainInsight[];
  logDeliveryFailures?: Record<string, { count: number; at: number; message: string }>;
  failure?: string;
  owner?: string;
}

export interface DomainMaintenance {
  id: string;
  action: "REBOOT_NODE" | "RESTART_SEARCH_PROCESS";
  state: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "TIMED_OUT";
  createdAt: number;
  updatedAt: number;
  message: string;
}

export interface OpenSearchRegionState {
  domains: Record<string, DomainRecord>;
  retiredPorts: number[];
  serverless?: import("./serverless-model.js").ServerlessState;
  ingestion?: import("./ingestion/model.js").IngestionState;
  packages?: import("./packages.js").PackageCatalog;
  applications?: import("./applications.js").ApplicationCatalog;
  connections?: import("./connections.js").ConnectionCatalog;
  directQueries?: import("./direct-query.js").DirectQueryCatalog;
  insightCursorKey?: string;
}

export function domainArn(region: string, accountId: string, name: string): string {
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  return `arn:${partition}:es:${region}:${accountId}:domain/${name}`;
}

export function domainPolicy(domain: DomainRecord): PolicyDocument | undefined {
  return domain.config.AccessPolicies ? JSON.parse(domain.config.AccessPolicies) as PolicyDocument : undefined;
}
