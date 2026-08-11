import { readFile } from "node:fs/promises";
import { join } from "node:path";

const projectRoot = join(import.meta.dirname, "..");
const outputsFile = join(projectRoot, ".runtime", "outputs.json");

export const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-west-1";
export const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

export function clientOptions() {
  return {
    region,
    ...(endpoint ? { endpoint } : {}),
  };
}

export async function deployedOutputs() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(outputsFile, "utf8"));
  } catch {
    throw new Error("Deployment outputs are missing. Run npm run deploy first.");
  }
  const outputs = parsed.S3LambdaNotificationAuditStack;
  if (!outputs?.BucketName || !outputs?.AuditTableName) throw new Error("Deployment outputs do not contain BucketName and AuditTableName.");
  return outputs;
}
