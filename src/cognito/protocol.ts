import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "../errors.js";
import { readBody } from "../util.js";

export const COGNITO_MAX_REQUEST_BYTES = 1024 * 1024;

export async function parseCognitoJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-amz-json-1.1") {
    throw new AwsError("SerializationException", "The request content type must be application/x-amz-json-1.1.");
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > COGNITO_MAX_REQUEST_BYTES) {
    throw new AwsError("InvalidParameterException", "The request body is too large.");
  }
  const body = await readBody(req);
  if (body.byteLength > COGNITO_MAX_REQUEST_BYTES) {
    throw new AwsError("InvalidParameterException", "The request body is too large.");
  }
  if (!body.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new AwsError("SerializationException", "Could not parse request body into JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AwsError("SerializationException", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function sendCognitoJson(
  res: ServerResponse,
  value: Record<string, unknown> | void,
  status = 200,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/x-amz-json-1.1");
  res.end(JSON.stringify(value ?? {}));
}

export function sendCognitoError(res: ServerResponse, error: unknown): void {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalErrorException", error instanceof Error ? error.message : String(error), 500);
  res.statusCode = aws.status;
  res.setHeader("content-type", "application/x-amz-json-1.1");
  res.setHeader("x-amzn-errortype", aws.code);
  res.end(JSON.stringify({ __type: aws.code, message: aws.message, ...aws.details }));
}
