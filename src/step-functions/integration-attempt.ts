import { createHash } from "node:crypto";
import type { ServiceIntegrationAttemptState } from "../types.js";

export interface ServiceIntegrationAttempt {
  attemptId: string;
  inputDigest: string;
  operation: string;
  targetArn: string;
  executionArn: string;
  stateMachineArn: string;
  roleArn: string;
  sourceArn: string;
  lineage: string[];
}

export function integrationInputDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function acceptedIntegrationAttempt(attempt: ServiceIntegrationAttempt, output: unknown, acceptedAt: number): ServiceIntegrationAttemptState {
  return { ...attempt, lineage: attempt.lineage.slice(-32), status: "ACCEPTED", acceptedAt, output: structuredClone(output) };
}

export function integrationOutputDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertMatchingIntegrationAttempt(receipt: ServiceIntegrationAttemptState, attempt: ServiceIntegrationAttempt): void {
  if (receipt.inputDigest !== attempt.inputDigest || receipt.operation !== attempt.operation || receipt.targetArn !== attempt.targetArn || receipt.executionArn !== attempt.executionArn || receipt.roleArn !== attempt.roleArn) {
    throw new Error(`Integration attempt identity ${attempt.attemptId} was reused with different immutable metadata`);
  }
}
