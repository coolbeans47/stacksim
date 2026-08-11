import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "../errors.js";
import { readBody } from "../util.js";

export async function parseRestJson(req: IncomingMessage): Promise<any> {
  const body = await readBody(req);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new AwsError("InvalidRequestContentException", "Could not parse request body into JSON", 400); }
}

export function sendRestJson(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}
