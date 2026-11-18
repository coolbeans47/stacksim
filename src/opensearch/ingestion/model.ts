import type { IngestionConfig } from "./config.js";
export interface PipelineLogOptions { IsLoggingEnabled: boolean; CloudWatchLogDestination?: { LogGroup: string } }
export type PipelineStatus = "CREATING" | "ACTIVE" | "UPDATING" | "DELETING" | "CREATE_FAILED" | "UPDATE_FAILED" | "STARTING" | "START_FAILED" | "STOPPING" | "STOPPED";
export interface PipelineRecord {
  name: string; arn: string; accountId: string; region: string; generation: string; gatewayPort: number;
  status: PipelineStatus; failure?: string; config: IngestionConfig; configurationBody: string;
  minUnits: number; maxUnits: number; persistentBuffer: boolean; createdAt: number; updatedAt: number;
  tags: Record<string, string>; storageReady?: boolean; owner?: string;
  logPublishingOptions?: PipelineLogOptions;
  logDeliveryFailure?: { count: number; at: number; message: string };
  sourceRunId?: string;
  changes: Array<{ startedAt: number; updatedAt: number; operation: string; status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED"; message?: string }>;
}
export interface IngestionState { pipelines: Record<string, PipelineRecord>; retiredPorts: number[]; cursorKey: string }
export function pipelineArn(region: string, accountId: string, name: string): string { const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws"; return `arn:${partition}:osis:${region}:${accountId}:pipeline/${name}`; }
