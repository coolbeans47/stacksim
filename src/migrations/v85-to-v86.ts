import type { SimState } from "../types.js";

/**
 * DUG-12 migrates DynamoDB import/export jobs onto resumable stages.
 * Pre-existing COMPLETED/FAILED jobs keep their terminal status.
 * Legacy IN_PROGRESS jobs without stages are marked FAILED so startup never
 * blindly promotes unfinished work.
 */
export function migrateV85ToV86(input: SimState): SimState {
  const state = structuredClone(input);
  for (const account of Object.values(state.accounts ?? {})) {
    for (const region of Object.values(account.regions ?? {})) {
      for (const job of Object.values(region.dynamodbExports ?? {})) {
        if (job.stage) continue;
        const file = typeof job.s3Bucket === "string" && job.s3Bucket.startsWith("file://");
        job.destinationKind = file ? "file" : "s3";
        if (job.exportStatus === "COMPLETED") job.stage = "COMPLETED";
        else if (job.exportStatus === "FAILED") job.stage = "FAILED";
        else {
          job.exportStatus = "FAILED";
          job.stage = "FAILED";
          job.endTime ??= Date.now();
          job.failureCode ??= "MigrationInterrupted";
          job.failureMessage ??= "An in-progress export from a previous schema could not be resumed safely";
        }
      }
      for (const job of Object.values(region.dynamodbImports ?? {})) {
        if (job.stage) continue;
        const file = typeof job.s3BucketSource?.S3Bucket === "string" && job.s3BucketSource.S3Bucket.startsWith("file://");
        job.destinationKind = file ? "file" : "s3";
        if (job.importStatus === "COMPLETED") job.stage = "COMPLETED";
        else if (job.importStatus === "FAILED") job.stage = "FAILED";
        else {
          job.importStatus = "FAILED";
          job.stage = "FAILED";
          job.endTime ??= Date.now();
          job.failureCode ??= "MigrationInterrupted";
          job.failureMessage ??= "An in-progress import from a previous schema could not be resumed safely";
        }
      }
    }
  }
  state.schemaVersion = 86;
  return state;
}
