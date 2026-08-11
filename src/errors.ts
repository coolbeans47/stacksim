import type { ServerResponse } from "node:http";

export class AwsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function sendAwsError(res: ServerResponse, error: unknown, protocol: "json" | "rest" = "json", namespace = "com.amazonaws.dynamodb.v20120810#"): void {
  const awsError = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  res.statusCode = awsError.status;
  if (awsError.details?.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(awsError.details.retryAfterSeconds));
  res.setHeader("content-type", protocol === "json" ? "application/x-amz-json-1.0" : "application/json");
  res.end(JSON.stringify(protocol === "json"
    ? { __type: `${namespace}${awsError.code}`, message: awsError.message, ...awsError.details }
    : { message: awsError.message, __type: awsError.code, ...awsError.details }));
}
