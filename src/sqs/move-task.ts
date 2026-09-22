import type { PrincipalContext } from "../auth/sigv4.js";

export const SQS_MOVE_ACTIONS = ["StartMessageMoveTask", "ListMessageMoveTasks", "CancelMessageMoveTask"] as const;
export interface SqsMoveCaller {
  principal: Omit<PrincipalContext, "accessKeyId" | "sessionToken">;
  context: Record<string, unknown>;
  sessionFingerprint?: string;
}
export interface SqsMoveTask {
  TaskHandle: string;
  SourceArn: string;
  DestinationArn?: string;
  MaxNumberOfMessagesPerSecond?: number;
  Status: "RUNNING" | "CANCELLING" | "CANCELLED" | "COMPLETED" | "FAILED";
  StartedTimestamp: number;
  ApproximateNumberOfMessagesMoved: number;
  ApproximateNumberOfMessagesToMove: number;
  FailureReason?: string;
  endedAt?: number;
  nextMoveAt: number;
  leaseUntil?: number;
  caller?: SqsMoveCaller;
}

/** This is routing information only. Cancellation also requires an exact persisted handle. */
export function moveTaskSource(handle: unknown): string {
  if (typeof handle !== "string" || handle.length > 2048) return "";
  try {
    const value = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
    return typeof value.sourceArn === "string" && typeof value.taskId === "string" ? value.sourceArn : "";
  } catch { return ""; }
}
