import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat, unlink } from "node:fs/promises";

const BODY = Symbol.for("stacksim.request-body");
const BODY_FILE = Symbol.for("stacksim.request-body-file");

export async function readBody(req: IncomingMessage, limit?: { bytes: number; exceeded: () => Error }): Promise<Buffer> {
  const cached = (req as any)[BODY] as Buffer | undefined;
  if (cached) {
    if (limit && cached.length > limit.bytes) throw limit.exceeded();
    return cached;
  }
  const staged = (req as any)[BODY_FILE] as { file: string } | undefined;
  if (staged) {
    if (limit && (await stat(staged.file)).size > limit.bytes) throw limit.exceeded();
    const body = await readFile(staged.file);
    await unlink(staged.file).catch(() => {});
    delete (req as any)[BODY_FILE];
    (req as any)[BODY] = body;
    return body;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of limit ? req.iterator({ destroyOnReturn: false }) : req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (limit && length > limit.bytes) {
      req.resume();
      throw limit.exceeded();
    }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks); (req as any)[BODY] = body; return body;
}

export async function readJson(req: IncomingMessage): Promise<any> {
  const body = await readBody(req);
  return body.length ? JSON.parse(body.toString("utf8")) : {};
}

export function json(res: ServerResponse, value: unknown, status = 200, contentType = "application/json"): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.end(JSON.stringify(value));
}

export function id(length = 10): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

export function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("base64");
}

export function decodePath(value: string): string {
  return value.split("/").map(decodeURIComponent).join("/");
}
