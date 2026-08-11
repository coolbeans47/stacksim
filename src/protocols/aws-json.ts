import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "../errors.js";
import { readBody } from "../util.js";

export async function parseAwsJson(req: IncomingMessage): Promise<any> {
  const body = await readBody(req);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new AwsError("SerializationException", "Could not parse request body into json."); }
}

export function sendAwsJson(res: ServerResponse, value: unknown, version: "1.0" | "1.1" = "1.0", status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", `application/x-amz-json-${version}`);
  res.end(JSON.stringify(value));
}

export function awsJsonError(code: string, message: string, namespace = "com.amazonaws#"): object {
  return { __type: `${namespace}${code}`, message };
}
