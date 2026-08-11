import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

export class SegmentedStore<T> {
  readonly directory: string;
  constructor(root: string, namespace: string, private readonly maxSegmentBytes = 4 * 1024 * 1024) { this.directory = resolve(root, "data", namespace); }
  private async segments(): Promise<string[]> { await mkdir(this.directory, { recursive: true }); return (await readdir(this.directory)).filter(name => /^segment-\d+\.jsonl$/.test(name)).sort(); }
  async append(value: T): Promise<void> {
    const segments = await this.segments(); let name = segments.at(-1) ?? "segment-000001.jsonl"; let path = resolve(this.directory, name);
    try { if ((await readFile(path)).length >= this.maxSegmentBytes) { name = `segment-${String(segments.length + 1).padStart(6, "0")}.jsonl`; path = resolve(this.directory, name); } } catch {}
    await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  async readAll(): Promise<T[]> {
    const output: T[] = [];
    for (const name of await this.segments()) for (const line of (await readFile(resolve(this.directory, name), "utf8")).split("\n")) if (line) output.push(JSON.parse(line));
    return output;
  }
  async readMatching(predicate: (serialized: string) => boolean): Promise<T[]> {
    const output: T[] = [];
    for (const name of await this.segments()) {
      const lines = createInterface({ input: createReadStream(resolve(this.directory, name), { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) if (line && predicate(line)) output.push(JSON.parse(line));
    }
    return output;
  }
  async *iterate(): AsyncGenerator<T> {
    for (const name of await this.segments()) {
      const lines = createInterface({ input: createReadStream(resolve(this.directory, name), { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) if (line) yield JSON.parse(line) as T;
    }
  }
  async compact(values: T[]): Promise<void> {
    await mkdir(this.directory, { recursive: true }); const target = resolve(this.directory, "segment-000001.jsonl"); const temporary = `${target}.tmp`;
    await writeFile(temporary, values.map(value => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""), { mode: 0o600 }); await rename(temporary, target);
    for (const name of await this.segments()) if (name !== "segment-000001.jsonl") await rm(resolve(this.directory, name), { force: true });
  }
  async clear(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}
