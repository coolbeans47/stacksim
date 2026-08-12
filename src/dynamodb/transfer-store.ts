import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Item } from "../types.js";

function safeId(value: string): string { return createHash("sha256").update(value).digest("hex"); }

async function writeChunk(stream: ReturnType<typeof createGzip>, chunk: Uint8Array): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

/** Private, mode-0600 transfer payloads. Control state stores only opaque IDs. */
export class DynamoTransferStore {
  private readonly root: string;

  constructor(root: string, accountId: string, region: string) {
    this.root = resolve(root, "data", "dynamodb", "transfers", accountId, region);
  }

  private snapshotPath(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid DynamoDB transfer snapshot ID");
    return resolve(this.root, `${id}.json.gz`);
  }

  async writeExportSnapshot(exportArn: string, items: Record<string, Item>): Promise<{ id: string; itemCount: number; billedSizeBytes: number; md5Base64: string }> {
    const id = safeId(exportArn);
    const target = this.snapshotPath(id);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    const output = createWriteStream(temporary, { flags: "w", mode: 0o600 });
    const gzip = createGzip({ level: 6 });
    gzip.pipe(output);
    let itemCount = 0;
    let billedSizeBytes = 2;
    try {
      for (const [key, item] of Object.entries(items).sort(([left], [right]) => left.localeCompare(right))) {
        const encodedKey = JSON.stringify(key);
        const encodedItem = JSON.stringify(item);
        billedSizeBytes += (itemCount ? 1 : 0) + Buffer.byteLength(encodedKey) + 1 + Buffer.byteLength(encodedItem);
        await writeChunk(gzip, Buffer.from(`${JSON.stringify({ Item: item })}\n`));
        itemCount++;
      }
      gzip.end();
      await finished(output);
      await rename(temporary, target);
    } catch (error) {
      gzip.destroy(); output.destroy(); await rm(temporary, { force: true }); throw error;
    }
    const digest = createHash("md5");
    for await (const chunk of createReadStream(target)) digest.update(chunk);
    const md5Base64 = digest.digest("base64");
    return { id, itemCount, billedSizeBytes, md5Base64 };
  }

  readExportSnapshot(id: string): AsyncIterable<Uint8Array> {
    return createReadStream(this.snapshotPath(id));
  }

  async deleteExportSnapshot(id: string | undefined): Promise<void> {
    if (id) await rm(this.snapshotPath(id), { force: true });
  }
}
