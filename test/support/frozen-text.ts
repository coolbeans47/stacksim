import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Return the repository representation of a frozen UTF-8 text artifact. */
export function canonicalTextBytes(content: Buffer): Buffer {
  return content.includes(13)
    ? Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"))
    : content;
}

export async function readCanonicalText(path: string): Promise<Buffer> {
  return canonicalTextBytes(await readFile(path));
}

export function canonicalTextSha256(content: Buffer): string {
  return createHash("sha256").update(canonicalTextBytes(content)).digest("hex");
}

